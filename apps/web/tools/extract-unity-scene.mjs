#!/usr/bin/env node
// Extracts the live poker table's 3D scene data from the Unity project into JSON for the web port.
//
//   node web/tools/extract-unity-scene.mjs            # writes web/src/data/unity-scene.json + slot-anims.json
//   node web/tools/extract-unity-scene.mjs --copy     # ...and copies the 3D art into web/public/assets/3d/
//
// Dependency-free (Node >= 20). Reads only; never writes under Assets/ or ProjectSettings/.
// ALL coordinates stay in Unity's native LEFT-HANDED world space (X right, Y up, Z forward).
// Quaternions are [x, y, z, w]; matrices are 4x4 column-major (m[col*4+row]), Unity's TRS convention.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUnityYaml, parsePlainYaml, num, vec3, quat, col } from './unity-yaml.mjs';
import { summarizeFbx } from './fbx-binary.mjs';
import { optimizeAssets } from './optimize-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const SCENE = 'Assets/Test/Test.unity';
const OUT_SCENE = path.join(WEB, 'src/data/unity-scene.json');
const OUT_ANIMS = path.join(WEB, 'src/data/slot-anims.json');
const ASSET_DIR = path.join(WEB, 'public/assets/3d');
const SLOT_ANIM_DIR = 'Assets/Test/Animations/Center 5 cards';

const abs = (rel) => path.join(ROOT, rel);
const warnings = [];
const warn = (m) => { warnings.push(m); };

// =============================================================================================
// GUID index (Assets/**/*.meta) and built-in asset ids

let guidIndex = null;
function buildGuidIndex() {
  guidIndex = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.meta')) {
        const head = fs.readFileSync(p, 'utf8').slice(0, 200);
        const m = /guid: ([0-9a-f]{32})/.exec(head);
        if (m) guidIndex.set(m[1], path.relative(ROOT, p.slice(0, -5)).split(path.sep).join('/'));
      }
    }
  };
  walk(abs('Assets'));
  const pc = abs('Library/PackageCache');
  if (fs.existsSync(pc)) for (const pkg of fs.readdirSync(pc)) { try { walk(path.join(pc, pkg)); } catch { /* ignore */ } }
}
const BUILTIN_EXTRA = '0000000000000000e000000000000000';
const BUILTIN_DEFAULT = '0000000000000000f000000000000000';
const BUILTIN_MESHES = { 10202: 'Cube', 10206: 'Cylinder', 10207: 'Sphere', 10208: 'Capsule', 10209: 'Plane', 10210: 'Quad' };
const BUILTIN_SHADERS = { 46: 'Standard', 45: 'Standard (Specular setup)', 10750: 'Unlit/Texture', 10752: 'Unlit/Color', 10753: 'Unlit/Transparent', 10755: 'Unlit/Transparent Cutout', 10720: 'Mobile/Diffuse', 7: 'Legacy Shaders/Diffuse', 10800: 'Sprites/Default', 10770: 'UI/Default', 10701: 'Particles/Standard Unlit' };
export function assetPath(r) {
  if (!r || !r.guid) return null;
  if (r.guid === BUILTIN_EXTRA) return `builtin_extra:${BUILTIN_MESHES[r.fileID] ?? r.fileID}`;
  if (r.guid === BUILTIN_DEFAULT) return `builtin_default:${BUILTIN_SHADERS[r.fileID] ?? r.fileID}`;
  if (!guidIndex) buildGuidIndex();
  return guidIndex.get(r.guid) ?? `missing-guid:${r.guid}`;
}
const isNullRef = (r) => !r || r.fileID === undefined || String(r.fileID) === '0';

// =============================================================================================
// Asset / prefab loading with full prefab-instance flattening.
//
// A prefab instance's objects get the ids Unity itself uses inside prefab assets:
//   id = (prefabInstanceFileID XOR sourceObjectFileID) & 0x7FFFFFFFFFFFFFFF
// Stripped docs (scene-side handles to instance objects) are aliased onto those ids.

const MASK = 0x7fffffffffffffffn;
const u64 = (s) => BigInt.asUintN(64, BigInt(s));
const instId = (pi, src) => ((u64(pi) ^ u64(src)) & MASK).toString();

const docCache = new Map();
function loadDocs(rel) {
  if (!docCache.has(rel)) docCache.set(rel, readUnityYaml(abs(rel)));
  return docCache.get(rel);
}

function mapRefs(v, fn) {
  if (Array.isArray(v)) return v.map((x) => mapRefs(x, fn));
  if (v && typeof v === 'object') {
    if (v.fileID !== undefined && Object.keys(v).every((k) => k === 'fileID' || k === 'guid' || k === 'type')) return fn(v);
    const o = {};
    for (const k of Object.keys(v)) o[k] = mapRefs(v[k], fn);
    return o;
  }
  return v;
}

function setProp(body, propPath, value, objRef) {
  const toks = propPath.split('.');
  let cur = body;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const last = i === toks.length - 1;
    if (t === 'Array') continue;
    const dm = /^data\[(\d+)\]$/.exec(t);
    if (t === 'size' && toks[i - 1] === 'Array') {
      if (Array.isArray(cur)) { const n = Number(value); while (cur.length < n) cur.push(null); cur.length = n; }
      return;
    }
    const key = dm ? Number(dm[1]) : t;
    if (last) {
      const existing = cur[key];
      const isRef = !isNullRef(objRef) || (existing && typeof existing === 'object' && existing.fileID !== undefined);
      cur[key] = isRef ? { ...(objRef ?? { fileID: '0' }) } : value;
      return;
    }
    if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== 'object') {
      cur[key] = /^data\[/.test(toks[i + 2] ?? '') || toks[i + 1] === 'Array' ? [] : {};
    }
    cur = cur[key];
  }
}

/**
 * Flatten a scene or prefab file: every object (including those of nested prefab instances, with their
 * modifications applied) keyed by id. Returns { objects: Map<id, obj>, alias: Map<strippedId, id> }.
 */
const flatCache = new Map();
function flattenFile(rel) {
  if (flatCache.has(rel)) return flatCache.get(rel);
  const docs = loadDocs(rel);
  const objects = new Map();
  const alias = new Map();
  const instances = [];
  for (const d of docs) {
    if (d.type === 'PrefabInstance') { instances.push(d); continue; }
    if (d.stripped) {
      alias.set(d.fileID, instId(d.body.m_PrefabInstance.fileID, d.body.m_CorrespondingSourceObject.fileID));
      continue;
    }
    objects.set(d.fileID, { id: d.fileID, classId: d.classId, type: d.type, body: d.body, file: rel });
  }
  for (const p of instances) {
    const mod = p.body.m_Modification ?? {};
    const srcRel = assetPath(p.body.m_SourcePrefab);
    if (!srcRel || srcRel.startsWith('missing') || !fs.existsSync(abs(srcRel))) { warn(`prefab ${p.fileID} source missing: ${JSON.stringify(p.body.m_SourcePrefab)}`); continue; }
    if (!/\.prefab$/i.test(srcRel)) {
      // model prefab (FBX dragged into the scene) — record it, do not flatten
      objects.set(p.fileID, { id: p.fileID, classId: 1001, type: 'ModelPrefabInstance', body: p.body, file: rel, source: srcRel });
      continue;
    }
    const src = flattenFile(srcRel);
    const added = new Map();
    for (const [sid, o] of src.objects) {
      const nid = instId(p.fileID, sid);
      const body = mapRefs(structuredClone(o.body), (r) => (r.guid === undefined && src.objects.has(String(r.fileID)) ? { fileID: instId(p.fileID, r.fileID) } : r));
      added.set(nid, { id: nid, classId: o.classId, type: o.type, body, file: o.file, prefabInstance: p.fileID, prefabSource: srcRel, sourceId: sid });
    }
    // removals
    const removed = new Set();
    for (const r of mod.m_RemovedGameObjects ?? []) if (r) removed.add(instId(p.fileID, r.fileID));
    for (const r of mod.m_RemovedComponents ?? []) if (r) removed.add(instId(p.fileID, r.fileID));
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, o] of added) {
        if (removed.has(id)) continue;
        const go = o.body.m_GameObject?.fileID, fa = o.body.m_Father?.fileID;
        if ((go && removed.has(String(go))) || (fa && removed.has(String(fa)))) { removed.add(id); changed = true; }
        if ((o.type === 'Transform' || o.type === 'RectTransform') && removed.has(id) && go && !removed.has(String(go))) { removed.add(String(go)); changed = true; }
      }
    }
    for (const id of removed) added.delete(id);
    // reparent the instance root
    for (const o of added.values()) {
      if ((o.type === 'Transform' || o.type === 'RectTransform') && String(o.body.m_Father?.fileID) === '0') {
        o.body.m_Father = { fileID: String(mod.m_TransformParent?.fileID ?? '0') };
        o.isInstanceRoot = true;
      }
    }
    // modifications
    let misses = 0;
    for (const m of mod.m_Modifications ?? []) {
      if (!m?.target) continue;
      const tid = instId(p.fileID, m.target.fileID);
      const o = added.get(tid);
      if (!o) { misses++; continue; }
      setProp(o.body, m.propertyPath, m.value, m.objectReference);
    }
    if (misses) warn(`${rel}: prefab instance ${p.fileID} (${srcRel}): ${misses} modification target(s) not in the source prefab (stale overrides Unity keeps for deleted objects; harmless)`);
    for (const [id, o] of added) objects.set(id, o);
  }
  // resolve stripped aliases everywhere (local refs only)
  if (alias.size) {
    for (const o of objects.values()) {
      if (o.file !== rel && !o.prefabInstance) continue;
      o.body = mapRefs(o.body, (r) => (r.guid === undefined && alias.has(String(r.fileID)) ? { fileID: alias.get(String(r.fileID)) } : r));
    }
  }
  const res = { objects, alias };
  flatCache.set(rel, res);
  return res;
}

// =============================================================================================
// Math (Unity conventions)

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};
const Q = {
  mul: (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ],
  rotate: (q, v) => {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  },
  norm: (q) => { const l = Math.hypot(...q) || 1; return q.map((c) => c / l); },
  axisAngle: (axis, deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; },
  /** Unity Quaternion.Euler: Z, then X, then Y (q = qy * qx * qz). */
  euler: (e) => Q.mul(Q.mul(Q.axisAngle([0, 1, 0], e[1]), Q.axisAngle([1, 0, 0], e[0])), Q.axisAngle([0, 0, 1], e[2])),
  toEuler: (q) => {
    const m = mat3(q);
    const sx = Math.max(-1, Math.min(1, -m[1][2]));
    const x = Math.asin(sx);
    let y, z;
    if (Math.abs(sx) < 0.99999) { y = Math.atan2(m[0][2], m[2][2]); z = Math.atan2(m[1][0], m[1][1]); }
    else { y = Math.atan2(-m[2][0], m[0][0]); z = 0; }
    const d = (r) => { let v = (r * 180) / Math.PI; v = +((((v % 360) + 360) % 360).toFixed(5)); return v >= 360 ? 0 : v; };
    return [d(x), d(y), d(z)];
  },
  /** Unity Quaternion.LookRotation(forward, up). */
  lookRotation: (f, u) => {
    f = V.norm(f);
    const r = V.norm(V.cross(u, f));
    const up = V.cross(f, r);
    return fromBasis(r, up, f);
  },
};
function mat3(q) {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}
function fromBasis(r, u, f) {
  const m00 = r[0], m01 = u[0], m02 = f[0], m10 = r[1], m11 = u[1], m12 = f[1], m20 = r[2], m21 = u[2], m22 = f[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  return Q.norm(q);
}
const M = {
  trs: (t, q, s) => {
    const r = mat3(q);
    return [
      r[0][0] * s[0], r[1][0] * s[0], r[2][0] * s[0], 0,
      r[0][1] * s[1], r[1][1] * s[1], r[2][1] * s[1], 0,
      r[0][2] * s[2], r[1][2] * s[2], r[2][2] * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  },
  mul: (a, b) => {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  },
  point: (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]],
  vector: (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]],
};
const r6 = (x) => (typeof x === 'number' ? +x.toFixed(6) : Array.isArray(x) ? x.map(r6) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r6(v)])) : x);

// =============================================================================================
// Scene graph over a flattened file

class Graph {
  constructor(rel) {
    this.rel = rel;
    const { objects } = flattenFile(rel);
    this.objects = objects;
    this.compsOf = new Map(); // goId -> [obj]
    this.transformOf = new Map(); // goId -> transform obj
    this.children = new Map(); // transformId -> [transform obj]
    for (const o of objects.values()) {
      const go = o.body?.m_GameObject?.fileID;
      if (go !== undefined && o.type !== 'GameObject') {
        const g = String(go);
        if (!this.compsOf.has(g)) this.compsOf.set(g, []);
        this.compsOf.get(g).push(o);
        if (o.type === 'Transform' || o.type === 'RectTransform') this.transformOf.set(g, o);
      }
      if (o.type === 'Transform' || o.type === 'RectTransform') {
        const f = String(o.body.m_Father?.fileID ?? '0');
        if (!this.children.has(f)) this.children.set(f, []);
        this.children.get(f).push(o);
      }
    }
    this._world = new Map();
  }
  get(id) { return this.objects.get(String(id)); }
  deref(r) { return isNullRef(r) || r.guid ? null : this.get(r.fileID); }
  goOf(comp) { return this.get(comp.body.m_GameObject?.fileID); }
  nameOf(goOrComp) { const go = goOrComp.type === 'GameObject' ? goOrComp : this.goOf(goOrComp); return go?.body?.m_Name ?? null; }
  tfOf(goOrComp) { const go = goOrComp.type === 'GameObject' ? goOrComp : this.goOf(goOrComp); return go ? this.transformOf.get(go.id) : null; }
  parentTf(tf) { return this.get(tf.body.m_Father?.fileID); }
  childTfs(tf) {
    // keep Unity's m_Children order where we can, then any extras (added children)
    const kids = this.children.get(tf.id) ?? [];
    const order = (tf.body.m_Children ?? []).map((r) => String(r.fileID));
    return [...kids].sort((a, b) => ((order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9)));
  }
  comp(goOrComp, type, cls) {
    const go = goOrComp.type === 'GameObject' ? goOrComp : this.goOf(goOrComp);
    return (this.compsOf.get(go.id) ?? []).find((c) => c.type === type && (!cls || (c.body.m_EditorClassIdentifier ?? '').endsWith(cls)));
  }
  comps(goOrComp) { const go = goOrComp.type === 'GameObject' ? goOrComp : this.goOf(goOrComp); return this.compsOf.get(go.id) ?? []; }
  local(tf) {
    const b = tf.body;
    const position = vec3(b.m_LocalPosition) ?? [0, 0, 0];
    if (tf.type === 'RectTransform') {
      // Unity serialises a RectTransform's x/y through anchors: localPosition.xy =
      //   (lerp(anchorMin, anchorMax, pivot) - parentPivot) * parentSize + anchoredPosition
      const ap = [num(b.m_AnchoredPosition?.x), num(b.m_AnchoredPosition?.y)];
      const p = this.parentTf(tf);
      if (p?.type === 'RectTransform') {
        const ps = this.rectSize(p), pp = [num(p.body.m_Pivot?.x, 0.5), num(p.body.m_Pivot?.y, 0.5)];
        const amin = [num(b.m_AnchorMin?.x, 0.5), num(b.m_AnchorMin?.y, 0.5)], amax = [num(b.m_AnchorMax?.x, 0.5), num(b.m_AnchorMax?.y, 0.5)], pv = [num(b.m_Pivot?.x, 0.5), num(b.m_Pivot?.y, 0.5)];
        for (let a = 0; a < 2; a++) position[a] = (amin[a] + (amax[a] - amin[a]) * pv[a] - pp[a]) * ps[a] + ap[a];
      } else {
        position[0] = ap[0]; position[1] = ap[1];
      }
    }
    return { position, rotation: quat(b.m_LocalRotation) ?? [0, 0, 0, 1], scale: vec3(b.m_LocalScale) ?? [1, 1, 1] };
  }
  rectSize(tf) {
    const b = tf.body;
    const sd = [num(b.m_SizeDelta?.x), num(b.m_SizeDelta?.y)];
    const p = this.parentTf(tf);
    if (p?.type !== 'RectTransform') return sd;
    const ps = this.rectSize(p);
    return [0, 1].map((a) => sd[a] + (num(b.m_AnchorMax?.[a ? 'y' : 'x'], 0.5) - num(b.m_AnchorMin?.[a ? 'y' : 'x'], 0.5)) * ps[a]);
  }
  /** world matrix + Transform.rotation (product of local rotations) + lossy scale. */
  world(tf) {
    if (this._world.has(tf.id)) return this._world.get(tf.id);
    const l = this.local(tf);
    const lm = M.trs(l.position, l.rotation, l.scale);
    const p = this.parentTf(tf);
    let res;
    if (!p) res = { matrix: lm, rotation: l.rotation, lossyScale: l.scale };
    else {
      const pw = this.world(p);
      res = { matrix: M.mul(pw.matrix, lm), rotation: Q.norm(Q.mul(pw.rotation, l.rotation)), lossyScale: [pw.lossyScale[0] * l.scale[0], pw.lossyScale[1] * l.scale[1], pw.lossyScale[2] * l.scale[2]] };
    }
    res.position = [res.matrix[12], res.matrix[13], res.matrix[14]];
    this._world.set(tf.id, res);
    return res;
  }
  pathOf(tf) {
    const parts = [];
    for (let t = tf; t; t = this.parentTf(t)) parts.unshift(this.nameOf(t));
    return parts.join('/');
  }
  activeInHierarchy(tf) {
    for (let t = tf; t; t = this.parentTf(t)) if (this.goOf(t)?.body?.m_IsActive === '0') return false;
    return true;
  }
  findByName(name) { return [...this.objects.values()].filter((o) => o.type === 'GameObject' && o.body.m_Name === name); }
  findComps(cls) { return [...this.objects.values()].filter((o) => o.type === 'MonoBehaviour' && (o.body.m_EditorClassIdentifier ?? '').endsWith(cls)); }
  /** Serializable hierarchy below tf (local TRS, components summary). */
  tree(tf, depth = 0, maxDepth = 12, summarize = (g, go) => summarizeComponents(g, go)) {
    const go = this.goOf(tf);
    const l = this.local(tf);
    // inactive subtrees below the root: name + transform only (the slot cards carry 51 inactive leftover card meshes)
    if (depth > 0 && go?.body?.m_IsActive === '0') {
      const l0 = this.local(tf);
      return { name: go.body.m_Name, active: false, localPosition: r6(l0.position), localEuler: Q.toEuler(l0.rotation), localScale: r6(l0.scale), collapsed: true };
    }
    const node = {
      name: go?.body?.m_Name ?? null,
      active: go?.body?.m_IsActive !== '0',
      localPosition: r6(l.position), localRotation: r6(l.rotation), localEuler: Q.toEuler(l.rotation), localScale: r6(l.scale),
      components: go ? summarize(this, go) : [],
    };
    if (tf.prefabSource && tf.isInstanceRoot) node.prefab = tf.prefabSource;
    if (depth < maxDepth) {
      const kids = this.childTfs(tf).map((c) => this.tree(c, depth + 1, maxDepth, summarize));
      if (kids.length) node.children = kids;
    }
    return node;
  }
}

function summarizeComponents(g, go) {
  const out = [];
  for (const c of g.comps(go)) {
    if (c.type === 'Transform') continue;
    const b = c.body;
    if (c.type === 'MeshFilter') out.push({ type: 'MeshFilter', mesh: meshRef(b.m_Mesh) });
    else if (c.type === 'MeshRenderer') out.push({ type: 'MeshRenderer', enabled: b.m_Enabled !== '0', materials: (b.m_Materials ?? []).map(matRef), castShadows: num(b.m_CastShadows), receiveShadows: num(b.m_ReceiveShadows) });
    else if (c.type === 'SpriteRenderer') out.push({ type: 'SpriteRenderer', enabled: b.m_Enabled !== '0', sprite: assetPath(b.m_Sprite), color: col(b.m_Color), sortingOrder: num(b.m_SortingOrder), flipX: b.m_FlipX === '1', flipY: b.m_FlipY === '1', drawMode: num(b.m_DrawMode), size: b.m_Size ? [num(b.m_Size.x), num(b.m_Size.y)] : null, materials: (b.m_Materials ?? []).map(matRef) });
    else if (c.type === 'Animator') out.push({ type: 'Animator', enabled: b.m_Enabled !== '0', controller: assetPath(b.m_Controller), updateMode: num(b.m_UpdateMode), cullingMode: num(b.m_CullingMode), applyRootMotion: b.m_ApplyRootMotion === '1', keepAnimatorStateOnDisable: b.m_KeepAnimatorStateOnDisable === '1', writeDefaultValuesOnDisable: b.m_WriteDefaultValuesOnDisable === '1' });
    else if (c.type === 'MonoBehaviour') out.push({ type: (b.m_EditorClassIdentifier || assetPath(b.m_Script) || 'MonoBehaviour').split('::').pop(), enabled: b.m_Enabled !== '0' });
    else if (c.type === 'BoxCollider' || c.type === 'MeshCollider') out.push({ type: c.type });
    else out.push({ type: c.type });
  }
  return out;
}

const meshRef = (r) => (isNullRef(r) ? null : { asset: assetPath(r), fileID: String(r.fileID) });
const matRef = (r) => (isNullRef(r) ? null : assetPath(r));

// =============================================================================================
// Materials & textures

const materialCache = new Map();
function material(rel) {
  if (!rel || !/\.mat$/i.test(rel)) return rel ? { path: rel } : null;
  if (materialCache.has(rel)) return materialCache.get(rel);
  const d = loadDocs(rel).find((x) => x.type === 'Material');
  const b = d.body;
  const sp = b.m_SavedProperties ?? {};
  const tex = {};
  for (const e of sp.m_TexEnvs ?? []) {
    const [k, v] = Object.entries(e)[0];
    if (!isNullRef(v.m_Texture)) tex[k] = { texture: assetPath(v.m_Texture), scale: [num(v.m_Scale?.x, 1), num(v.m_Scale?.y, 1)], offset: [num(v.m_Offset?.x), num(v.m_Offset?.y)] };
  }
  const floats = {};
  for (const e of sp.m_Floats ?? []) { const [k, v] = Object.entries(e)[0]; floats[k] = num(v); }
  const colors = {};
  for (const e of sp.m_Colors ?? []) { const [k, v] = Object.entries(e)[0]; colors[k] = col(v); }
  const shaderPath = assetPath(b.m_Shader);
  let shaderName = shaderPath;
  if (shaderPath && /\.shader$/i.test(shaderPath)) { const m = /Shader\s+"([^"]+)"/.exec(fs.readFileSync(abs(shaderPath), 'utf8')); if (m) shaderName = m[1]; }
  const res = { path: rel, name: b.m_Name, shader: shaderName, keywords: b.m_ValidKeywords ?? b.m_ShaderKeywords ?? [], renderQueue: num(b.m_CustomRenderQueue, -1), textures: tex, colors, floats };
  materialCache.set(rel, res);
  return res;
}

function textureInfo(rel) {
  if (!rel || !fs.existsSync(abs(rel))) return { path: rel };
  const st = fs.statSync(abs(rel));
  const info = { path: rel, bytes: st.size };
  try {
    const meta = parsePlainYaml(fs.readFileSync(abs(rel) + '.meta', 'utf8'));
    const ti = meta.TextureImporter;
    if (ti) {
      info.import = {
        textureType: num(ti.textureType), sRGB: num(ti.textureSettings ? ti.mipmaps?.sRGBTexture : ti.mipmaps?.sRGBTexture, 1) === 1,
        mipmaps: num(ti.mipmaps?.enableMipMap, 1) === 1, wrapU: num(ti.textureSettings?.wrapU), wrapV: num(ti.textureSettings?.wrapV), filterMode: num(ti.textureSettings?.filterMode), aniso: num(ti.textureSettings?.aniso),
        maxTextureSize: num(ti.maxTextureSize), alphaIsTransparency: num(ti.alphaIsTransparency) === 1, spritePixelsToUnits: ti.spritePixelsToUnits !== undefined ? num(ti.spritePixelsToUnits) : undefined,
        spritePivot: ti.spritePivot ? [num(ti.spritePivot.x), num(ti.spritePivot.y)] : undefined, spriteMode: ti.spriteMode !== undefined ? num(ti.spriteMode) : undefined,
      };
    }
  } catch (e) { warn(`texture meta ${rel}: ${e.message}`); }
  const dim = imageSize(abs(rel));
  if (dim) info.pixelSize = dim;
  return info;
}

function imageSize(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const mk = b[o + 1];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)];
      o += 2 + b.readUInt16BE(o + 2);
    }
  }
  if (b.toString('latin1', 0, 4) === '8BPS') return [b.readUInt32BE(18), b.readUInt32BE(14)];
  if (b[0] === 0 && b[2] === 2) return [b.readUInt16LE(12), b.readUInt16LE(14)]; // tga
  return null;
}

/** Sprites: rect / pivot / pixelsPerUnit from the texture importer (single or multiple mode). */
function spriteInfo(r) {
  if (isNullRef(r)) return null;
  const tex = assetPath(r);
  const info = textureInfo(tex);
  const out = { texture: tex, fileID: String(r.fileID), pixelSize: info.pixelSize, pixelsPerUnit: info.import?.spritePixelsToUnits ?? 100, pivot: info.import?.spritePivot ?? [0.5, 0.5] };
  if (info.pixelSize) out.worldSizeAtScale1 = [info.pixelSize[0] / out.pixelsPerUnit, info.pixelSize[1] / out.pixelsPerUnit];
  return out;
}

// =============================================================================================
// Splines (exactly the Unity.Splines 2.x semantics; see notes in the JSON "semantics" block)

const LUT_RES = 30; // Spline.k_CurveDistanceLutResolution / NativeSpline.k_SegmentResolution

function bezierPos(c, t) {
  t = Math.max(0, Math.min(1, t));
  const t2 = t * t, t3 = t2 * t;
  const a = -t3 + 3 * t2 - 3 * t + 1, b = 3 * t3 - 6 * t2 + 3 * t, cc = -3 * t3 + 3 * t2, d = t3;
  return [0, 1, 2].map((i) => c.p0[i] * a + c.p1[i] * b + c.p2[i] * cc + c.p3[i] * d);
}
function curveLut(c) {
  const lut = [{ d: 0, t: 0 }];
  let prev = bezierPos(c, 0), mag = 0;
  for (let i = 1; i < LUT_RES; i++) {
    const t = i / (LUT_RES - 1);
    const p = bezierPos(c, t);
    mag += V.len(V.sub(p, prev));
    lut.push({ d: mag, t });
    prev = p;
  }
  return lut;
}

function readSpline(g, containerComp) {
  const b = containerComp.body;
  const splines = b.m_Splines ?? [];
  if (splines.length !== 1) warn(`${g.nameOf(containerComp)}: SplineContainer has ${splines.length} splines (SplineAnimate walks ALL of them as one SplinePath)`);
  const sp = splines[0] ?? b.m_Spline;
  const tf = g.tfOf(containerComp);
  const w = g.world(tf);
  const meta = sp.m_MetaData ?? [];
  const knots = (sp.m_Knots ?? []).map((k, i) => ({
    position: r6(vec3(k.Position)), tangentIn: r6(vec3(k.TangentIn)), tangentOut: r6(vec3(k.TangentOut)), rotation: r6(quat(k.Rotation?.value ?? k.Rotation)),
    tangentMode: num(meta[i]?.Mode), tangentModeName: ['AutoSmooth', 'Linear', 'Mirrored', 'Continuous', 'Broken'][num(meta[i]?.Mode)], tension: num(meta[i]?.Tension, 0.5),
  }));
  const closed = sp.m_Closed === '1';
  const curvesLocal = [];
  const n = closed ? knots.length : knots.length - 1;
  for (let i = 0; i < n; i++) {
    const a = knots[i], c = knots[(i + 1) % knots.length];
    curvesLocal.push({ p0: a.position, p1: V.add(a.position, Q.rotate(a.rotation, a.tangentOut)), p2: V.add(c.position, Q.rotate(c.rotation, c.tangentIn)), p3: c.position });
  }
  const curves = curvesLocal.map((c) => ({ p0: M.point(w.matrix, c.p0), p1: M.point(w.matrix, c.p1), p2: M.point(w.matrix, c.p2), p3: M.point(w.matrix, c.p3) }));
  const lenLocal = curvesLocal.map((c) => curveLut(c).at(-1).d);
  const lenWorld = curves.map((c) => curveLut(c).at(-1).d);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const s = w.lossyScale;
  const nonUniform = !(s[0] === s[1] && s[1] === s[2]);
  if (nonUniform) warn(`${g.nameOf(containerComp)}: non-uniform lossy scale ${s} — Unity evaluates a world-baked NativeSpline in that case`);
  return {
    name: g.nameOf(containerComp),
    closed,
    splineCountInContainer: splines.length,
    knots,
    worldMatrix: r6(w.matrix),
    worldPosition: r6(w.position),
    worldRotation: r6(w.rotation),
    lossyScale: r6(s),
    curvesLocal: r6(curvesLocal),
    curves: r6(curves),
    knotUpWorld: r6(knots.map((k) => V.norm(Q.rotate(w.rotation, Q.rotate(k.rotation, [0, 1, 0]))))),
    knotWorld: r6(knots.map((k) => M.point(w.matrix, k.position))),
    curveLengthsLocal: r6(lenLocal),
    curveLengthsWorld: r6(lenWorld),
    lengthLocal: r6(sum(lenLocal)),
    lengthWorld: r6(sum(lenWorld)),
  };
}

// =============================================================================================
// MMFeedbacks (MMF_Player) — SerializeReference feedback list

function numify(v) {
  if (Array.isArray(v)) return v.map(numify);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = numify(v[k]); return o; }
  if (typeof v === 'string' && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v) && v.replace('-', '').replace('.', '').length <= 15) return Number(v);
  return v;
}

function describeRef(g, r) {
  if (isNullRef(r)) return null;
  if (r.guid) return { asset: assetPath(r), fileID: String(r.fileID) };
  const o = g.get(r.fileID);
  if (!o) return { fileID: String(r.fileID), missing: true };
  const go = o.type === 'GameObject' ? o : g.goOf(o);
  const tf = go ? g.tfOf(go) : null;
  return { type: o.type === 'MonoBehaviour' ? (o.body.m_EditorClassIdentifier || '').split('::').pop() : o.type, gameObject: go?.body?.m_Name, path: tf ? g.pathOf(tf) : null };
}

function mmfPlayer(g, comp) {
  if (!comp) return null;
  const b = comp.body;
  const refs = new Map((b.references?.RefIds ?? []).map((r) => [String(r.rid), r]));
  const KEYS = /duration|amplitude|intensity|delay|frequency|shake|zoom|remap|range|axis|curve|mode|speed|offset|power|target|channel|field|scale|position|rotation|direction|noise|randomness|bounce|wiggle|magnitude|time|channel|relative|additive/i;
  const feedbacks = (b.FeedbacksList ?? []).map((e) => {
    const r = refs.get(String(e.rid));
    if (!r) return { rid: String(e.rid), missing: true };
    const d = r.data ?? {};
    const timing = d.Timing ? numify(d.Timing) : null;
    const settings = {};
    for (const [k, v] of Object.entries(d)) {
      if (['Timing', 'Label', 'OriginalLabel', 'UniqueID', 'Active', 'RangeFalloff', 'RemapRangeFalloff', 'AutomatedTargetAcquisition', 'Chance', 'ChannelMode', 'Channel', 'MMChannelDefinition', 'UseRange', 'RangeDistance', 'UseRangeFalloff', 'RandomizeOutput', 'RandomMultiplier', 'RandomizeDuration', 'RandomDurationMultiplier'].includes(k)) continue;
      if (!KEYS.test(k) && typeof v === 'object' && !(v && v.fileID !== undefined)) continue;
      settings[k] = v && typeof v === 'object' && v.fileID !== undefined ? describeRef(g, v) : numify(v);
    }
    return {
      class: r.type?.class, namespace: r.type?.ns, label: d.Label, active: d.Active === '1', chance: num(d.Chance, 100),
      channelMode: num(d.ChannelMode), channel: num(d.Channel),
      initialDelay: timing?.InitialDelay ?? 0, timescaleMode: timing?.TimescaleMode, numberOfRepeats: timing?.NumberOfRepeats, delayBetweenRepeats: timing?.DelayBetweenRepeats,
      timing, settings,
    };
  });
  return {
    gameObject: g.nameOf(comp), path: g.pathOf(g.tfOf(comp)),
    initialDelay: num(b.InitialDelay), durationMultiplier: num(b.DurationMultiplier, 1), timescaleMultiplier: num(b.TimescaleMultiplier, 1), feedbacksIntensity: num(b.FeedbacksIntensity, 1),
    direction: num(b.Direction), playerTimescaleMode: num(b.PlayerTimescaleMode), canPlayWhileAlreadyPlaying: b.CanPlayWhileAlreadyPlaying === '1', cooldownDuration: num(b.CooldownDuration), chanceToPlay: num(b.ChanceToPlay, 100),
    feedbacks,
  };
}

/** Generic MonoBehaviour field dump (no Unity bookkeeping), refs described. */
function fields(g, comp) {
  if (!comp) return null;
  const out = {};
  for (const [k, v] of Object.entries(comp.body)) {
    if (/^m_(ObjectHideFlags|CorrespondingSourceObject|PrefabInstance|PrefabAsset|GameObject|EditorHideFlags|Script|Name|EditorClassIdentifier)$/.test(k)) continue;
    out[k] = v && typeof v === 'object' && v.fileID !== undefined ? describeRef(g, v) : numify(v);
  }
  return { class: (comp.body.m_EditorClassIdentifier || assetPath(comp.body.m_Script) || '').split('::').pop(), enabled: comp.body.m_Enabled !== '0', fields: out };
}

// =============================================================================================
// Animation clips

function keyframesFromCurve(curve, comps) {
  return (curve?.m_Curve ?? []).map((k) => {
    const pick = (v) => (comps ? comps.map((c) => num(v?.[c])) : num(v));
    return { time: num(k.time), value: pick(k.value), inSlope: pick(k.inSlope), outSlope: pick(k.outSlope), tangentMode: num(k.tangentMode), weightedMode: num(k.weightedMode), inWeight: pick(k.inWeight), outWeight: pick(k.outWeight) };
  });
}
function clip(rel) {
  const d = loadDocs(rel).find((x) => x.type === 'AnimationClip');
  const b = d.body;
  const s = b.m_AnimationClipSettings ?? {};
  const vecCurves = (list, attribute) => (list ?? []).map((c) => ({ path: c.path ?? '', attribute, preInfinity: num(c.curve?.m_PreInfinity), postInfinity: num(c.curve?.m_PostInfinity), rotationOrder: num(c.curve?.m_RotationOrder, 4), keys: keyframesFromCurve(c.curve, attribute === 'rotation' ? ['x', 'y', 'z', 'w'] : ['x', 'y', 'z']) }));
  const floatCurves = (list) => (list ?? []).map((c) => ({ path: c.path ?? '', attribute: c.attribute, classID: num(c.classID), script: c.script && !isNullRef(c.script) ? assetPath(c.script) : null, preInfinity: num(c.curve?.m_PreInfinity), postInfinity: num(c.curve?.m_PostInfinity), keys: keyframesFromCurve(c.curve) }));
  const curves = {
    m_PositionCurves: vecCurves(b.m_PositionCurves, 'position'),
    m_EulerCurves: vecCurves(b.m_EulerCurves, 'euler'),
    m_RotationCurves: vecCurves(b.m_RotationCurves, 'rotation'),
    m_ScaleCurves: vecCurves(b.m_ScaleCurves, 'scale'),
    m_FloatCurves: floatCurves(b.m_FloatCurves),
    m_EditorCurves: floatCurves(b.m_EditorCurves),
    m_EulerEditorCurves: floatCurves(b.m_EulerEditorCurves),
  };
  const all = [...curves.m_PositionCurves, ...curves.m_EulerCurves, ...curves.m_RotationCurves, ...curves.m_ScaleCurves, ...curves.m_FloatCurves];
  const stop = num(s.m_StopTime, 0);
  return {
    name: b.m_Name, source: rel,
    length: stop - num(s.m_StartTime, 0), startTime: num(s.m_StartTime), stopTime: stop,
    sampleRate: num(b.m_SampleRate, 60), wrapMode: num(b.m_WrapMode), loopTime: s.m_LoopTime === '1', legacy: b.m_Legacy === '1',
    animatedPaths: [...new Set(all.map((c) => c.path))],
    events: (b.m_Events ?? []).map((e) => ({ time: num(e.time), functionName: e.functionName, data: e.data, floatParameter: num(e.floatParameter), intParameter: num(e.intParameter) })),
    curves,
  };
}

function controller(rel) {
  const docs = loadDocs(rel);
  const by = new Map(docs.map((d) => [d.fileID, d]));
  const ctl = docs.find((d) => d.type === 'AnimatorController');
  const layers = (ctl.body.m_AnimatorLayers ?? []).map((l) => {
    const sm = by.get(String(l.m_StateMachine.fileID));
    const states = (sm.body.m_ChildStates ?? []).map((cs) => {
      const st = by.get(String(cs.m_State.fileID)).body;
      return {
        name: st.m_Name, speed: num(st.m_Speed, 1), cycleOffset: num(st.m_CycleOffset), writeDefaultValues: st.m_WriteDefaultValues === '1', mirror: st.m_Mirror === '1',
        motion: assetPath(st.m_Motion), transitions: (st.m_Transitions ?? []).length, tag: st.m_Tag,
      };
    });
    const def = by.get(String(sm.body.m_DefaultState?.fileID));
    return { name: l.m_Name, defaultWeight: num(l.m_DefaultWeight), blendingMode: num(l.m_BlendingMode), defaultState: def?.body?.m_Name ?? null, states, anyStateTransitions: (sm.body.m_AnyStateTransitions ?? []).length, entryTransitions: (sm.body.m_EntryTransitions ?? []).length };
  });
  return { name: ctl.body.m_Name, path: rel, parameters: (ctl.body.m_AnimatorParameters ?? []).map((p) => ({ name: p.m_Name, type: num(p.m_Type) })), layers };
}

// =============================================================================================
// Main extraction

function extract() {
  buildGuidIndex();
  const g = new Graph(SCENE);
  const sceneDocs = loadDocs(SCENE);

  // --- splines, per seat in TableView engine-seat order ------------------------------------------------
  const tableView = g.findComps('Poker.Game.TableView')[0];
  const dealerComp = g.findComps('Poker.Game.SplineCardDealer')[0];
  const seatRefs = tableView.body.seatViews ?? [];
  const splines = seatRefs.map((r, seat) => {
    const sv = g.deref(r);
    const go = g.goOf(sv);
    const s0 = g.deref(sv.body.holeCardSpline0), s1 = g.deref(sv.body.holeCardSpline1);
    const seatTf = g.tfOf(go);
    let rootTf = seatTf; while (g.parentTf(rootTf)) rootTf = g.parentTf(rootTf);
    return {
      seat,
      slotName: go?.body?.m_Name,
      seatViewPath: seatTf ? g.pathOf(seatTf) : null,
      seatPrefab: seatTf?.prefabSource ?? null,
      seatRootWorldPosition: rootTf ? r6(g.world(rootTf).position) : null,
      seatRootName: rootTf ? g.nameOf(rootTf) : null,
      card0: s0 ? readSpline(g, s0) : null,
      card1: s1 ? readSpline(g, s1) : null,
    };
  });
  const dealSpeed = num(dealerComp.body.dealSpeed, 12);
  for (const s of splines) for (const sp of [s.card0, s.card1]) if (sp) {
    sp.dealDurationSeconds = r6((2 * sp.lengthLocal) / dealSpeed); // SplineAnimate Speed + EaseInOut
    sp.returnDurationSeconds = r6(sp.lengthWorld / dealSpeed); // after the 0.25 s Flip(false)
  }
  const splinesParent = g.findByName('Splines')[0];
  const splinesParentTf = splinesParent ? g.tfOf(splinesParent) : null;
  // splines not referenced by any engine seat (e.g. the extra SeatView on Table_Canvas)
  const used = new Set(splines.flatMap((s) => [s.card0?.name, s.card1?.name]));
  const allSplineNames = g.findComps('UnityEngine.Splines.SplineContainer').map((c) => g.nameOf(c));
  const extraSeatViews = g.findComps('Poker.Game.SeatView').filter((sv) => !seatRefs.some((r) => g.deref(r) === sv)).map((sv) => ({ gameObject: g.nameOf(sv), path: g.pathOf(g.tfOf(sv)), holeCardSpline0: g.deref(sv.body.holeCardSpline0) ? g.nameOf(g.deref(sv.body.holeCardSpline0)) : null, holeCardSpline1: g.deref(sv.body.holeCardSpline1) ? g.nameOf(g.deref(sv.body.holeCardSpline1)) : null }));

  // --- community slots ------------------------------------------------------------------------------------
  const animByController = {};
  const communitySlots = (dealerComp.body.communitySlots ?? []).map((r, i) => {
    const go = g.deref(r);
    const tf = g.tfOf(go);
    const w = g.world(tf);
    const animator = g.comp(go, 'Animator');
    const ctlPath = animator ? assetPath(animator.body.m_Controller) : null;
    const ctl = ctlPath ? controller(ctlPath) : null;
    const clipPaths = ctl ? ctl.layers.flatMap((l) => l.states.map((s) => s.motion)) : [];
    const clips = clipPaths.map((p) => clip(p));
    const animatedPaths = [...new Set(clips.flatMap((c) => c.animatedPaths))];
    const resolve = (p) => {
      let t = tf;
      for (const part of p ? p.split('/') : []) { t = g.childTfs(t).find((c) => g.nameOf(c) === part); if (!t) return null; }
      return t;
    };
    const cardView = (() => { const stack = [tf]; while (stack.length) { const t = stack.shift(); const cv = g.comp(g.goOf(t), 'MonoBehaviour', 'Poker.Game.CardView'); if (cv) return t; stack.push(...g.childTfs(t)); } return null; })();
    return {
      index: i,
      name: go.body.m_Name,
      activeAtStart: go.body.m_IsActive !== '0',
      worldPosition: r6(w.position), worldRotation: r6(w.rotation), worldEuler: Q.toEuler(w.rotation), lossyScale: r6(w.lossyScale), worldMatrix: r6(w.matrix),
      parentPath: g.parentTf(tf) ? g.pathOf(g.parentTf(tf)) : null,
      animator: animator ? summarizeComponents(g, go).find((c) => c.type === 'Animator') : null,
      controller: ctlPath,
      clips: clipPaths,
      animatedPaths: animatedPaths.map((p) => {
        const t = resolve(p);
        return { path: p, resolved: !!t, worldPositionAtRest: t ? r6(g.world(t).position) : null, localAtRest: t ? (({ position, rotation, scale }) => ({ position: r6(position), rotation: r6(rotation), euler: Q.toEuler(rotation), scale: r6(scale) }))(g.local(t)) : null };
      }),
      cardViewPath: cardView ? g.pathOf(cardView).split('/').slice(g.pathOf(tf).split('/').length).join('/') : null,
      cardViewSettings: cardView ? fields(g, g.comp(g.goOf(cardView), 'MonoBehaviour', 'Poker.Game.CardView'))?.fields : null,
      hierarchy: g.tree(tf),
    };
  });

  // --- camera ------------------------------------------------------------------------------------------------
  const camComp = [...g.objects.values()].find((o) => o.type === 'Camera');
  const camGo = g.goOf(camComp);
  const camTf = g.tfOf(camGo);
  const cw = g.world(camTf);
  const cb = camComp.body;
  const camExtras = g.comps(camGo).filter((c) => c.type === 'MonoBehaviour').map((c) => fields(g, c));
  const camChildren = g.childTfs(camTf).map((t) => ({ name: g.nameOf(t), components: g.comps(g.goOf(t)).filter((c) => c.type === 'MonoBehaviour').map((c) => fields(g, c)) }));
  const ppVolume = [...g.objects.values()].find((o) => o.type === 'MonoBehaviour' && (o.body.m_EditorClassIdentifier ?? '').endsWith('PostProcessVolume'));
  const ppProfile = ppVolume ? postProcessProfile(assetPath(ppVolume.body.sharedProfile)) : null;
  const cinemachine = [...g.objects.values()].filter((o) => o.type === 'MonoBehaviour' && /Cinemachine/i.test(o.body.m_EditorClassIdentifier ?? ''));
  const camera = {
    gameObject: camGo.body.m_Name, tag: camGo.body.m_TagString,
    worldPosition: r6(cw.position), worldRotation: r6(cw.rotation), worldEuler: Q.toEuler(cw.rotation),
    localPosition: r6(g.local(camTf).position), localRotation: r6(g.local(camTf).rotation),
    forward: r6(Q.rotate(cw.rotation, [0, 0, 1])), up: r6(Q.rotate(cw.rotation, [0, 1, 0])),
    fieldOfView: num(cb['field of view'] ?? cb.m_FieldOfView, 60), fovAxis: num(cb.m_FOVAxisMode), near: num(cb['near clip plane'], 0.3), far: num(cb['far clip plane'], 1000),
    orthographic: cb.orthographic === '1', orthographicSize: num(cb['orthographic size'], 5),
    clearFlags: num(cb.m_ClearFlags), clearFlagsName: ({ 1: 'Skybox', 2: 'SolidColor', 3: 'Depth', 4: 'Nothing' })[num(cb.m_ClearFlags)], backgroundColor: col(cb.m_BackGroundColor),
    depth: num(cb.m_Depth), cullingMask: num(cb.m_CullingMask?.m_Bits), allowHDR: cb.m_AllowHDR === '1', allowMSAA: cb.m_AllowMSAA === '1', renderingPath: num(cb.m_RenderingPath),
    viewportRect: cb.m_NormalizedViewPortRect ? [num(cb.m_NormalizedViewPortRect.x), num(cb.m_NormalizedViewPortRect.y), num(cb.m_NormalizedViewPortRect.width), num(cb.m_NormalizedViewPortRect.height)] : null,
    physicalCamera: num(cb.m_projectionMatrixMode) === 2, sensorSize: cb.m_SensorSize ? [num(cb.m_SensorSize.x), num(cb.m_SensorSize.y)] : null, lensShift: cb.m_LensShift ? [num(cb.m_LensShift.x), num(cb.m_LensShift.y)] : null, focalLength: num(cb.m_FocalLength),
    rig: { cinemachine: cinemachine.length ? cinemachine.map((c) => fields(g, c)) : 'none in scene', components: camExtras, children: camChildren },
    postProcessing: ppVolume ? { volume: fields(g, ppVolume), profile: ppProfile } : null,
  };

  // --- dealer ------------------------------------------------------------------------------------------------
  const riverComp = g.deref(dealerComp.body.riverSlamFeedback);
    const mmfPlayers = [...g.objects.values()].filter((o) => o.type === 'MonoBehaviour' && assetPath(o.body.m_Script)?.endsWith('MMF_Player.cs'));
  const dealer = {
    gameObject: g.nameOf(dealerComp), path: g.pathOf(g.tfOf(dealerComp)),
    dealSpeed: num(dealerComp.body.dealSpeed, 12), holeStagger: num(dealerComp.body.holeStagger, 0.12),
    codeDefaults: { dealSpeed: 12, holeStagger: 0.12, note: 'serialized values above override these C# field initialisers' },
    cardPrefab: assetPath(dealerComp.body.cardPrefab), library: assetPath(dealerComp.body.library),
    communitySlots: communitySlots.map((s) => s.name),
    derivedTimings: {
      dealFlightSeconds: 'SplineAnimate Method.Speed + EaseInOut: duration = 2 * lengthLocal / dealSpeed (see each spline)',
      returnFlightSeconds: 'CardView.ReturnAlongSpline: 0.25s Flip(false) THEN lengthWorld / dealSpeed with Ease.InOutQuad',
      returnStagger: 'order * holeStagger * 0.5 (last dealt card leaves first)',
    },
    riverSlamFeedback: mmfPlayer(g, riverComp),
    otherFeedbackPlayers: mmfPlayers.filter((p) => p !== riverComp).map((p) => mmfPlayer(g, p)),
    shakerListeners: shakerListeners(g),
    shakerListenersNote: 'MMF_*Shake feedbacks with no TargetShaker broadcast on their Channel; every enabled listener below on the same channel reacts. The Card_Modular prefab also carries MMPositionShaker + MMRotationShaker (see card.rootComponents), so each dealt hole card rattles.',
  };

  // --- card --------------------------------------------------------------------------------------------------
  const card = extractCard(dealer.cardPrefab, dealer.library);

  // --- table, lights, environment ------------------------------------------------------------------------------
  const renderers = [...g.objects.values()].filter((o) => o.type === 'MeshRenderer' || o.type === 'SpriteRenderer');
  const tableObjects = renderers.filter((r) => {
    const tf = g.tfOf(r);
    const p = g.pathOf(tf);
    return !/^Canvas|Name_Canvas|Pot_UI|RetentionHud/.test(p) && !communitySlots.some((s) => p.startsWith(s.name + '/') || p === s.name);
  }).map((r) => {
    const go = g.goOf(r);
    const tf = g.tfOf(go);
    const w = g.world(tf);
    const mf = g.comp(go, 'MeshFilter');
    const mats = (r.body.m_Materials ?? []).map((m) => material(matRef(m)));
    const meshAsset = mf ? meshRef(mf.body.m_Mesh) : null;
    return {
      name: go.body.m_Name, path: g.pathOf(tf), activeSelf: go.body.m_IsActive !== '0', activeInHierarchy: g.activeInHierarchy(tf), rendererEnabled: r.body.m_Enabled !== '0',
      renderer: r.type,
      mesh: meshAsset ? { ...meshAsset, ...(meshAsset.asset && /\.(fbx|obj|blend|dae)$/i.test(meshAsset.asset) ? { modelSummary: modelSummary(meshAsset.asset, meshAsset.fileID) } : {}) } : null,
      sprite: r.type === 'SpriteRenderer' ? spriteInfo(r.body.m_Sprite) : undefined,
      spriteColor: r.type === 'SpriteRenderer' ? col(r.body.m_Color) : undefined,
      sortingLayer: num(r.body.m_SortingLayerID), sortingOrder: num(r.body.m_SortingOrder),
      castShadows: num(r.body.m_CastShadows), receiveShadows: num(r.body.m_ReceiveShadows),
      materials: mats,
      local: (({ position, rotation, scale }) => ({ position: r6(position), rotation: r6(rotation), euler: Q.toEuler(rotation), scale: r6(scale) }))(g.local(tf)),
      worldPosition: r6(w.position), worldRotation: r6(w.rotation), worldEuler: Q.toEuler(w.rotation), lossyScale: r6(w.lossyScale), worldMatrix: r6(w.matrix),
    };
  });
  const lights = [...g.objects.values()].filter((o) => o.type === 'Light').map((l) => {
    const tf = g.tfOf(l); const w = g.world(tf); const b = l.body;
    return {
      name: g.nameOf(l), activeInHierarchy: g.activeInHierarchy(tf), enabled: b.m_Enabled !== '0',
      type: num(b.m_Type), typeName: ['Spot', 'Directional', 'Point', 'Area(Rect)', 'Disc'][num(b.m_Type)], color: col(b.m_Color), intensity: num(b.m_Intensity, 1), bounceIntensity: num(b.m_BounceIntensity, 1), range: num(b.m_Range, 10), spotAngle: num(b.m_SpotAngle, 30),
      colorTemperature: num(b.m_ColorTemperature), useColorTemperature: b.m_UseColorTemperature === '1',
      shadows: num(b.m_Shadows?.m_Type), shadowStrength: num(b.m_Shadows?.m_Strength, 1), shadowBias: num(b.m_Shadows?.m_Bias), shadowNormalBias: num(b.m_Shadows?.m_NormalBias), lightmapBakeType: num(b.m_Lightmapping), renderMode: num(b.m_RenderMode), cullingMask: num(b.m_CullingMask?.m_Bits),
      worldPosition: r6(w.position), worldRotation: r6(w.rotation), worldEuler: Q.toEuler(w.rotation), direction: r6(Q.rotate(w.rotation, [0, 0, 1])),
    };
  });
  const rs = sceneDocs.find((d) => d.type === 'RenderSettings')?.body ?? {};
  const environment = {
    renderPipeline: 'Built-in (Standard shader + Post Processing Stack v2)',
    fog: rs.m_Fog === '1', fogColor: col(rs.m_FogColor), fogMode: num(rs.m_FogMode), fogDensity: num(rs.m_FogDensity), linearFogStart: num(rs.m_LinearFogStart), linearFogEnd: num(rs.m_LinearFogEnd),
    ambientMode: num(rs.m_AmbientMode), ambientModeName: ({ 0: 'Skybox', 1: 'Trilight', 3: 'Flat', 4: 'Custom' })[num(rs.m_AmbientMode)],
    ambientSkyColor: col(rs.m_AmbientSkyColor), ambientEquatorColor: col(rs.m_AmbientEquatorColor), ambientGroundColor: col(rs.m_AmbientGroundColor), ambientIntensity: num(rs.m_AmbientIntensity, 1),
    skyboxMaterial: isNullRef(rs.m_SkyboxMaterial) ? null : material(assetPath(rs.m_SkyboxMaterial)),
    reflectionIntensity: num(rs.m_ReflectionIntensity, 1), defaultReflectionMode: num(rs.m_DefaultReflectionMode), sun: describeRef(g, rs.m_Sun), subtractiveShadowColor: col(rs.m_SubtractiveShadowColor),
  };
  const colorSpace = (() => { try { const m = /m_ActiveColorSpace: (\d)/.exec(fs.readFileSync(abs('ProjectSettings/ProjectSettings.asset'), 'utf8')); return m ? (m[1] === '1' ? 'Linear' : 'Gamma') : null; } catch { return null; } })();
  environment.colorSpace = colorSpace;
  const tableRoot = g.findByName('Table')[0];
  const tableCanvasGo = g.findByName('Table_Canvas')[0];
  const table = {
    note: 'The visible felt is the world-space UI canvas Background/Table_Canvas -> Image (see tableCanvas; ThemeManager.ApplyTableFelt swaps its sprite per theme). objects[] = every MeshRenderer/SpriteRenderer outside the HUD canvases and community slots; check activeInHierarchy — the "Table" plane (and Table_Shadow) are INACTIVE in Test.unity, Background_Image (backdrop plane far below) and Card_hole (sprite) are active. ThemeManager also re-textures Background_Image and Table by name at runtime.',
    tableCanvas: tableCanvasGo ? worldCanvas(g, g.tfOf(tableCanvasGo)) : null,
    table: tableRoot ? tableObjects.find((o) => o.path.endsWith('/Table') || o.path === 'Table') ?? null : null,
    objects: tableObjects,
    lights,
    environment,
    tokenParents: (() => { const t = g.findByName('Token Parents ')[0] ?? g.findByName('Token Parents')[0]; return t ? g.tree(g.tfOf(t)) : null; })(),
  };

  // --- assemble ------------------------------------------------------------------------------------------------
  const scene = {
    $schema: 'unity-scene/1',
    generatedBy: 'web/tools/extract-unity-scene.mjs',
    source: SCENE,
    coordinateSystem: 'Unity native: LEFT-HANDED, +X right, +Y up, +Z forward. Quaternions [x,y,z,w]. Matrices 4x4 column-major (m[col*4+row]). Euler degrees in Unity order (Z, then X, then Y; q = qY*qX*qZ). Convert to three.js in one place, e.g. negate Z of positions and (x,y) of quaternions [ -qx, -qy, qz, qw ] → mirror across XY plane.',
    semantics: SEMANTICS,
    splinesParent: splinesParentTf ? { path: g.pathOf(splinesParentTf), world: r6(g.world(splinesParentTf).matrix) } : null,
    splines,
    unusedSplines: allSplineNames.filter((n) => !used.has(n)),
    extraSeatViews,
    communitySlots,
    camera,
    dealer,
    card,
    table,
    warnings,
  };

  // --- slot anims --------------------------------------------------------------------------------------------
  const animFiles = fs.readdirSync(abs(SLOT_ANIM_DIR)).filter((f) => f.endsWith('.anim')).sort();
  const ctlFiles = fs.readdirSync(abs(SLOT_ANIM_DIR)).filter((f) => f.endsWith('.controller')).sort();
  const anims = {
    $schema: 'unity-slot-anims/1',
    generatedBy: 'web/tools/extract-unity-scene.mjs',
    source: SLOT_ANIM_DIR,
    evaluation: ANIM_SEMANTICS,
    clips: Object.fromEntries(animFiles.map((f) => { const c = clip(`${SLOT_ANIM_DIR}/${f}`); return [c.name, c]; })),
    controllers: Object.fromEntries(ctlFiles.map((f) => { const c = controller(`${SLOT_ANIM_DIR}/${f}`); return [c.name, c]; })),
    slots: communitySlots.map((s) => ({ slot: s.name, controller: s.controller ? path.basename(s.controller, '.controller') : null, clips: s.clips.map((p) => path.basename(p, '.anim')), animatedPaths: s.animatedPaths.map((a) => a.path), cardViewPath: s.cardViewPath })),
  };

  return { scene, anims };
}

// =============================================================================================
// Card prefab

function modelSummary(rel, fileID) {
  const s = fbxSummary(rel);
  if (!s) return null;
  return { asset: rel, unitScaleFactor: s.globalSettings.UnitScaleFactor, fileScale: s.fileScale, globalScale: s.globalScale, useFileScale: s.useFileScale, upAxis: s.globalSettings.UpAxis, fileID };
}

const fbxCache = new Map();
function fbxSummary(rel) {
  if (fbxCache.has(rel)) return fbxCache.get(rel);
  let s = null;
  try {
    s = summarizeFbx(abs(rel));
    const meta = parsePlainYaml(fs.readFileSync(abs(rel) + '.meta', 'utf8')).ModelImporter ?? {};
    const mesh = meta.meshes ?? {};
    s.globalScale = num(mesh.globalScale, 1);
    s.useFileScale = num(mesh.useFileScale, 1) === 1;
    // Unity: file scale = UnitScaleFactor (cm per file unit) / 100 when useFileScale is on.
    s.fileScale = s.useFileScale ? (s.globalSettings.UnitScaleFactor ?? 1) / 100 : 1;
    s.importSettings = {
      globalScale: s.globalScale, useFileScale: s.useFileScale, useFileUnits: num(mesh.useFileUnits, 1) === 1, bakeAxisConversion: num(mesh.bakeAxisConversion) === 1,
      importNormals: num(mesh.normalImportMode ?? meta.tangentSpace?.normalImportMode), materialImportMode: num(meta.materials?.materialImportMode), isReadable: num(mesh.isReadable) === 1,
    };
    s.externalMaterials = Object.fromEntries((meta.externalObjects ?? []).filter((e) => /Material/.test(e.first?.type ?? '')).map((e) => [e.first.name, assetPath(e.second)]));
  } catch (e) { warn(`fbx ${rel}: ${e.message}`); }
  fbxCache.set(rel, s);
  return s;
}

function extractCard(prefabRel, libraryRel) {
  const pg = new Graph(prefabRel);
  const rootTf = [...pg.objects.values()].find((o) => (o.type === 'Transform') && String(o.body.m_Father?.fileID) === '0');
  const rootGo = pg.goOf(rootTf);
  const cv = pg.comp(rootGo, 'MonoBehaviour', 'Poker.Game.CardView');
  const cvf = cv ? fields(pg, cv).fields : null;
  const meshFilterTf = (() => { const stack = [rootTf]; while (stack.length) { const t = stack.shift(); const go = pg.goOf(t); if (go.body.m_IsActive !== '0' && pg.comp(go, 'MeshFilter') && pg.comp(go, 'MeshRenderer')) return t; stack.push(...pg.childTfs(t)); } return null; })();
  // matrix from card root to the mesh node (root's own TRS excluded: CardView drives it at runtime)
  let toRoot = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const chain = [];
  for (let t = meshFilterTf; t && t !== rootTf; t = pg.parentTf(t)) chain.unshift(t);
  for (const t of chain) { const l = pg.local(t); toRoot = M.mul(toRoot, M.trs(l.position, l.rotation, l.scale)); }

  // library
  const libDoc = loadDocs(libraryRel).find((d) => d.type === 'MonoBehaviour').body;
  const fbxRel = assetPath(libDoc.entries?.[0]?.Mesh);
  const fbx = fbxSummary(fbxRel);
  // Unity mesh sub-asset fileIDs are hashes; map them to FBX node names through the full Card.prefab,
  // whose 52 children are named after the cards and reference the same meshes.
  const meshNames = new Map();
  for (const rel of ['Assets/Test/Card.prefab', prefabRel]) {
    if (!fs.existsSync(abs(rel))) continue;
    const gg = new Graph(rel);
    for (const o of gg.objects.values()) if (o.type === 'MeshFilter' && o.body.m_Mesh?.guid && !meshNames.has(String(o.body.m_Mesh.fileID))) meshNames.set(String(o.body.m_Mesh.fileID), gg.nameOf(o));
  }
  const RANKS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
  const SUITS = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];
  const entries = (libDoc.entries ?? []).map((e, i) => {
    const faceRel = assetPath(e.Face);
    const fm = material(faceRel);
    const meshName = meshNames.get(String(e.Mesh.fileID)) ?? null;
    const model = fbx?.models.find((m) => m.name === meshName);
    return {
      index: i, card: `${RANKS[i % 13]} of ${SUITS[Math.floor(i / 13)]}`, rank: (i % 13) + 2, suit: Math.floor(i / 13),
      meshFileID: String(e.Mesh.fileID), fbxNode: meshName, fbxNodeMatches: !!model, fbxMaterialSlots: model?.materials ?? null,
      faceMaterial: faceRel, faceTexture: fm?.textures?._MainTex?.texture ?? null,
    };
  });
  const back = material(assetPath(libDoc.back)), edge = material(assetPath(libDoc.edge)), folded = material(assetPath(libDoc.folded));

  // physical size: FBX geometry bounds * file scale (X mirrored by Unity's handedness conversion), through the prefab hierarchy
  let size = null;
  const anyModel = fbx?.models.find((m) => m.geometryBounds);
  if (anyModel) {
    const s = fbx.fileScale * fbx.globalScale;
    const mn = anyModel.geometryBounds.boundsMin, mx = anyModel.geometryBounds.boundsMax;
    const meshMin = [-mx[0] * s, mn[1] * s, mn[2] * s], meshMax = [-mn[0] * s, mx[1] * s, mx[2] * s];
    const corners = [];
    for (const x of [meshMin[0], meshMax[0]]) for (const y of [meshMin[1], meshMax[1]]) for (const z of [meshMin[2], meshMax[2]]) corners.push(M.point(toRoot, [x, y, z]));
    const bmin = [0, 1, 2].map((a) => Math.min(...corners.map((c) => c[a]))), bmax = [0, 1, 2].map((a) => Math.max(...corners.map((c) => c[a])));
    const rootScale = pg.local(rootTf).scale;
    size = {
      meshSpaceBounds: { min: r6(meshMin), max: r6(meshMax), note: 'Unity mesh space = FBX vertices * fileScale * globalScale, X negated (Unity right->left-handed import)' },
      fbxVertexBounds: anyModel.geometryBounds,
      cardRootSpaceBounds: { min: r6(bmin), max: r6(bmax), size: r6(V.sub(bmax, bmin)), center: r6(V.scale(V.add(bmin, bmax), 0.5)) },
      worldSizeAtRootScale: r6(V.sub(bmax, bmin).map((v, a) => v * rootScale[a])),
      note: 'card-root space at identity root rotation (= faceDownLocalEuler 0,0,0): X = width, Y = thickness, Z = length. The root scale is applied in worldSizeAtRootScale.',
    };
  }
  const textures = [...new Set([back, edge, folded, ...entries.map((e) => material(e.faceMaterial))].flatMap((m) => Object.values(m?.textures ?? {}).map((t) => t.texture)))];
  return {
    prefab: prefabRel,
    prefabIsVariantOf: (() => { const pi = loadDocs(prefabRel).find((d) => d.type === 'PrefabInstance' && String(d.body.m_Modification?.m_TransformParent?.fileID) === '0'); return pi ? assetPath(pi.body.m_SourcePrefab) : null; })(),
    rootName: rootGo.body.m_Name,
    rootLocal: (({ position, rotation, scale }) => ({ position: r6(position), rotation: r6(rotation), euler: Q.toEuler(rotation), scale: r6(scale) }))(pg.local(rootTf)),
    rootScale: r6(pg.local(rootTf).scale),
    faceUpLocalEuler: cvf ? [cvf.faceUpLocalEuler.x, cvf.faceUpLocalEuler.y, cvf.faceUpLocalEuler.z] : [0, 0, 180],
    faceDownLocalEuler: cvf ? [cvf.faceDownLocalEuler.x, cvf.faceDownLocalEuler.y, cvf.faceDownLocalEuler.z] : [0, 0, 0],
    cardView: cvf,
    rootComponents: pg.comps(rootGo).filter((c) => c.type === 'MonoBehaviour').map((c) => fields(pg, c)),
    meshNodePath: meshFilterTf ? pg.pathOf(meshFilterTf) : null,
    meshNodeToRootMatrix: r6(toRoot),
    hierarchy: pg.tree(rootTf),
    mesh: { model: fbxRel, fbx: fbx ? { version: fbx.version, globalSettings: fbx.globalSettings, fileScale: fbx.fileScale, importSettings: fbx.importSettings, nodeCount: fbx.models.length, materialNames: fbx.materials } : null },
    library: {
      asset: libraryRel,
      mapping: 'entries[Card.Index], Card.Index = suit*13 + (rank-2); suit Clubs=0 Diamonds=1 Hearts=2 Spades=3; rank Two=2..Ace=14. CardView sets MeshFilter.sharedMesh = entry.Mesh and sharedMaterials = [library.back (slot 0), entry.Face (slot 1), library.edge (slot 2)]; folded seats use library.folded on all 3 slots. A theme may swap the back texture at runtime (CardLibrary.ApplyBackTexture).',
      back, edge, folded,
      entries,
    },
    size,
    textures,
  };
}

/** A world-space canvas: root rect + every UI Image below it with world-space corners. */
function worldCanvas(g, tf) {
  const canvas = g.comp(g.goOf(tf), 'Canvas');
  const rect = (t) => {
    const b = t.body;
    const size = g.rectSize(t);
    const pv = [num(b.m_Pivot?.x, 0.5), num(b.m_Pivot?.y, 0.5)];
    const w = g.world(t);
    const lo = [-pv[0] * size[0], -pv[1] * size[1]], hi = [(1 - pv[0]) * size[0], (1 - pv[1]) * size[1]];
    // Unity GetWorldCorners order: bottom-left, top-left, top-right, bottom-right
    const corners = [[lo[0], lo[1]], [lo[0], hi[1]], [hi[0], hi[1]], [hi[0], lo[1]]].map(([x, y]) => r6(M.point(w.matrix, [x, y, 0])));
    return { rectSize: r6(size), pivot: pv, anchorMin: [num(b.m_AnchorMin?.x), num(b.m_AnchorMin?.y)], anchorMax: [num(b.m_AnchorMax?.x), num(b.m_AnchorMax?.y)], anchoredPosition: [num(b.m_AnchoredPosition?.x), num(b.m_AnchoredPosition?.y)], sizeDelta: [num(b.m_SizeDelta?.x), num(b.m_SizeDelta?.y)], worldPosition: r6(w.position), worldRotation: r6(w.rotation), worldEuler: Q.toEuler(w.rotation), lossyScale: r6(w.lossyScale), worldMatrix: r6(w.matrix), worldCorners: corners };
  };
  const images = [];
  const walk = (t) => {
    const go = g.goOf(t);
    const img = g.comp(go, 'MonoBehaviour', 'UnityEngine.UI.Image');
    if (img) {
      const b = img.body;
      images.push({ path: g.pathOf(t), activeInHierarchy: g.activeInHierarchy(t), enabled: b.m_Enabled !== '0', sprite: spriteInfo(b.m_Sprite), color: col(b.m_Color), type: num(b.m_Type), preserveAspect: b.m_PreserveAspect === '1', material: isNullRef(b.m_Material) ? null : material(assetPath(b.m_Material)), ...rect(t) });
    }
    for (const c of g.childTfs(t)) walk(c);
  };
  walk(tf);
  const other = g.comps(g.goOf(tf)).filter((c) => c.type === 'MonoBehaviour' && !/Canvas|Raycaster|SeatView/.test(c.body.m_EditorClassIdentifier ?? '')).map((c) => fields(g, c));
  const animator = g.comp(g.goOf(tf), 'Animator');
  return { path: g.pathOf(tf), renderMode: num(canvas?.body?.m_RenderMode), sortingOrder: num(canvas?.body?.m_SortingOrder), ...rect(tf), images, animator: animator ? { controller: assetPath(animator.body.m_Controller), enabled: animator.body.m_Enabled !== '0' } : null, components: other };
}

/** Every MM*Shaker listener (the targets MMF_*Shake feedbacks broadcast to, by channel). */
function shakerListeners(g) {
  return [...g.objects.values()].filter((o) => o.type === 'MonoBehaviour' && /MoreMountains\..*(Shaker|Wiggle)$/.test(o.body.m_EditorClassIdentifier ?? '')).map((o) => ({
    class: o.body.m_EditorClassIdentifier.split('::').pop(), path: g.pathOf(g.tfOf(o)), enabled: o.body.m_Enabled !== '0', channelMode: num(o.body.ChannelMode), channel: num(o.body.Channel),
    fields: fields(g, o).fields,
  }));
}

function postProcessProfile(rel) {
  if (!rel || !fs.existsSync(abs(rel))) return rel ? { path: rel, missing: true } : null;
  const docs = loadDocs(rel);
  const effects = docs.filter((d) => d.type === 'MonoBehaviour' && d.fileID !== '11400000').map((d) => {
    const b = d.body;
    const settings = {};
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && 'overrideState' in v) settings[k] = { override: v.overrideState === '1', value: numify(v.value) };
    }
    return { effect: (b.m_EditorClassIdentifier || '').split('::').pop() || b.m_Name, active: b.active === '1', enabled: settings.enabled?.value === 1, settings };
  });
  return { path: rel, effects };
}

// =============================================================================================
// Documentation embedded in the JSON so the web side has the exact formulas next to the data.

const SEMANTICS = {
  source: 'Library/PackageCache/com.unity.splines@*/Runtime (package 2.8.4), Assets/Scripts/Game/Views/CardView.cs, SplineCardDealer.cs',
  curve: 'Curve i of an open spline joins knot i -> i+1. P0 = k_i.Position; P1 = k_i.Position + rotate(k_i.Rotation, k_i.TangentOut); P2 = k_{i+1}.Position + rotate(k_{i+1}.Rotation, k_{i+1}.TangentIn); P3 = k_{i+1}.Position (BezierCurve(BezierKnot a, BezierKnot b)). Tangents are knot-local, rotated by the knot rotation. Serialized tangents are used as-is (AutoSmooth is only re-applied when a knot is edited). Cubic Bernstein: P(t) = P0(1-t)^3 + 3P1 t(1-t)^2 + 3P2 t^2(1-t) + P3 t^3; tangent = dP/dt (NOT normalised).',
  curveLength: 'Per curve: polyline through 30 samples at t = i/29 (LUT {distance, t}). Spline length = sum of curve lengths. SplineAnimate uses the LOCAL (container-space) length; SplineContainer.CalculateLength() (used by the return flight) uses the WORLD length (knots transformed first). Identical here (lossy scale 1).',
  splineT: 'SplineUtility.SplineToCurveT(t): t is normalised by ARC LENGTH over the whole spline, not by curve count. d = clamp01(t) * length; walk curves until d <= start + curveLength; curveT = LUT lookup: find first LUT entry with distance > (d - start), lerp t between it and the previous entry. If no curve matched, curveT = 1 on the last curve.',
  containerTransform: 'SplineContainer.EvaluatePosition = transform.TransformPoint(local); EvaluateTangent = transform.TransformVector(local); EvaluateUpVector = transform.TransformDirection(local) (rotation only). With non-uniform lossy scale Unity instead evaluates a NativeSpline baked in world space (not the case here).',
  upVector: 'Spline.GetCurveUpVector(curve, t): per curve a cache of 30 up vectors at t = i/29 computed by CurveUtility.EvaluateUpVector(curve, i/29, startUp = rotate(k_i.Rotation, Y), endUp = rotate(k_{i+1}.Rotation, Y)); result = Vector3.Lerp (NOT normalised, not slerp) between cache[i] and cache[i+1]. EvaluateUpVector builds 16 rotation-minimising frames (double reflection, Wang et al.) along the curve starting from frame {tangent = P1-P0, normal = startUp, binormal = normalize(cross(tangent, normal))}, then distributes the twist between the last RMF normal and endUp linearly in t: angle = acos(dot(lastNormal, endUp)), sign chosen so rotating endUp by it about the last tangent lands on lastNormal; normal_i rotated by AxisAngle(normalize(tangent(t_i)), -lerp(0, angle, t_i)); answer = Slerp between the two bracketing adjusted normals (normal[0] stays startUp). Zero-length tangents are replaced by (P3-P0)/3 first. If tangent || startUp the up is (0,0,0).',
  splineAnimate: 'CardView.DealAlongSpline: SplineAnimate { Method.Speed, MaxSpeed = dealSpeed, Easing = EaseInOut, Alignment = SplineElement, Loop = Once, ObjectForwardAxis = Z, ObjectUpAxis = Y (defaults) }. Path = SplinePath over ALL container splines (1 here). duration = 2 * lengthLocal / MaxSpeed for any easing (lengthLocal / MaxSpeed with EasingMode.None). Each frame: elapsed += dt; u = min(elapsed, duration) / duration; u = EaseInOutQuadratic(u) = (u <= 0.5 ? 2u^2 : 4u - 2u^2 - 1) [EaseIn = u^2, EaseOut = u(2-u)]; position = EvaluatePosition(path, u) (u is the arc-length normalised spline t). Completed fires once u >= 1. Restart(false) first snaps to u = 0.',
  splineElementRotation: 'forward = EvaluateTangent(u) (world); if |forward| <= epsilon use tangent at u+0.01 (or u-0.01 at the end); forward normalised; up = EvaluateUpVector(u) (world); rotation = Quaternion.LookRotation(forward, up) * Inverse(LookRotation(Z, Y)) = LookRotation(forward, up). LookRotation: f = normalize(forward); r = normalize(cross(up, f)); u = cross(f, r); basis columns (r, u, f). The card ROOT transform gets this rotation (the card model children keep their own local transforms).',
  afterDeal: 'On Completed: CardView.Flip(revealAtEnd) = DOLocalRotateQuaternion(settle, 0.25s) with NO explicit ease -> DOTween default ease from Assets/Resources/DOTweenSettings.asset: defaultEaseType 6 = Ease.OutQuad. settle = Quaternion.Euler(faceUp ? faceUpLocalEuler : faceDownLocalEuler) with its Y replaced by atan2(forward.x, forward.z) of the landed card (heading kept; only tilt/roll corrected). The card is parented under PokerController/DealtCards (identity-ish parent), so local ~ world.',
  returnFlight: 'CardView.ReturnAlongSpline: SplineAnimate disabled; DOTween.Sequence: Flip(false) [0.25s, OutQuad] then DOVirtual.Float(1 -> 0, lengthWorld / dealSpeed, Ease.InOutQuad) setting position = spline.EvaluatePosition(t) and, if |tangent|^2 > 1e-4, rotation = LookRotation(EvaluateTangent(t), EvaluateUpVector(t)) (first spline of the container, same arc-length t mapping). Note the tangent still points deck->seat, so the card flies BACKWARDS (tail first) on the return. Sequence default ease is Linear. Cards leave in reverse deal order, delay = order * holeStagger * 0.5.',
  dealOrder: 'SplineCardDealer.DealHoleCards: card0 along holeCardSpline0 with delay 0, card1 along holeCardSpline1 with delay holeStagger (DOVirtual.DelayedCall). The card spawns at EvaluatePosition(0) face-down (Show(card,false)) until its deal starts.',
  dotweenEase: 'DOTween OutQuad: f(x) = 1 - (1-x)^2 ; InOutQuad: x < 0.5 ? 2x^2 : 1 - (-2x+2)^2/2.',
};

const ANIM_SEMANTICS = {
  curves: 'Unity AnimationCurve, non-weighted keys (weightedMode 0): cubic Hermite between key a and b: dt = b.time - a.time; s = (t - a.time)/dt; m0 = a.outSlope*dt; m1 = b.inSlope*dt; v = (2s^3-3s^2+1)a.value + (s^3-2s^2+s)m0 + (-2s^3+3s^2)b.value + (s^3-s^2)m1. If a.outSlope or b.inSlope is +/-Infinity the segment is constant (stepped) at a.value. Weighted keys (weightedMode != 0) use a Bezier with inWeight/outWeight as the tangent lengths (fraction of dt).',
  playback: 'Vector curves (m_PositionCurves / m_EulerCurves / m_ScaleCurves) are what the runtime plays; m_EditorCurves are the per-component editor copies of the same data (useful to cross-check). m_EulerCurves are interpolated per component in degrees (so 360 -> 1980 spins 4.5 turns) then converted with Quaternion.Euler in m_RotationOrder (4 = ZXY, Unity default: q = qY*qX*qZ). Paths are relative to the GameObject carrying the Animator (the Slot_N root). Properties not animated keep their scene value; clip time beyond the last key clamps (PreInfinity/PostInfinity 2 = Clamp for wrapMode 0 / non-looping).',
  animator: 'Each Slot_N has an Animator with Slot_N.controller: default state Slot_0N (no transitions). SplineCardDealer.DealCommunity does SetActive(true) on the slot -> the Animator restarts at its default state at t = 0. WithdrawCommunityCards calls animator.Play("Slot_0N_Withdrawal", 0, 0f). Clear() deactivates the slot. Write Defaults is on.',
};

// =============================================================================================
// Assets

function copyAssets(scene) {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const items = new Map(); // src rel -> description
  const skipped = new Map(); // referenced only by inactive objects: listed, not copied
  const add = (rel, what, active = true) => {
    if (!rel || rel.startsWith('builtin') || rel.startsWith('missing') || !fs.existsSync(abs(rel))) return;
    if (!active) { if (!items.has(rel) && !skipped.has(rel)) skipped.set(rel, what); return; }
    skipped.delete(rel);
    if (!items.has(rel)) items.set(rel, what);
  };
  const card = scene.card;
  add(card.mesh.model, 'Card mesh model (52 card meshes, one node per card: "<Rank> of <Suit>"; 3 material slots: back / face / edge). Unity imports with fileScale ' + card.mesh.fbx?.fileScale + ' and X mirrored.');
  for (const [k, m] of Object.entries({ back: card.library.back, edge: card.library.edge, folded: card.library.folded })) for (const t of Object.values(m?.textures ?? {})) add(t.texture, `Card ${k} texture (material ${m.path})`);
  for (const e of card.library.entries) add(e.faceTexture, `Card face: ${e.card} (index ${e.index}, material ${e.faceMaterial})`);
  for (const o of scene.table.objects) {
    const tag = o.activeInHierarchy ? '' : ' (INACTIVE in Test.unity)';
    if (o.mesh?.asset && !o.mesh.asset.startsWith('builtin')) add(o.mesh.asset, `Mesh of scene object ${o.path}${tag}`, o.activeInHierarchy);
    if (o.sprite?.texture) add(o.sprite.texture, `Sprite of scene object ${o.path}${tag}`, o.activeInHierarchy);
    for (const m of o.materials ?? []) for (const [slot, t] of Object.entries(m?.textures ?? {})) add(t.texture, `${slot} of material ${m.path} on ${o.path}${tag}`, o.activeInHierarchy);
  }
  for (const im of scene.table.tableCanvas?.images ?? []) if (im.sprite?.texture) add(im.sprite.texture, 'Table felt sprite (UI Image ' + im.path + ')', im.activeInHierarchy);
  for (const s of scene.communitySlots) {
    // active nodes only: the slot card's 51 inactive siblings are leftovers; CardView swaps mesh/materials from the library
    const walk = (n) => { if (!n.active) return; for (const c of n.components ?? []) { for (const m of c.materials ?? []) { const mm = material(m); for (const [slot, t] of Object.entries(mm?.textures ?? {})) add(t.texture, `${slot} of material ${m} inside ${s.name} (pre-placed card; replaced from the library at runtime)`); } } for (const k of n.children ?? []) walk(k); };
    walk(s.hierarchy);
  }
  const rows = [];
  let total = 0;
  const usedNames = new Map();
  for (const [rel, what] of items) {
    let name = path.basename(rel);
    const prev = usedNames.get(name.toLowerCase());
    if (prev && prev !== rel) name = path.basename(path.dirname(rel)) + '__' + name;
    usedNames.set(name.toLowerCase(), rel);
    // The FBX is not loaded at runtime (card-mesh.json is): export-card-mesh.mjs reads it from the Unity project.
    if (/\.fbx$/i.test(rel)) continue;
    fs.copyFileSync(abs(rel), path.join(ASSET_DIR, name));
    const bytes = fs.statSync(abs(rel)).size;
    total += bytes;
    rows.push({ name, rel, what, bytes });
  }
  // unused alternatives in the same folders, listed but not copied
  const notCopied = [];
  const dirs = new Set([...items.keys()].filter((r) => /Textures\/|\/Cards\//.test(r)).map((r) => path.dirname(r)));
  for (const d of dirs) for (const f of fs.readdirSync(abs(d))) {
    if (f.endsWith('.meta')) continue;
    const rel = `${d}/${f}`;
    if (!items.has(rel) && fs.statSync(abs(rel)).isFile()) notCopied.push({ rel, bytes: fs.statSync(abs(rel)).size });
  }
  const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
  const md = [
    '# 3D assets for the web table',
    '',
    'Copied from the Unity project by `node web/tools/extract-unity-scene.mjs --copy` (original filenames kept;',
    'a folder prefix is added only on a name clash). Scene data that references these files: `web/src/data/unity-scene.json`.',
    '',
    `Total copied: ${rows.length} files, ${mb(total)}.`,
    '',
    '| File | Unity source | What it is | Size |',
    '|---|---|---|---|',
    ...rows.map((r) => `| \`${r.name}\` | \`${r.rel}\` | ${r.what} | ${mb(r.bytes)} |`),
    '',
    '## Notes',
    '',
    '- Card faces map to card indices through `card.library.entries` in unity-scene.json (Card.Index = suit*13 + rank-2; Clubs, Diamonds, Hearts, Spades).',
    '- The card FBX is binary FBX 7.4 authored in inches (UnitScaleFactor 2.54); Unity scales it by `fileScale` (0.0254) and mirrors X. three.js FBXLoader does not apply the unit scale — apply it yourself (see `card.size`). It is not copied here: `tools/export-card-mesh.mjs` reads it from the Unity project and writes `src/data/card-mesh.json`, which is what the web loads.',
    '- Materials are Built-in Standard shader; colours/floats per material are in unity-scene.json.',
    '- Textures are the source files; Unity may downsize them on import (`maxTextureSize` in each texture\'s import info). The web build ships them as WebP at 1024 px (see the generated section below).',
    '',
    '## Not copied: referenced only by INACTIVE objects in Test.unity',
    '',
    ...(skipped.size ? [...skipped].map(([rel, what]) => `- \`${rel}\` (${mb(fs.statSync(abs(rel)).size)}): ${what}`) : ['- none']),
    '',
    '## Not copied: other files in the card texture folders (not referenced by the table scene)',
    '',
    ...(notCopied.length ? notCopied.map((n) => `- \`${n.rel}\` (${mb(n.bytes)})`) : ['- none']),
    '',
  ];
  fs.writeFileSync(path.join(ASSET_DIR, 'MANIFEST.md'), md.join('\n'));
  return { files: rows.length, totalBytes: total };
}

// =============================================================================================
// Sanity checks (printed)

function sanity(scene) {
  const lines = [];
  for (const s of scene.splines) {
    const a = s.card0, b = s.card1;
    if (!a || !b) { lines.push(`seat ${s.seat}: missing spline(s)`); continue; }
    const d0 = a.knotWorld[0], d1 = b.knotWorld[0];
    const e0 = a.knotWorld.at(-1), e1 = b.knotWorld.at(-1);
    lines.push(`seat ${s.seat} ${String(s.slotName).padEnd(26)} ${a.name}/${b.name}  start ${fmt(d0)} | ${fmt(d1)}  end ${fmt(e0)} | ${fmt(e1)}  ends ${V.len(V.sub(e0, e1)).toFixed(3)} apart  len ${a.lengthWorld.toFixed(2)}/${b.lengthWorld.toFixed(2)}  seatRoot ${s.seatRootName} ${fmt(s.seatRootWorldPosition ?? [0, 0, 0])}`);
  }
  for (const c of scene.communitySlots) lines.push(`${c.name} world ${fmt(c.worldPosition)} paths ${c.animatedPaths.map((p) => p.path + (p.resolved ? '' : ' (UNRESOLVED)')).join(', ')} card=${c.cardViewPath}`);
  lines.push(`camera ${fmt(scene.camera.worldPosition)} euler ${scene.camera.worldEuler} fov ${scene.camera.fieldOfView} ortho ${scene.camera.orthographic}`);
  lines.push(`dealer dealSpeed ${scene.dealer.dealSpeed} holeStagger ${scene.dealer.holeStagger}; river feedbacks ${scene.dealer.riverSlamFeedback?.feedbacks.length}`);
  lines.push(`card size (root space) ${scene.card.size ? fmt(scene.card.size.cardRootSpaceBounds.size) : 'n/a'}; library entries ${scene.card.library.entries.length}, unmatched fbx nodes ${scene.card.library.entries.filter((e) => !e.fbxNodeMatches).length}`);
  return lines.join('\n');
}
const fmt = (v) => '(' + v.map((x) => x.toFixed(3)).join(', ') + ')';

// =============================================================================================

async function main() {
  const { scene, anims } = extract();
  fs.mkdirSync(path.dirname(OUT_SCENE), { recursive: true });
  fs.writeFileSync(OUT_SCENE, JSON.stringify(scene, null, 1));
  fs.writeFileSync(OUT_ANIMS, JSON.stringify(anims, null, 1));
  console.log(`wrote ${path.relative(ROOT, OUT_SCENE)} (${(fs.statSync(OUT_SCENE).size / 1024).toFixed(0)} KB)`);
  console.log(`wrote ${path.relative(ROOT, OUT_ANIMS)} (${(fs.statSync(OUT_ANIMS).size / 1024).toFixed(0)} KB)`);
  if (process.argv.includes('--copy')) {
    const r = copyAssets(scene);
    await optimizeAssets({ dirs: ['3d'] }); // WebP, card textures right-sized (the 3D loaders map Unity basenames to .webp)
    console.log(`copied ${r.files} asset files (${(r.totalBytes / 1048576).toFixed(1)} MB) to ${path.relative(ROOT, ASSET_DIR)}`);
  }
  console.log(sanity(scene));
  if (warnings.length) console.log(`\n${warnings.length} warning(s):\n- ` + warnings.join('\n- '));
}

export { flattenFile, Graph, Q, V, M, readSpline, clip, controller };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
