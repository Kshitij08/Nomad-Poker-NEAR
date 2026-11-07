// Extracts the pot token piles (PotView denominations) for the web 3D layer.
//
// Each denomination is a Token_N prefab (Token_2..6 are variants of Token_1 that swap the coin sprite):
//   Token_N (root)
//     Plane   — Unity's built-in 10×10 plane, rotated 180° about Y, Token.mat (Standard, cutout) with 010.png
//       colour — SpriteRenderer, rotated 90° about X, the coin sprite (Token_colour.mat: Standard, cutout)
// The PotView settings and denomination parents come from unity-hud.json (already extracted from Test.unity);
// the parents' world positions from unity-scene.json (table.tokenParents).
//
//   node web/tools/extract-unity-tokens.mjs   →  web/src/data/pot-tokens.json + web/public/assets/tokens/*.png

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUnityYaml, num, vec3, quat } from './unity-yaml.mjs';
import { decodePng, resizeRgba, encodePng } from './lib/png.mjs';
import { optimizeAssets } from './optimize-assets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '../..');
const outJson = path.join(here, '../src/data/pot-tokens.json');
const outDir = path.join(here, '../public/assets/tokens');
const MAX_PX = 512; // the coin PNGs are ~4000 px; they cover ~0.3 world units on screen

const hud = JSON.parse(fs.readFileSync(path.join(here, '../src/data/unity-hud.json'), 'utf8'));
const scene = JSON.parse(fs.readFileSync(path.join(here, '../src/data/unity-scene.json'), 'utf8'));

// ---- GUID → asset path (only the folders the tokens use) ----
const guidToPath = new Map();
function indexGuids(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) indexGuids(p);
    else if (e.name.endsWith('.meta')) {
      const m = /guid: ([0-9a-f]{32})/.exec(fs.readFileSync(p, 'utf8'));
      if (m) guidToPath.set(m[1], path.relative(repo, p.slice(0, -5)).replaceAll('\\', '/'));
    }
  }
}
indexGuids(path.join(repo, 'Assets/Test'));

// ---- PotView settings ----
function findPotView(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.denominations && o.flyDuration !== undefined) return o;
  for (const v of Object.values(o)) {
    const r = findPotView(v);
    if (r) return r;
  }
  return null;
}
const pv = findPotView(hud);
if (!pv) throw new Error('PotView fields not found in unity-hud.json');

// ---- Token_1 (base prefab) ----
const docs = (p) => readUnityYaml(path.join(repo, p));
const base = docs('Assets/Test/Prefabs/Token_1.prefab');
const byId = new Map(base.map((d) => [d.fileID, d]));
const goName = (goId) => byId.get(String(goId))?.body.m_Name;
const transforms = base.filter((d) => d.type === 'Transform');
const tf = (name) => {
  const t = transforms.find((d) => goName(d.body.m_GameObject.fileID) === name);
  return { position: vec3(t.body.m_LocalPosition), rotation: quat(t.body.m_LocalRotation), scale: vec3(t.body.m_LocalScale) };
};
const spriteRenderer = base.find((d) => d.type === 'SpriteRenderer');
const planeRenderer = base.find((d) => d.type === 'MeshRenderer');
const matGuid = (r) => r.body.m_Materials[0].guid;

function material(guid) {
  const mat = docs(guidToPath.get(guid))[0].body;
  const floats = Object.fromEntries((mat.m_SavedProperties.m_Floats ?? []).flatMap((e) => Object.entries(e)).map(([k, v]) => [k, num(v)]));
  const texEntries = (mat.m_SavedProperties.m_TexEnvs ?? []).flatMap((e) => Object.entries(e));
  const mainTex = texEntries.find(([k]) => k === '_MainTex')?.[1]?.m_Texture?.guid;
  return { path: guidToPath.get(guid), cutoff: floats._Cutoff ?? 0.5, glossiness: floats._Glossiness ?? 0.5, metallic: floats._Metallic ?? 0, mode: floats._Mode ?? 0, mainTexture: mainTex ? guidToPath.get(mainTex) : null };
}

fs.mkdirSync(outDir, { recursive: true });
function exportTexture(assetPath) {
  const img = decodePng(fs.readFileSync(path.join(repo, assetPath)));
  const k = Math.min(1, MAX_PX / Math.max(img.width, img.height));
  const out = k < 1 ? resizeRgba(img, Math.round(img.width * k), Math.round(img.height * k)) : img;
  const name = path.basename(assetPath);
  fs.writeFileSync(path.join(outDir, name), encodePng(out));
  return { file: name, source: assetPath, sourcePixels: [img.width, img.height], exportedPixels: [out.width, out.height] };
}

// Sprite world size = source pixels / pixelsPerUnit (pivot centre for every coin sprite here).
function spriteInfo(guid) {
  const p = guidToPath.get(guid);
  const meta = fs.readFileSync(path.join(repo, p + '.meta'), 'utf8');
  const ppu = num(/spritePixelsToUnits: ([0-9.]+)/.exec(meta)?.[1], 100);
  const tex = exportTexture(p);
  return { ...tex, pixelsPerUnit: ppu, worldSize: [tex.sourcePixels[0] / ppu, tex.sourcePixels[1] / ppu] };
}

const planeMat = material(matGuid(planeRenderer));
const coinMat = material(matGuid(spriteRenderer));
const planeTexture = exportTexture(planeMat.mainTexture);

const denominations = pv.denominations.map((d) => {
  const prefabPath = d.prefab.asset;
  const prefab = docs(prefabPath);
  const inst = prefab.find((x) => x.type === 'PrefabInstance');
  let spriteGuid = spriteRenderer.body.m_Sprite.guid;
  if (inst) {
    const mod = inst.body.m_Modification.m_Modifications.find((m) => m.propertyPath === 'm_Sprite');
    if (mod) spriteGuid = mod.objectReference.guid;
  }
  const parentName = d.parent.path.split('/').pop();
  const parent = scene.table.tokenParents.children.find((c) => c.name === parentName);
  return { value: num(d.value), prefab: prefabPath, parent: d.parent.path, parentLocalPosition: parent.localPosition, coin: spriteInfo(spriteGuid) };
});

const result = {
  source: 'Assets/Test/Test.unity PotView + Assets/Test/Prefabs/Token_*.prefab',
  settings: {
    maxTokens: num(pv.maxTokens),
    tokenSpacing: num(pv.tokenSpacing),
    tokenJitter: num(pv.tokenJitter),
    flyDuration: num(pv.flyDuration),
    flyStagger: num(pv.flyStagger),
    flyEndScale: num(pv.flyEndScale),
  },
  tokenParents: { name: scene.table.tokenParents.name, worldPosition: scene.table.tokenParents.localPosition, note: 'root object: local = world' },
  prefab: {
    root: tf(goName(base.find((d) => d.type === 'GameObject' && d.body.m_Name === 'Token_1').fileID) ?? 'Token_1'),
    plane: { ...tf('Plane'), mesh: 'builtin Plane: 10×10 in XZ, normal +Y', material: planeMat, texture: planeTexture },
    colour: { ...tf('colour'), material: coinMat, spriteColor: spriteRenderer.body.m_Color, note: 'Standard shader ignores the SpriteRenderer colour (no vertex colour)' },
  },
  denominations,
};
fs.writeFileSync(outJson, JSON.stringify(result, null, 1));
console.log(`wrote ${outJson}`);
console.log(JSON.stringify({ settings: result.settings, plane: result.prefab.plane.material, coins: denominations.map((d) => [d.value, d.coin.file, d.coin.worldSize]) }, null, 1));

// WebP + right-size what was just copied (or, without copying, point the JSON at the existing WebP files).
await optimizeAssets({ dirs: ['tokens'], convert: true });
