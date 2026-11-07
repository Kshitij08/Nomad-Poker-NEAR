// Exports the card mesh from "Card Deck.FBX" as Unity would import it, for the web 3D layer.
//
// Unity's FBX import (this model: useFileScale, fileScale 0.0254, bakeAxisConversion off) yields mesh
// vertices = FBX vertices * 0.0254 with X negated, and reverses triangle winding to compensate for the
// mirror. Each polygon's material index becomes a submesh; submeshes are ordered by material index and
// map 1:1 onto the MeshRenderer's material slots (CardView: 0 back, 1 face, 2 edge).
//
// All 52 card nodes share the same shape; only the face material differs, so one mesh is exported.
//
//   node web/tools/export-card-mesh.mjs  ->  web/src/data/card-mesh.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFbx, child, childrenNamed, fbxName } from './fbx-binary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fbxPath = path.join(here, '../public/assets/3d/Card Deck.FBX');
const outPath = path.join(here, '../src/data/card-mesh.json');
const NODE = process.argv[2] ?? 'Ace of Spades'; // a node whose submeshes are back, face, edge like the CardView slots
const SCALE = 0.0254;

const fbx = readFbx(fbxPath);
const top = (n) => fbx.nodes.find((x) => x.name === n);
const objects = top('Objects');
const conns = childrenNamed(top('Connections'), 'C').map((c) => ({ kind: c.props[0], from: c.props[1], to: c.props[2] }));
const model = childrenNamed(objects, 'Model').find((m) => fbxName(m.props[1]) === NODE);
if (!model) throw new Error(`no model ${NODE}`);
const geomId = conns.find((c) => c.kind === 'OO' && c.to === model.props[0] && childrenNamed(objects, 'Geometry').some((g) => g.props[0] === c.from))?.from;
const geom = childrenNamed(objects, 'Geometry').find((g) => g.props[0] === geomId);

const verts = Array.from(child(geom, 'Vertices').props[0]);
const pvi = Array.from(child(geom, 'PolygonVertexIndex').props[0]);

function layer(name, dataName, indexName) {
  const l = child(geom, name);
  if (!l) return null;
  const mapping = child(l, 'MappingInformationType').props[0];
  const reference = child(l, 'ReferenceInformationType').props[0];
  const data = Array.from(child(l, dataName).props[0]);
  const index = child(l, indexName)?.props[0] ? Array.from(child(l, indexName).props[0]) : null;
  return { mapping, reference, data, index };
}
const uvL = layer('LayerElementUV', 'UV', 'UVIndex');
const nL = layer('LayerElementNormal', 'Normals', 'NormalsIndex');
const mL = child(geom, 'LayerElementMaterial');
const matMapping = child(mL, 'MappingInformationType').props[0];
const matIdx = Array.from(child(mL, 'Materials').props[0]);

function fetch(l, size, polyVertex, vertex) {
  if (!l) return null;
  let i = l.mapping === 'ByVertice' || l.mapping === 'ByVertex' ? vertex : polyVertex;
  if (l.reference === 'IndexToDirect') i = l.index[i];
  return l.data.slice(i * size, i * size + size);
}

// Walk polygons, fan-triangulate, convert to Unity mesh space.
const groups = new Map(); // material index -> triangles [{p,n,uv}x3]
let polyVertex = 0;
let polyIndex = 0;
let poly = [];
for (let k = 0; k < pvi.length; k++) {
  const raw = pvi[k];
  const end = raw < 0;
  const vi = end ? ~raw : raw;
  const p = verts.slice(vi * 3, vi * 3 + 3);
  const n = fetch(nL, 3, polyVertex, vi) ?? [0, 0, 1];
  const uv = fetch(uvL, 2, polyVertex, vi) ?? [0, 0];
  poly.push({ p: [-p[0] * SCALE, p[1] * SCALE, p[2] * SCALE], n: [-n[0], n[1], n[2]], uv });
  polyVertex++;
  if (end) {
    const mat = matMapping === 'AllSame' ? matIdx[0] : matIdx[polyIndex];
    if (!groups.has(mat)) groups.set(mat, []);
    for (let j = 1; j + 1 < poly.length; j++) {
      // Reversed winding (X was mirrored).
      groups.get(mat).push(poly[0], poly[j + 1], poly[j]);
    }
    poly = [];
    polyIndex++;
  }
}

const position = [];
const normal = [];
const uv = [];
const submeshes = [];
for (const mat of [...groups.keys()].sort((a, b) => a - b)) {
  const tris = groups.get(mat);
  submeshes.push({ fbxMaterialIndex: mat, start: position.length / 3, count: tris.length });
  for (const v of tris) {
    position.push(...v.p.map((x) => +x.toFixed(6)));
    normal.push(...v.n.map((x) => +x.toFixed(5)));
    uv.push(...v.uv.map((x) => +x.toFixed(6)));
  }
}

fs.writeFileSync(
  outPath,
  JSON.stringify({
    source: 'Assets/Test/Model/Card Deck.FBX',
    node: NODE,
    space: 'Unity mesh space (left-handed): FBX * 0.0254, X negated, winding reversed',
    submeshes,
    position,
    normal,
    uv,
  }),
);
console.log(`wrote ${outPath}: ${position.length / 3} vertices, submeshes`, submeshes);
