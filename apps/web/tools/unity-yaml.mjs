// Minimal, dependency-free parser for Unity's serialized YAML (scenes, prefabs, .anim, .controller,
// .mat, .asset, .meta). Unity writes a small, regular subset of YAML 1.1:
//   --- !u!<classId> &<fileID> [stripped]      document header
//   ClassName:                                 one top-level key per document
//     key: value | key: {flow} | key: [flow]   block mappings, 2-space indent
//     key:                                     followed by a deeper block, or by "- " items at the SAME indent
//     - item                                   sequences
// Scalars are kept as STRINGS (fileIDs are 64-bit and do not fit a JS number); use num()/vec() helpers.

import fs from 'node:fs';

const HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?/;

/** Parse a whole Unity YAML file into [{ classId, fileID, stripped, type, body }]. */
export function parseUnityYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const docs = [];
  let cur = null;
  let buf = [];
  const flush = () => {
    if (!cur) return;
    const root = parseLines(buf);
    const type = Object.keys(root)[0] ?? null;
    docs.push({ ...cur, type, body: type ? root[type] ?? {} : {} });
  };
  for (const line of lines) {
    if (line.startsWith('%') ) continue;
    const m = HEADER.exec(line);
    if (m) {
      flush();
      cur = { classId: Number(m[1]), fileID: m[2], stripped: !!m[3] };
      buf = [];
    } else if (line.startsWith('--- ')) {
      // plain document (e.g. .meta files have none; ProjectSettings sometimes)
      flush();
      cur = { classId: null, fileID: null, stripped: false };
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (!cur && buf.length) cur = { classId: null, fileID: null, stripped: false };
  flush();
  return docs;
}

/** Parse a plain YAML file that has no Unity document headers (e.g. .meta). */
export function parsePlainYaml(text) {
  return parseLines(text.replace(/\r\n?/g, '\n').split('\n'));
}

export function readUnityYaml(path) {
  return parseUnityYaml(fs.readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Block parser

function indentOf(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}

function parseLines(rawLines) {
  // Drop blank lines and comments; keep [indent, text].
  const L = [];
  for (const raw of rawLines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    L.push(raw);
  }
  const st = { L, i: 0 };
  if (!L.length) return {};
  return parseNode(st, indentOf(L[0]));
}

function isSeqLine(text, indent) {
  return indentOf(text) === indent && (text.slice(indent).startsWith('- ') || text.slice(indent) === '-');
}

function parseNode(st, indent) {
  const line = st.L[st.i];
  if (line === undefined) return null;
  if (isSeqLine(line, indent)) return parseSeq(st, indent);
  return parseMap(st, indent);
}

const KEY_RE = /^((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^']|'')*')|[^:{}\[\],#][^:]*?|):(?: (.*))?$/;

function parseMap(st, indent) {
  const out = {};
  while (st.i < st.L.length) {
    const line = st.L[st.i];
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) { st.i++; continue; } // stray continuation; ignore defensively
    if (isSeqLine(line, indent)) break;
    const text = line.slice(indent);
    const m = KEY_RE.exec(text);
    if (!m) { st.i++; continue; }
    const key = unquote(m[1]);
    const rest = m[2] ?? '';
    st.i++;
    if (rest.trim() === '' ) {
      const next = st.L[st.i];
      if (next !== undefined && indentOf(next) > indent) out[key] = parseNode(st, indentOf(next));
      else if (next !== undefined && isSeqLine(next, indent)) out[key] = parseSeq(st, indent);
      else out[key] = '';
    } else {
      out[key] = parseInlineValue(st, rest, indent);
    }
  }
  return out;
}

function parseSeq(st, indent) {
  const out = [];
  while (st.i < st.L.length) {
    const line = st.L[st.i];
    if (!isSeqLine(line, indent)) break;
    const rest = line.slice(indent + 1).replace(/^ /, '');
    if (rest.trim() === '') {
      st.i++;
      const next = st.L[st.i];
      if (next !== undefined && indentOf(next) > indent) out.push(parseNode(st, indentOf(next)));
      else out.push(null);
      continue;
    }
    const startsFlow = rest[0] === '{' || rest[0] === '[' || rest[0] === '"' || rest[0] === "'";
    if (!startsFlow && KEY_RE.test(rest)) {
      // "- key: value" -> mapping whose keys sit at indent+2. Rewrite the line in place and parse.
      st.L[st.i] = ' '.repeat(indent + 2) + rest;
      out.push(parseMap(st, indent + 2));
    } else {
      st.i++;
      out.push(parseInlineValue(st, rest, indent));
    }
  }
  return out;
}

/** A value that starts on the key's line; may continue onto deeper-indented lines. */
function parseInlineValue(st, rest, indent) {
  let text = rest;
  const first = text.trimStart()[0];
  if (first === '{' || first === '[') {
    while (!flowBalanced(text) && st.i < st.L.length) text += ' ' + st.L[st.i++].trim();
    return parseFlow(text.trim());
  }
  if (first === '"' || first === "'") {
    while (!quoteClosed(text.trim()) && st.i < st.L.length) {
      const nxt = st.L[st.i++];
      text = text.endsWith('\\') ? text.slice(0, -1) + nxt.trim() : text + ' ' + nxt.trim();
    }
    return unquote(text.trim());
  }
  // plain multi-line scalar: deeper lines fold into it
  while (st.i < st.L.length && indentOf(st.L[st.i]) > indent && !isSeqLine(st.L[st.i], indent)) {
    text += ' ' + st.L[st.i++].trim();
  }
  return text.trim();
}

function quoteClosed(s) {
  const q = s[0];
  if (s.length < 2) return false;
  if (q === "'") {
    // '' is an escaped quote
    let i = 1;
    while (i < s.length) {
      if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } return i === s.length - 1; }
      i++;
    }
    return false;
  }
  let i = 1;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '"') return i === s.length - 1;
    i++;
  }
  return false;
}

function flowBalanced(s) {
  let depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth <= 0;
}

export function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
      if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' }[e] ?? e;
    });
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

// ---------------------------------------------------------------------------------------------
// Flow parser: {a: 1, b: {c: d}}, [x, y]

function parseFlow(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function value() {
    ws();
    if (s[i] === '{') {
      i++;
      const o = {};
      ws();
      if (s[i] === '}') { i++; return o; }
      while (i < s.length) {
        ws();
        const k = scalar(':');
        i++; // ':'
        o[unquote(k)] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; break; }
      }
      return o;
    }
    if (s[i] === '[') {
      i++;
      const a = [];
      ws();
      if (s[i] === ']') { i++; return a; }
      while (i < s.length) {
        a.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; break; }
      }
      return a;
    }
    return unquote(scalar(',}]'));
  }
  function scalar(stops) {
    ws();
    const start = i;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      while (i < s.length && s[i] !== q) { if (q === '"' && s[i] === '\\') i++; i++; }
      i++;
      return s.slice(start, i);
    }
    while (i < s.length && !stops.includes(s[i])) {
      // a ':' only ends a key when followed by space
      if (stops === ':' && s[i] === ':' && (s[i + 1] === ' ' || s[i + 1] === undefined)) break;
      i++;
    }
    return s.slice(start, i).trim();
  }
  return value();
}

// ---------------------------------------------------------------------------------------------
// Helpers

export const num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v));
export const vec3 = (v) => (v ? [num(v.x), num(v.y), num(v.z)] : null);
export const quat = (v) => (v ? [num(v.x), num(v.y), num(v.z), num(v.w, 1)] : null);
export const col = (v) => (v ? [num(v.r), num(v.g), num(v.b), num(v.a, 1)] : null);
export const ref = (v) => (v && v.fileID !== undefined ? { fileID: String(v.fileID), guid: v.guid, type: v.type } : null);
