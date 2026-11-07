// Tiny dependency-free reader for binary FBX (7.x). Only what the extractor needs: the node tree,
// GlobalSettings, Model nodes (names + Lcl transforms) and Geometry vertex bounds.

import fs from 'node:fs';
import zlib from 'node:zlib';

export function readFbx(path) {
  const buf = fs.readFileSync(path);
  const magic = buf.toString('latin1', 0, 20);
  if (!magic.startsWith('Kaydara FBX Binary')) throw new Error(`${path}: not a binary FBX`);
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500;
  let off = 27;
  const nodes = [];
  for (;;) {
    const [node, next] = readNode(buf, off, wide);
    if (!node) break;
    nodes.push(node);
    off = next;
  }
  return { version, nodes };
}

function readNode(buf, off, wide) {
  const end = wide ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
  const numProps = wide ? Number(buf.readBigUInt64LE(off + 8)) : buf.readUInt32LE(off + 4);
  const hdr = wide ? 24 : 12;
  const nameLen = buf.readUInt8(off + hdr);
  if (end === 0) return [null, off + hdr + 1];
  const name = buf.toString('latin1', off + hdr + 1, off + hdr + 1 + nameLen);
  let p = off + hdr + 1 + nameLen;
  const props = [];
  for (let i = 0; i < numProps; i++) {
    const t = String.fromCharCode(buf[p]); p++;
    switch (t) {
      case 'Y': props.push(buf.readInt16LE(p)); p += 2; break;
      case 'C': props.push(!!buf[p]); p += 1; break;
      case 'I': props.push(buf.readInt32LE(p)); p += 4; break;
      case 'F': props.push(buf.readFloatLE(p)); p += 4; break;
      case 'D': props.push(buf.readDoubleLE(p)); p += 8; break;
      case 'L': props.push(buf.readBigInt64LE(p)); p += 8; break;
      case 'S': case 'R': {
        const len = buf.readUInt32LE(p); p += 4;
        props.push(t === 'S' ? buf.toString('latin1', p, p + len) : buf.subarray(p, p + len));
        p += len; break;
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const len = buf.readUInt32LE(p), enc = buf.readUInt32LE(p + 4), clen = buf.readUInt32LE(p + 8);
        p += 12;
        let data = buf.subarray(p, p + clen);
        p += clen;
        if (enc === 1) data = zlib.inflateSync(data);
        const arr = [];
        const sz = { f: 4, d: 8, l: 8, i: 4, b: 1 }[t];
        for (let k = 0; k < len; k++) {
          const o = k * sz;
          arr.push(t === 'f' ? data.readFloatLE(o) : t === 'd' ? data.readDoubleLE(o) : t === 'l' ? Number(data.readBigInt64LE(o)) : t === 'i' ? data.readInt32LE(o) : data[o]);
        }
        props.push(arr); break;
      }
      default: throw new Error(`FBX: unknown property type ${t} at ${p - 1}`);
    }
  }
  const children = [];
  while (p < end) {
    const [child, next] = readNode(buf, p, wide);
    p = next;
    if (!child) break;
    children.push(child);
  }
  return [{ name, props, children }, end];
}

export const child = (n, name) => n?.children.find((c) => c.name === name);
export const childrenNamed = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);

/** Properties70 -> { name: [values...] } */
export function props70(n) {
  const out = {};
  for (const p of childrenNamed(child(n, 'Properties70'), 'P')) out[p.props[0]] = p.props.slice(4);
  return out;
}

/** Strip the "Name\x00\x01Class" FBX object-name convention. */
export const fbxName = (s) => String(s).split('\x00\x01')[0];

/** Summary used by the extractor. */
export function summarizeFbx(path) {
  const fbx = readFbx(path);
  const top = (name) => fbx.nodes.find((n) => n.name === name);
  const gs = props70(child(top('GlobalSettings'), 'Properties70') ? top('GlobalSettings') : null);
  const objects = top('Objects');
  const connections = childrenNamed(top('Connections'), 'C').map((c) => ({ kind: c.props[0], from: c.props[1], to: c.props[2], prop: c.props[3] }));
  const models = new Map();
  const geoms = new Map();
  const mats = new Map();
  for (const o of objects?.children ?? []) {
    const id = o.props[0];
    if (o.name === 'Model') {
      const p = props70(o);
      models.set(id, {
        name: fbxName(o.props[1]),
        type: o.props[2],
        lclTranslation: p['Lcl Translation'] ?? [0, 0, 0],
        lclRotation: p['Lcl Rotation'] ?? [0, 0, 0],
        lclScaling: p['Lcl Scaling'] ?? [1, 1, 1],
        preRotation: p['PreRotation'] ?? null,
        rotationOrder: p['RotationOrder']?.[0] ?? 0,
      });
    } else if (o.name === 'Geometry') {
      const v = child(o, 'Vertices')?.props[0] ?? [];
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < v.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[k + a]); max[a] = Math.max(max[a], v[k + a]); }
      const matLayer = child(o, 'LayerElementMaterial');
      const matIdx = child(matLayer, 'Materials')?.props[0] ?? [];
      geoms.set(id, { name: fbxName(o.props[1]), vertexCount: v.length / 3, polygonIndexCount: (child(o, 'PolygonVertexIndex')?.props[0] ?? []).length, boundsMin: min, boundsMax: max, materialSlots: [...new Set(matIdx)].sort((a, b) => a - b) });
    } else if (o.name === 'Material') {
      mats.set(id, fbxName(o.props[1]));
    }
  }
  // connect geometry/materials -> model
  for (const c of connections) {
    if (c.kind !== 'OO') continue;
    if (geoms.has(c.from) && models.has(c.to)) models.get(c.to).geometry = geoms.get(c.from).name, models.get(c.to).geometryId = c.from;
    if (mats.has(c.from) && models.has(c.to)) (models.get(c.to).materials ??= []).push(mats.get(c.from));
    if (models.has(c.from)) models.get(c.from).parentId = c.to;
  }
  const modelList = [...models.entries()].map(([id, m]) => ({ ...m, parent: m.parentId && models.has(m.parentId) ? models.get(m.parentId).name : null, geometryBounds: m.geometryId ? (({ boundsMin, boundsMax, vertexCount }) => ({ boundsMin, boundsMax, vertexCount }))(geoms.get(m.geometryId)) : undefined, parentId: undefined, geometryId: undefined }));
  return {
    version: fbx.version,
    globalSettings: {
      UpAxis: gs.UpAxis?.[0], UpAxisSign: gs.UpAxisSign?.[0], FrontAxis: gs.FrontAxis?.[0], FrontAxisSign: gs.FrontAxisSign?.[0],
      CoordAxis: gs.CoordAxis?.[0], CoordAxisSign: gs.CoordAxisSign?.[0], UnitScaleFactor: gs.UnitScaleFactor?.[0], OriginalUnitScaleFactor: gs.OriginalUnitScaleFactor?.[0],
    },
    models: modelList,
    materials: [...mats.values()],
  };
}
