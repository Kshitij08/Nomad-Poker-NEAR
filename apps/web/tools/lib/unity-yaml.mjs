// Dependency-free reader for Unity's serialized YAML (scenes, prefabs, assets, .meta files).
//
// Unity writes a narrow YAML subset: block maps with 2-space indents, block sequences whose "- " sits
// at the parent key's indent, flow maps/arrays ({fileID: 1, guid: x}, []), plain / single / double
// quoted scalars that may wrap over several lines. Every scalar is kept as a STRING — fileIDs are
// signed 64-bit and guids can look like exponent floats, so numeric conversion is left to callers.
//
// Also resolves prefab instances (nested prefabs, variants, modifications, added / removed objects)
// into one flat object graph, using Unity's id rule: an object F inside instance X has scene id
// (X ^ F) & 0x7fffffffffffffff.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- scalar / flow parsing

function unescapeDouble(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case ' ': return ' ';
      case 'x': case 'u': case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: return e;
    }
  });
}

// Folds the raw lines of a multi-line quoted scalar the YAML way: a single break -> space,
// an empty line -> "\n", leading whitespace on continuation lines dropped.
function foldLines(rawLines, isDouble) {
  let out = '';
  for (let i = 0; i < rawLines.length; i++) {
    let line = i === 0 ? rawLines[i] : rawLines[i].replace(/^\s+/, '');
    if (i < rawLines.length - 1) line = line.replace(/[ \t]+$/, '');
    if (i === 0) { out = line; continue; }
    if (line === '' && i < rawLines.length - 1) { out += '\n'; continue; }
    if (isDouble && /(^|[^\\])(\\\\)*\\$/.test(out)) { out = out.slice(0, -1) + line; continue; }
    if (out.endsWith('\n')) out += line; else out += ' ' + line;
  }
  return out;
}

class FlowParser {
  constructor(s) { this.s = s; this.i = 0; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.map();
    if (c === '[') return this.arr();
    if (c === '"') return this.dq();
    if (c === "'") return this.sq();
    return this.plain();
  }
  map() {
    this.i++; const o = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return o; }
      let key;
      if (this.s[this.i] === '"') key = this.dq(); else if (this.s[this.i] === "'") key = this.sq();
      else { const st = this.i; while (this.i < this.s.length && this.s[this.i] !== ':') this.i++; key = this.s.slice(st, this.i).trim(); }
      this.ws(); if (this.s[this.i] === ':') this.i++;
      o[key] = this.value();
      this.ws(); if (this.s[this.i] === ',') this.i++;
      if (this.i >= this.s.length) return o;
    }
  }
  arr() {
    this.i++; const a = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return a; }
      a.push(this.value());
      this.ws(); if (this.s[this.i] === ',') this.i++;
      if (this.i >= this.s.length) return a;
    }
  }
  dq() {
    this.i++; let st = this.i;
    while (this.i < this.s.length && this.s[this.i] !== '"') { if (this.s[this.i] === '\\') this.i++; this.i++; }
    const r = unescapeDouble(this.s.slice(st, this.i)); this.i++; return r;
  }
  sq() {
    this.i++; let r = '';
    while (this.i < this.s.length) {
      if (this.s[this.i] === "'") { if (this.s[this.i + 1] === "'") { r += "'"; this.i += 2; continue; } this.i++; break; }
      r += this.s[this.i++];
    }
    return r;
  }
  plain() {
    const st = this.i;
    while (this.i < this.s.length && !/[,}\]]/.test(this.s[this.i])) this.i++;
    return this.s.slice(st, this.i).trim();
  }
}

// ---------------------------------------------------------------- block parsing

function toLines(text) {
  return text.split(/\r?\n/).map((raw) => {
    const m = /^( *)(.*)$/.exec(raw);
    return { indent: m[1].length, text: m[2] };
  });
}

function isBlank(l) { return l.text === '' || l.text.startsWith('#'); }

// Splits "key: rest" (key may be quoted). Returns null when the line is not a mapping entry.
function splitKey(text) {
  if (text.startsWith('- ') || text === '-') return null;
  let key, rest;
  if (text[0] === '"' || text[0] === "'") {
    const fp = new FlowParser(text); key = text[0] === '"' ? fp.dq() : fp.sq();
    const after = text.slice(fp.i);
    const m = /^\s*:(?:\s+(.*)|$)/.exec(after); if (!m) return null; rest = (m[1] || '').trim();
    return { key, rest };
  }
  const m = /^([^:{}[\]"'][^:]*?|[^:]*?):(?:\s(.*)|$)/.exec(text);
  if (!m) return null;
  key = m[1].trim(); rest = (m[2] || '').trim();
  return { key, rest };
}

class BlockParser {
  constructor(lines) { this.L = lines; this.i = 0; }
  skip() { while (this.i < this.L.length && isBlank(this.L[this.i])) this.i++; }

  // Parses the block that starts at the current line with exactly `indent`.
  block(indent) {
    this.skip();
    if (this.i >= this.L.length) return null;
    const l = this.L[this.i];
    if (l.indent < indent) return null;
    if (l.text.startsWith('- ') || l.text === '-') return this.seq(l.indent);
    return this.map(l.indent);
  }

  seq(indent) {
    const a = [];
    for (;;) {
      this.skip();
      if (this.i >= this.L.length) break;
      const l = this.L[this.i];
      if (l.indent !== indent || !(l.text.startsWith('- ') || l.text === '-')) break;
      const content = l.text === '-' ? '' : l.text.slice(2);
      if (content === '') { this.i++; a.push(this.block(indent + 1)); continue; }
      // Re-read the item content as if it were on its own line, 2 columns in.
      this.L[this.i] = { indent: indent + 2, text: content };
      if (splitKey(content) && !content.startsWith('{') && !content.startsWith('[')) a.push(this.map(indent + 2));
      else a.push(this.scalarAt(indent + 2, content, indent));
    }
    return a;
  }

  map(indent) {
    const o = {};
    for (;;) {
      this.skip();
      if (this.i >= this.L.length) break;
      const l = this.L[this.i];
      if (l.indent !== indent || l.text.startsWith('- ')) break;
      const kv = splitKey(l.text);
      if (!kv) { this.i++; continue; }
      if (kv.rest === '' || kv.rest === '|' || kv.rest === '>') {
        this.i++;
        this.skip();
        const n = this.L[this.i];
        if (n && (n.indent > indent || (n.indent === indent && (n.text.startsWith('- ') || n.text === '-')))) o[kv.key] = this.block(n.indent);
        else o[kv.key] = kv.rest === '' ? '' : '';
      } else {
        o[kv.key] = this.scalarAt(indent, kv.rest, indent);
      }
    }
    return o;
  }

  // Value text `first` begins on the current line; continuation lines must be indented > ownerIndent.
  scalarAt(_lineIndent, first, ownerIndent) {
    this.i++;
    const c = first[0];
    if (c === '{' || c === '[') {
      let s = first;
      // Flow collections can wrap; keep appending until brackets balance.
      while (!balanced(s) && this.i < this.L.length) { s += ' ' + this.L[this.i].text; this.i++; }
      return new FlowParser(s).value();
    }
    if (c === '"' || c === "'") {
      const raw = [first.slice(1)];
      const closes = (t) => c === '"' ? /(^|[^\\])(\\\\)*"\s*$/.test(t) : /(^|[^'])('')*'\s*$/.test(t);
      let done = closes(raw[0]) && raw[0].length > 0 ? true : (first.length > 1 && closes(first.slice(1)));
      if (first.length === 1) done = false;
      while (!done && this.i < this.L.length) {
        const t = ' '.repeat(this.L[this.i].indent) + this.L[this.i].text;
        raw.push(t); this.i++;
        done = closes(t);
      }
      raw[raw.length - 1] = raw[raw.length - 1].replace(new RegExp((c === '"' ? '"' : "'") + '\\s*$'), '');
      const folded = foldLines(raw, c === '"');
      return c === '"' ? unescapeDouble(folded) : folded.replace(/''/g, "'");
    }
    // Plain scalar, possibly continued on more-indented lines.
    const parts = [first];
    while (this.i < this.L.length) {
      const n = this.L[this.i];
      if (n.text === '') { // a blank line inside a plain scalar is a newline, if more continuation follows
        let j = this.i; while (j < this.L.length && this.L[j].text === '') j++;
        if (j < this.L.length && this.L[j].indent > ownerIndent) { parts.push(''); this.i = j; continue; }
        break;
      }
      if (n.indent <= ownerIndent) break;
      parts.push(n.text); this.i++;
    }
    return foldLines(parts, false);
  }
}

function balanced(s) {
  let d = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\' && q === '"') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
  }
  return d <= 0;
}

export function parseYamlBlock(text) {
  const p = new BlockParser(toLines(text));
  return p.block(0);
}

// ---------------------------------------------------------------- documents

export const MASK63 = 0x7fffffffffffffffn;
export function normId(id) {
  if (id === undefined || id === null || id === '') return '0';
  return BigInt.asUintN(64, BigInt(String(id).trim())).toString();
}
export function xorId(a, b) {
  return ((BigInt(normId(a)) ^ BigInt(normId(b))) & MASK63).toString();
}

/** Parses a Unity YAML file into [{classId, fileId, stripped, type, data}] */
export function parseUnityFile(file, { skipClasses = [] } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const docs = [];
  const re = /^--- !u!(\d+) &(-?\d+)( stripped)?[^\n]*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ classId: +m[1], fileId: normId(m[2]), stripped: !!m[3], start: m.index, bodyStart: m.index + m[0].length });
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    if (skipClasses.includes(h.classId)) continue;
    const body = text.slice(h.bodyStart, k + 1 < heads.length ? heads[k + 1].start : text.length);
    let parsed;
    try { parsed = parseYamlBlock(body) || {}; } catch (e) { parsed = {}; console.warn('parse fail', file, h.fileId, e.message); }
    const type = Object.keys(parsed)[0];
    docs.push({ classId: h.classId, fileId: h.fileId, stripped: h.stripped, type, data: parsed[type] || {} });
  }
  return docs;
}

// ---------------------------------------------------------------- guid index

export function buildGuidIndex(assetsRoot, extraRoots = []) {
  const map = new Map();
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.meta')) {
        const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(512); const n = fs.readSync(fd, buf, 0, 512, 0); fs.closeSync(fd);
        const g = /guid:\s*([0-9a-f]{32})/.exec(buf.toString('utf8', 0, n));
        if (g) map.set(g[1], p.slice(0, -5));
      }
    }
  };
  walk(assetsRoot);
  for (const r of extraRoots) walk(r);
  return map;
}

// ---------------------------------------------------------------- object graph with prefab resolution

function deepClone(v) { return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)); }

function isRef(v) { return v && typeof v === 'object' && !Array.isArray(v) && 'fileID' in v; }

// Rewrites every local {fileID: n} (no guid) inside `v` through fn.
function remapRefs(v, fn) {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = remapRefs(v[i], fn); return v; }
  if (v && typeof v === 'object') {
    if (isRef(v) && (!v.guid || v.guid === '')) { const n = normId(v.fileID); if (n !== '0') v.fileID = fn(n); return v; }
    for (const k of Object.keys(v)) v[k] = remapRefs(v[k], fn);
  }
  return v;
}

function setPath(obj, propertyPath, value, objRef) {
  const parts = propertyPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    const last = i === parts.length - 1;
    if (p === 'Array') {
      const nxt = parts[i + 1];
      if (!Array.isArray(cur)) return;
      if (nxt === 'size') { const n = +value; cur.length = n; for (let k = 0; k < n; k++) if (cur[k] === undefined) cur[k] = {}; return; }
      const dm = /^data\[(\d+)\]$/.exec(nxt);
      if (!dm) return;
      const idx = +dm[1];
      if (i + 1 === parts.length - 1) { cur[idx] = pick(cur[idx], value, objRef); return; }
      if (cur[idx] === undefined || cur[idx] === null || typeof cur[idx] !== 'object') cur[idx] = {};
      cur = cur[idx]; i++; continue;
    }
    if (last) { cur[p] = pick(cur[p], value, objRef); return; }
    const nextIsArray = parts[i + 1] === 'Array';
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object' || cur[p] === '') cur[p] = nextIsArray ? [] : {};
    cur = cur[p];
  }
}
function pick(existing, value, objRef) {
  const refSet = objRef && normId(objRef.fileID) !== '0';
  if (refSet) return objRef;
  if (isRef(existing)) return objRef || { fileID: '0' };
  return value;
}

export class UnityProject {
  constructor(projectRoot) {
    this.root = projectRoot;
    this.assets = path.join(projectRoot, 'Assets');
    this.guids = buildGuidIndex(this.assets, [path.join(projectRoot, 'Packages'), path.join(projectRoot, 'Library', 'PackageCache')]);
    this.fileCache = new Map();
    this.resolvedCache = new Map();
  }
  pathOf(guid) { return this.guids.get(guid) || null; }
  rel(p) { return p ? path.relative(this.root, p).split(path.sep).join('/') : null; }

  docs(file) {
    if (!this.fileCache.has(file)) this.fileCache.set(file, parseUnityFile(file));
    return this.fileCache.get(file);
  }

  /**
   * Returns Map<id, obj> for a scene/prefab with every prefab instance expanded.
   * obj = {id, classId, type, data, source: {file, fileId} }
   */
  resolve(file, depth = 0) {
    if (this.resolvedCache.has(file)) return this.resolvedCache.get(file);
    if (depth > 12) throw new Error('prefab nesting too deep at ' + file);
    const docs = this.docs(file);
    const objs = new Map();
    const strippedAlias = new Map();
    const instances = [];
    for (const d of docs) {
      if (d.classId === 1001) { instances.push(d); continue; }
      if (d.stripped) { strippedAlias.set(d.fileId, d); continue; }
      objs.set(d.fileId, { id: d.fileId, classId: d.classId, type: d.type, data: d.data, source: { file: this.rel(file), fileId: d.fileId } });
    }
    const addedOrder = []; // [{parentId, childTransformId, insertIndex}]
    for (const inst of instances) {
      const X = inst.fileId;
      const srcGuid = inst.data.m_SourcePrefab?.guid;
      const srcPath = srcGuid && this.pathOf(srcGuid);
      if (!srcPath || !fs.existsSync(srcPath)) { console.warn('missing prefab source', srcGuid, 'in', this.rel(file)); continue; }
      const R = this.resolve(srcPath, depth + 1);
      const mod = inst.data.m_Modification || {};
      const removedComps = new Set((inst.data.m_RemovedComponents || mod.m_RemovedComponents || []).map((r) => normId(r.fileID)));
      const removedGOs = new Set((inst.data.m_RemovedGameObjects || mod.m_RemovedGameObjects || []).map((r) => normId(r.fileID)));
      const local = new Map();
      for (const [id, o] of R) {
        if (removedComps.has(id) || removedGOs.has(id)) continue;
        const nid = xorId(X, id);
        const data = remapRefs(deepClone(o.data), (n) => (R.has(n) ? xorId(X, n) : n));
        local.set(id, { id: nid, classId: o.classId, type: o.type, data, source: o.source, prefabInstance: X, prefab: this.rel(srcPath) });
      }
      // Removed game objects take their whole subtree's components with them.
      if (removedGOs.size) for (const [id, o] of [...local]) if (removedGOs.has(normId(R.get(id)?.data?.m_GameObject?.fileID))) local.delete(id);
      for (const m of mod.m_Modifications || []) {
        const t = normId(m.target?.fileID);
        const o = local.get(t);
        if (!o) continue;
        setPath(o.data, m.propertyPath, m.value ?? '', m.objectReference);
      }
      // Root transform: the source object whose m_Father is 0.
      const parentRef = normId(mod.m_TransformParent?.fileID);
      for (const [, o] of local) {
        if ((o.classId === 4 || o.classId === 224) && normId(o.data.m_Father?.fileID) === '0' && !o._root) {
          o.data.m_Father = { fileID: parentRef };
          o.prefabRoot = true;
        }
      }
      for (const [, o] of local) objs.set(o.id, o);
      for (const a of inst.data.m_AddedGameObjects || []) {
        addedOrder.push({ target: xorId(X, a.targetCorrespondingSourceObject?.fileID), insertIndex: +(a.insertIndex ?? -1), added: normId(a.addedObject?.fileID) });
      }
    }
    // Stripped docs should coincide with computed ids; alias otherwise.
    const alias = new Map();
    for (const [sid, d] of strippedAlias) {
      const want = xorId(d.data.m_PrefabInstance?.fileID, d.data.m_CorrespondingSourceObject?.fileID);
      if (want !== sid) alias.set(sid, want);
    }
    if (alias.size) for (const [, o] of objs) remapRefs(o.data, (n) => alias.get(n) || n);
    // Children of stripped transforms (added objects) are attached by m_Father; record insert order hints.
    for (const a of addedOrder) {
      const parent = objs.get(a.target);
      const child = objs.get(a.added);
      if (!parent || !child) continue;
      parent._added = parent._added || [];
      parent._added.push({ id: a.added, insertIndex: a.insertIndex });
    }
    this.resolvedCache.set(file, objs);
    return objs;
  }
}

/** Builds GameObject nodes: {go, transform, components[], children[], parent} */
export function buildHierarchy(objs) {
  const gos = new Map();
  for (const [id, o] of objs) if (o.classId === 1) gos.set(id, { id, go: o, transform: null, components: [], children: [], parent: null });
  for (const [id, o] of objs) {
    if (o.classId === 1) continue;
    const gid = normId(o.data?.m_GameObject?.fileID);
    const g = gos.get(gid);
    if (!g) continue;
    if (o.classId === 4 || o.classId === 224) g.transform = o;
    g.components.push(o);
  }
  // order components by the GO's m_Component list when present
  for (const [, g] of gos) {
    const order = (g.go.data.m_Component || []).map((c) => normId(c.component?.fileID));
    g.components.sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
  }
  const tToG = new Map();
  for (const [, g] of gos) if (g.transform) tToG.set(g.transform.id, g);
  for (const [, g] of gos) {
    if (!g.transform) continue;
    const fid = normId(g.transform.data.m_Father?.fileID);
    const pg = tToG.get(fid);
    if (pg) g.parent = pg;
  }
  // children order: parent's m_Children list, then added-object hints, then leftovers.
  for (const [, g] of gos) {
    if (!g.transform) continue;
    const listed = (g.transform.data.m_Children || []).map((c) => normId(c.fileID));
    const kids = [...tToG.values()].filter((c) => c.parent === g);
    const byT = new Map(kids.map((k) => [k.transform.id, k]));
    const ordered = [];
    for (const t of listed) if (byT.has(t)) { ordered.push(byT.get(t)); byT.delete(t); }
    const rest = [...byT.values()];
    for (const a of g.transform._added || []) {
      const k = rest.find((r) => r.transform.id === a.id || r.id === a.id);
      if (!k) continue;
      rest.splice(rest.indexOf(k), 1);
      if (a.insertIndex >= 0 && a.insertIndex <= ordered.length) ordered.splice(a.insertIndex, 0, k); else ordered.push(k);
    }
    // m_RootOrder (older serialization) for leftovers
    rest.sort((a, b) => (+(a.transform.data.m_RootOrder ?? 0)) - (+(b.transform.data.m_RootOrder ?? 0)));
    g.children = ordered.concat(rest);
  }
  return { gos, tToG };
}

export function readMeta(assetPath) {
  const p = assetPath + '.meta';
  if (!fs.existsSync(p)) return null;
  return parseYamlBlock(fs.readFileSync(p, 'utf8'));
}

export function imageSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1]; const len = b.readUInt16BE(i + 2);
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
    if (b.toString('ascii', 0, 4) === '8BPS') return { w: b.readUInt32BE(18), h: b.readUInt32BE(14) };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    }
    if (b[0] === 0 && b[2] === 2) return { w: b.readUInt16LE(12), h: b.readUInt16LE(14) }; // TGA
  } catch {}
  return null;
}
