#!/usr/bin/env node
// Extracts the table-screen 2D HUD from the Unity project so the web port can match it 1:1.
//
//   node web/tools/extract-unity-hud.mjs [--no-copy]
//
// Reads (never writes) Assets/. Writes:
//   web/src/data/unity-hud.json      RectTransform trees of every table canvas + theme overrides
//   web/src/data/ui-anims.json       UI animation clips as keyframes + animator controllers
//   web/public/assets/ui/**          sprites (sheets copied whole; rects/borders in unity-hud.json)
//   web/public/assets/fonts/**       source .ttf/.otf behind each TMP font asset
//   web/public/assets/ui/MANIFEST.md file -> Unity source -> where used
//
// Dependency-free (Node 22). Unity YAML parsing + prefab resolution live in ./lib/unity-yaml.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnityProject, buildHierarchy, normId, parseUnityFile, readMeta, imageSize } from './lib/unity-yaml.mjs';
import { decodePng, resizeRgba, encodePng } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const SCENE = 'Assets/Test/Test.unity';
const OUT_HUD = path.join(WEB, 'src/data/unity-hud.json');
const OUT_ANIMS = path.join(WEB, 'src/data/ui-anims.json');
const OUT_UI = path.join(WEB, 'public/assets/ui');
const OUT_FONTS = path.join(WEB, 'public/assets/fonts');
const COPY = !process.argv.includes('--no-copy');
// PNGs are written at EXPORT_MULT x the size Unity actually imports them at (capped at the source size):
// Unity downsizes to the platform maxTextureSize, so this keeps the look while staying crisp on hi-DPI.
const EXPORT_MULT = 2;
// Longest-side caps on top of that. Reaction emotes are authored at 1920px but never drawn above ~360 canvas units.
const EXPORT_CAP = 1024;
const EXPORT_CAP_BY_DIR = { 'Assets/Chat Ui/Poker emotes/': 512 };

// Screen-canvas children that are not part of the table HUD during a hand (or are replaced at runtime).
const EXCLUDE_CHILDREN = {
  'Canvas/Splash_Screen': 'boot splash, not shown on the table',
  'Canvas/Settings_Panel': 'NomadTableHud.TakeOverSettings replaces it with the Nomad Settings dialog',
};
// Requested UI clips (Assets/Test/Animations). Clips reachable from HUD animators are added automatically.
const REQUESTED_CLIPS = [
  'Name_Graphics_In', 'Name_Graphics_In_Right', 'Name_Graphics_Shake', 'Bot_Name', 'Timer', 'WinMedal_PopIn',
  'PotBar_Normal', 'PotBar_Highlighted', 'PotBar_Pressed', 'PotBar_Selected', 'PotBar_Disabled',
  'UI_Btn_Normal', 'UI_Btn_Highlighted', 'UI_Btn_Pressed', 'UI_Btn_Disabled',
  'Card_Shake_Left', 'Card_Shake_Right', 'Card_Scale', 'Left_Rotate', 'ConfirmPanel_In', 'Botton_name_Bar',
  'Face/Face_Happy', 'Face/Face_LookLeft', 'Face/Face_LookRight', 'Face/Face_Neutral', 'Face/Face_Sad',
  'Face/Face_Smiley', 'Face/Face_VeryHappy', 'Face/Face_Wink',
];

// Well-known package script GUIDs, used when Library/PackageCache is absent.
const KNOWN_SCRIPTS = {
  fe87c0e1cc204ed48ad3b37840f39efc: 'Image', '4e29b1a8efbd4b44bb3f3716e73f07ff': 'Button',
  '0cd44c1031e13a943bb63640046fad76': 'CanvasScaler', dc42784cf147c0c48a680349fa168899: 'GraphicRaycaster',
  f4688fdb7df04437aeb418b961361dc5: 'TextMeshProUGUI', '5f7201a12d95ffc409449d95f23cf332': 'Text',
  '67db9e8f0e2ae9c40bc1e2b64352a6b4': 'Slider', '31a19414c41e5ae4aae2af33fee712f6': 'Mask',
  '3312d7739989d2b4e91e6319e9a96d76': 'RectMask2D', '30649d3a9faa99c48a7b1166b86bf2a0': 'HorizontalLayoutGroup',
  '59f8146938fff824cb5fd77236b75775': 'VerticalLayoutGroup', '8a8695521f0d02e499659fee002a26c2': 'GridLayoutGroup',
  '3245ec927659c4140ac4f8d17403cc18': 'ContentSizeFitter', '306cc8c2b49d7114eaa3623786fc2126': 'LayoutElement',
  '1344c3c82d62a2a41a3576d8abb8e3ea': 'RawImage', '2a4db7a114972834c8e4117be1d82ba3': 'Toggle',
  '1aa08ab6e0800fa44ae55d278d1423e3': 'ScrollRect', e19747de3f5aca642ab2be37e372fb86: 'Outline',
  cfabb0440166ab443bba8876756fdfa9: 'Shadow', '2da0c512f12947e489f739169773d7ca': 'TMP_InputField',
};
const BUILTIN_SPRITES = { 10905: 'UISprite', 10907: 'Background', 10909: 'InputFieldBackground', 10911: 'Knob', 10913: 'Checkmark', 10915: 'DropdownArrow', 10917: 'UIMask' };
const CLASS_NAMES = { 1: 'GameObject', 4: 'Transform', 224: 'RectTransform', 114: 'MonoBehaviour', 225: 'CanvasGroup', 222: 'CanvasRenderer', 223: 'Canvas', 212: 'SpriteRenderer', 23: 'MeshRenderer', 95: 'Animator', 198: 'ParticleSystem', 108: 'Light', 20: 'Camera' };

// ------------------------------------------------------------------------------------------ helpers

const P = new UnityProject(ROOT);
const num = (v, d = 0) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : (v === 'Infinity' ? 'Infinity' : v === '-Infinity' ? '-Infinity' : d); };
const r4 = (n) => (typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : n);
const v2 = (o) => [r4(num(o?.x)), r4(num(o?.y))];
const v3 = (o) => [r4(num(o?.x)), r4(num(o?.y)), r4(num(o?.z))];
const v4 = (o) => [r4(num(o?.x)), r4(num(o?.y)), r4(num(o?.z)), r4(num(o?.w, 1))];
const q7 = (o) => [num(o?.x), num(o?.y), num(o?.z), num(o?.w, 1)].map((v) => Math.round(v * 1e7) / 1e7);
const hex2 = (f) => Math.max(0, Math.min(255, Math.round(f * 255))).toString(16).padStart(2, '0');
function color(c) {
  if (!c) return null;
  const r = num(c.r, 1), g = num(c.g, 1), b = num(c.b, 1), a = num(c.a, 1);
  return { hex: '#' + hex2(r) + hex2(g) + hex2(b) + (a < 1 ? hex2(a) : ''), rgba: [r4(r), r4(g), r4(b), r4(a)] };
}
function color32(v) { // TMP m_fontColor32 rgba uint (ABGR little-endian)
  const n = Number(v); if (!Number.isFinite(n)) return null;
  return color({ r: (n & 255) / 255, g: ((n >>> 8) & 255) / 255, b: ((n >>> 16) & 255) / 255, a: ((n >>> 24) & 255) / 255 });
}
const isNullRef = (r) => !r || normId(r.fileID) === '0';
const rel = (p) => P.rel(p);
function quatToEuler(q) { // Unity ZXY order, degrees
  const [x, y, z, w] = q;
  const sinX = 2 * (w * x - y * z);
  if (Math.abs(sinX) > 0.99999) return [Math.sign(sinX) * 90, r4((2 * Math.atan2(y, w) * 180) / Math.PI) || 0, 0]; // gimbal lock
  const ex = Math.asin(sinX) * 180 / Math.PI;
  const ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) * 180 / Math.PI;
  const ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI;
  return [r4(ex), r4(ey), r4(ez)];
}
function trsMatrix(t, q, s) { // column-major 4x4
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function matMul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function decompose(m) {
  const t = [m[12], m[13], m[14]];
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  // rotation matrix (column-major r[col*3+row]) -> quaternion
  const m00 = r[0], m10 = r[1], m20 = r[2], m01 = r[3], m11 = r[4], m21 = r[5], m02 = r[6], m12 = r[7], m22 = r[8];
  const tr = m00 + m11 + m22; let q;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S]; }
  return { position: t.map(r4), rotation: q.map((v) => Math.round(v * 1e7) / 1e7), scale: [sx, sy, sz].map((v) => Math.round(v * 1e8) / 1e8) };
}

// ------------------------------------------------------------------------------------------ scene

console.log('Indexing GUIDs + resolving scene prefabs…');
const sceneFile = path.join(ROOT, SCENE);
const objs = P.resolve(sceneFile);
const { gos } = buildHierarchy(objs);

function scriptName(c) {
  if (c.classId !== 114) return c.type || CLASS_NAMES[c.classId] || ('class' + c.classId);
  const g = c.data.m_Script?.guid;
  if (KNOWN_SCRIPTS[g]) return KNOWN_SCRIPTS[g];
  const p = g && P.pathOf(g);
  return p ? path.basename(p).replace(/\.cs$/, '') : 'MonoBehaviour(' + g + ')';
}
function scriptPath(c) { const g = c.data.m_Script?.guid; return g && P.pathOf(g) ? rel(P.pathOf(g)) : null; }
const nodePath = (g) => { const a = []; while (g) { a.unshift(g.go.data.m_Name); g = g.parent; } return a.join('/'); };
const compOwner = new Map(); // component id -> GO node
for (const [, g] of gos) for (const c of g.components) compOwner.set(c.id, g);
function refTarget(ref) {
  if (isNullRef(ref)) return null;
  if (ref.guid) { const p = P.pathOf(ref.guid); return { asset: p ? rel(p) : ref.guid, fileID: ref.fileID }; }
  const id = normId(ref.fileID);
  if (gos.has(id)) return { path: nodePath(gos.get(id)) };
  const owner = compOwner.get(id);
  if (owner) { const c = owner.components.find((x) => x.id === id); return { path: nodePath(owner), component: scriptName(c) }; }
  const o = objs.get(id);
  return o ? { scene: o.type + ':' + id } : { missing: id };
}

// ------------------------------------------------------------------------------------------ sprites

const sprites = {}; // key -> info
const spriteUse = new Map(); // key -> Set(paths)
const textureCopies = new Map(); // abs src -> web path
function webAssetPath(abs, base) {
  const r = rel(abs).replace(/^Assets\//, '');
  return base + '/' + r.split('/').map((s) => s.replace(/[^A-Za-z0-9._()-]+/g, '_')).join('/');
}
function spriteRef(ref, usedAt) {
  if (isNullRef(ref)) return null;
  const guid = ref.guid, fid = normId(ref.fileID);
  const key = guid + ':' + fid;
  if (!sprites[key]) sprites[key] = describeSprite(guid, fid);
  if (usedAt) { if (!spriteUse.has(key)) spriteUse.set(key, new Set()); spriteUse.get(key).add(usedAt); }
  return key;
}
function describeSprite(guid, fid) {
  if (guid === '0000000000000000f000000000000000') {
    const n = BUILTIN_SPRITES[+fid] || 'builtin' + fid;
    return { name: n, builtin: true, file: null, note: 'Unity built-in UI sprite (unity_builtin_extra) — not copyable; UISprite/Background are 32x32 white rounded rects with 10px 9-slice borders.', border: n === 'UISprite' || n === 'Background' || n === 'InputFieldBackground' ? [10, 10, 10, 10] : [0, 0, 0, 0], ppu: 100 };
  }
  const abs = P.pathOf(guid);
  if (!abs) return { name: null, missing: true, guid };
  const meta = readMeta(abs) || {};
  const ti = meta.TextureImporter || {};
  const size = imageSize(abs);
  const ppu = num(ti.spritePixelsToUnits, 100);
  const info = { name: path.basename(abs, path.extname(abs)), unity: rel(abs), file: null, texture: size ? [size.w, size.h] : null, ppu, spriteMode: num(ti.spriteMode, 1) };
  // Unity imports at the platform max size (WebGL override, else the Default tab), keeping aspect.
  const plats = ti.platformSettings || [];
  const web = plats.find((p) => p.buildTarget === 'WebGL' && p.overridden === '1');
  const def = plats.find((p) => p.buildTarget === 'DefaultTexturePlatform');
  const effMax = num((web || def || {}).maxTextureSize, num(ti.maxTextureSize, 2048));
  const ext = path.extname(abs).toLowerCase();
  if (size) {
    const longest = Math.max(size.w, size.h);
    const sImp = Math.min(1, effMax / longest);
    info.unityImport = { maxTextureSize: effMax, size: [Math.round(size.w * sImp), Math.round(size.h * sImp)] };
    const cap = Object.entries(EXPORT_CAP_BY_DIR).find(([d]) => rel(abs).startsWith(d))?.[1] ?? EXPORT_CAP;
    info.exportScale = ext === '.png' ? Math.min(1, Math.min(EXPORT_MULT * effMax, cap) / longest) : 1;
    info.exportSize = [Math.round(size.w * info.exportScale), Math.round(size.h * info.exportScale)];
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
    info.file = webAssetPath(abs, 'assets/ui');
    textureCopies.set(abs, { file: info.file, scale: info.exportScale ?? 1, size: info.exportSize });
  } else {
    info.file = null;
    info.note = `source is ${ext} — not browser-native, needs manual export`;
  }
  const sheet = ti.spriteSheet?.sprites || [];
  let entry = null;
  if (fid !== '21300000' || num(ti.spriteMode, 1) === 2) {
    entry = sheet.find((s) => normId(s.internalID) === fid);
    if (!entry) {
      const tbl = ti.internalIDToNameTable || [];
      for (const t of tbl) { const k = t.first && Object.values(t.first)[0]; if (normId(k) === fid) { entry = sheet.find((s) => s.name === t.second); break; } }
    }
    if (!entry) {
      const legacy = ti.fileIDToRecycleName || {};
      if (legacy[fid]) entry = sheet.find((s) => s.name === legacy[fid]);
    }
  }
  const H = size ? size.h : null;
  const toBorder = (b) => [num(b?.x), num(b?.y), num(b?.z), num(b?.w)]; // left, bottom, right, top
  if (entry) {
    const rr = entry.rect || {};
    const rect = [num(rr.x), num(rr.y), num(rr.width), num(rr.height)];
    info.subSprite = entry.name;
    info.name = entry.name;
    info.rect = rect;
    if (H) info.rectTopLeft = [rect[0], H - rect[1] - rect[3], rect[2], rect[3]];
    info.border = toBorder(entry.border);
    info.pivot = v2(entry.pivot);
  } else {
    info.rect = size ? [0, 0, size.w, size.h] : null;
    info.rectTopLeft = info.rect;
    info.border = toBorder(ti.spriteBorder);
    info.pivot = v2(ti.spritePivot || { x: 0.5, y: 0.5 });
  }
  if (info.exportScale !== undefined && info.exportScale < 1) {
    const s = info.exportScale;
    if (info.rectTopLeft) info.rectExported = info.rectTopLeft.map((v) => r4(v * s));
    info.borderExported = info.border.map((v) => r4(v * s));
  }
  return info;
}

// ------------------------------------------------------------------------------------------ fonts + TMP materials

const fonts = {}; // font asset guid -> info
const materials = {}; // guid:fileID -> info
const fontCopies = new Map();
function fontAsset(ref) {
  if (isNullRef(ref) || !ref.guid) return null;
  const guid = ref.guid;
  if (fonts[guid]) return guid;
  const abs = P.pathOf(guid);
  const info = { unity: abs ? rel(abs) : null };
  fonts[guid] = info;
  if (!abs) return guid;
  if (/\.(ttf|otf)$/i.test(abs)) { info.sourceFont = rel(abs); info.file = webAssetPath(abs, 'assets/fonts'); fontCopies.set(abs, info.file); return guid; }
  const docs = parseUnityFile(abs, { skipClasses: [28] });
  const fa = docs.find((d) => d.classId === 114 && (d.data.m_FaceInfo || d.data.m_fontInfo));
  if (fa) {
    const d = fa.data;
    info.name = d.m_Name;
    const fi = d.m_FaceInfo || {};
    info.faceInfo = { familyName: fi.m_FamilyName, styleName: fi.m_StyleName, pointSize: num(fi.m_PointSize), scale: num(fi.m_Scale, 1), lineHeight: num(fi.m_LineHeight), ascentLine: num(fi.m_AscentLine), descentLine: num(fi.m_DescentLine), capLine: num(fi.m_CapLine), meanLine: num(fi.m_MeanLine), baseline: num(fi.m_Baseline), underlineOffset: num(fi.m_UnderlineOffset) };
    info.atlas = { width: num(d.m_AtlasWidth), height: num(d.m_AtlasHeight), padding: num(d.m_AtlasPadding), renderMode: num(d.m_AtlasRenderMode), populationMode: num(d.m_AtlasPopulationMode) };
    const srcGuid = d.m_SourceFontFile?.guid || d.m_SourceFontFileGUID || d.fontAssetCreationSettings?.sourceFontFileGUID || d.m_CreationSettings?.sourceFontFileGUID;
    const src = srcGuid && P.pathOf(srcGuid);
    if (src) { info.sourceFont = rel(src); info.file = webAssetPath(src, 'assets/fonts'); fontCopies.set(src, info.file); }
    else info.note = 'source font file not found in project';
    info.fallbacks = (d.m_FallbackFontAssetTable || []).filter((r) => !isNullRef(r)).map((r) => { fontAsset(r); return r.guid; });
    const mat = docs.find((x) => x.classId === 21);
    if (mat) info.defaultMaterial = materialRef({ fileID: mat.fileId, guid });
  }
  return guid;
}
function materialRef(ref) {
  if (isNullRef(ref) || !ref.guid) return null;
  const key = ref.guid + ':' + normId(ref.fileID);
  if (materials[key]) return key;
  const abs = P.pathOf(ref.guid);
  const info = { unity: abs ? rel(abs) : null };
  materials[key] = info;
  if (!abs) return key;
  const docs = /\.mat$/.test(abs) ? parseUnityFile(abs) : parseUnityFile(abs, { skipClasses: [28, 114] });
  const m = docs.find((d) => d.classId === 21 && (d.fileId === normId(ref.fileID) || /\.mat$/.test(abs)));
  if (!m) return key;
  const d = m.data;
  info.name = d.m_Name;
  const sh = d.m_Shader?.guid && P.pathOf(d.m_Shader.guid);
  info.shader = sh ? path.basename(sh) : d.m_Shader?.fileID;
  const kw = (d.m_ValidKeywords && Array.isArray(d.m_ValidKeywords) ? d.m_ValidKeywords : String(d.m_ShaderKeywords || '').split(/\s+/)).filter(Boolean);
  info.keywords = kw;
  const floats = {}; for (const f of d.m_SavedProperties?.m_Floats || []) Object.assign(floats, f);
  const cols = {}; for (const c of d.m_SavedProperties?.m_Colors || []) Object.assign(cols, c);
  const pickF = (k) => (k in floats ? r4(num(floats[k])) : undefined);
  info.face = { color: color(cols._FaceColor), dilate: pickF('_FaceDilate'), softness: pickF('_OutlineSoftness') };
  info.outline = { enabled: kw.includes('OUTLINE_ON') || (pickF('_OutlineWidth') || 0) > 0, width: pickF('_OutlineWidth'), color: color(cols._OutlineColor) };
  info.underlay = { enabled: kw.includes('UNDERLAY_ON') || kw.includes('UNDERLAY_INNER'), inner: kw.includes('UNDERLAY_INNER'), color: color(cols._UnderlayColor), offsetX: pickF('_UnderlayOffsetX'), offsetY: pickF('_UnderlayOffsetY'), dilate: pickF('_UnderlayDilate'), softness: pickF('_UnderlaySoftness') };
  info.glow = { enabled: kw.includes('GLOW_ON'), color: color(cols._GlowColor), offset: pickF('_GlowOffset'), inner: pickF('_GlowInner'), outer: pickF('_GlowOuter'), power: pickF('_GlowPower') };
  info.gradientScale = pickF('_GradientScale');
  info.scaleRatioA = pickF('_ScaleRatioA');
  return key;
}

// ------------------------------------------------------------------------------------------ components

const H_ALIGN = { 1: 'left', 2: 'center', 4: 'right', 8: 'justified', 16: 'flush', 32: 'geometry' };
const V_ALIGN = { 256: 'top', 512: 'middle', 1024: 'bottom', 2048: 'baseline', 4096: 'geometry', 8192: 'capline' };
const IMAGE_TYPE = ['Simple', 'Sliced', 'Tiled', 'Filled'];
const FILL_METHOD = ['Horizontal', 'Vertical', 'Radial90', 'Radial180', 'Radial360'];
const TRANSITION = ['None', 'ColorTint', 'SpriteSwap', 'Animation'];
const OVERFLOW = ['Overflow', 'Ellipsis', 'Masking', 'Truncate', 'ScrollRect', 'Page', 'Linked'];
const TEXT_ANCHOR = ['UpperLeft', 'UpperCenter', 'UpperRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'LowerLeft', 'LowerCenter', 'LowerRight'];
const controllersUsed = new Set();
const SKIP_FIELDS = new Set(['m_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_Name', 'm_EditorClassIdentifier']);

function fieldsOf(c) { // shallow serialized fields of a project MonoBehaviour, refs resolved
  const out = {};
  const conv = (v) => {
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object') { if ('fileID' in v) return refTarget(v); const o = {}; for (const k of Object.keys(v)) o[k] = conv(v[k]); return o; }
    return v;
  };
  for (const [k, v] of Object.entries(c.data)) if (!SKIP_FIELDS.has(k)) out[k] = conv(v);
  return out;
}

function imageComp(c, at) {
  const d = c.data;
  return {
    enabled: d.m_Enabled !== '0', sprite: spriteRef(d.m_Sprite, at), color: color(d.m_Color),
    type: IMAGE_TYPE[num(d.m_Type)] || d.m_Type, preserveAspect: d.m_PreserveAspect === '1', fillCenter: d.m_FillCenter !== '0',
    fillMethod: FILL_METHOD[num(d.m_FillMethod)], fillAmount: r4(num(d.m_FillAmount, 1)), fillClockwise: d.m_FillClockwise !== '0', fillOrigin: num(d.m_FillOrigin),
    pixelsPerUnitMultiplier: r4(num(d.m_PixelsPerUnitMultiplier, 1)), useSpriteMesh: d.m_UseSpriteMesh === '1', raycastTarget: d.m_RaycastTarget !== '0',
    material: isNullRef(d.m_Material) ? null : refTarget(d.m_Material),
  };
}
function tmpComp(c) {
  const d = c.data;
  let h = num(d.m_HorizontalAlignment, 0), v = num(d.m_VerticalAlignment, 0);
  if (!h && d.m_textAlignment && d.m_textAlignment !== '65535') { const a = num(d.m_textAlignment); h = a & 0xff; v = a & 0xff00; }
  const style = num(d.m_fontStyle);
  const styles = []; ['bold', 'italic', 'underline', 'lowercase', 'uppercase', 'smallcaps', 'strikethrough', 'superscript', 'subscript', 'highlight'].forEach((n, i) => { if (style & (1 << i)) styles.push(n); });
  const out = {
    enabled: d.m_Enabled !== '0', text: d.m_text ?? '', font: fontAsset(d.m_fontAsset), material: materialRef(d.m_sharedMaterial),
    fontSize: r4(num(d.m_fontSize)), autoSize: d.m_enableAutoSizing === '1', fontSizeMin: r4(num(d.m_fontSizeMin)), fontSizeMax: r4(num(d.m_fontSizeMax)),
    fontStyle: styles, fontWeight: num(d.m_fontWeight, 400), color: color(d.m_fontColor) || color32(d.m_fontColor32?.rgba),
    vertexGradient: d.m_enableVertexGradient === '1' ? { topLeft: color(d.m_fontColorGradient?.topLeft), topRight: color(d.m_fontColorGradient?.topRight), bottomLeft: color(d.m_fontColorGradient?.bottomLeft), bottomRight: color(d.m_fontColorGradient?.bottomRight), colorMode: num(d.m_colorMode) } : null,
    gradientPreset: isNullRef(d.m_fontColorGradientPreset) ? null : refTarget(d.m_fontColorGradientPreset),
    alignH: H_ALIGN[h] || h, alignV: V_ALIGN[v] || v,
    wrapping: d.m_TextWrappingMode !== undefined ? num(d.m_TextWrappingMode) !== 0 : d.m_enableWordWrapping === '1',
    overflow: OVERFLOW[num(d.m_overflowMode)] || d.m_overflowMode,
    characterSpacing: r4(num(d.m_characterSpacing)), wordSpacing: r4(num(d.m_wordSpacing)), lineSpacing: r4(num(d.m_lineSpacing)), paragraphSpacing: r4(num(d.m_paragraphSpacing)),
    margin: v4(d.m_margin), marginOrder: 'left,top,right,bottom', richText: d.m_isRichText !== '0', rightToLeft: d.m_isRightToLeft === '1', raycastTarget: d.m_RaycastTarget !== '0',
    spriteAsset: isNullRef(d.m_spriteAsset) ? null : refTarget(d.m_spriteAsset),
  };
  if (d.m_Color && color(d.m_Color).hex !== '#ffffff') out.graphicColor = color(d.m_Color);
  return out;
}
function legacyTextComp(c) {
  const d = c.data, f = d.m_FontData || {};
  const fp = f.m_Font?.guid && P.pathOf(f.m_Font.guid);
  if (fp && /\.(ttf|otf)$/i.test(fp)) fontCopies.set(fp, webAssetPath(fp, 'assets/fonts'));
  return { enabled: d.m_Enabled !== '0', text: d.m_Text ?? '', font: fp ? rel(fp) : (f.m_Font?.fileID === '10102' ? 'builtin:LegacyRuntime/Arial' : null), fontFile: fp && /\.(ttf|otf)$/i.test(fp) ? webAssetPath(fp, 'assets/fonts') : null, fontSize: num(f.m_FontSize), fontStyle: num(f.m_FontStyle), bestFit: f.m_BestFit === '1', minSize: num(f.m_MinSize), maxSize: num(f.m_MaxSize), alignment: TEXT_ANCHOR[num(f.m_Alignment)], richText: f.m_RichText !== '0', lineSpacing: num(f.m_LineSpacing, 1), color: color(d.m_Color) };
}
function selectableBase(d) {
  const cs = d.m_Colors || {};
  return {
    interactable: d.m_Interactable !== '0', transition: TRANSITION[num(d.m_Transition)] || d.m_Transition,
    colors: { normal: color(cs.m_NormalColor), highlighted: color(cs.m_HighlightedColor), pressed: color(cs.m_PressedColor), selected: color(cs.m_SelectedColor), disabled: color(cs.m_DisabledColor), colorMultiplier: num(cs.m_ColorMultiplier, 1), fadeDuration: num(cs.m_FadeDuration, 0.1) },
    spriteState: { highlighted: spriteRef(d.m_SpriteState?.m_HighlightedSprite), pressed: spriteRef(d.m_SpriteState?.m_PressedSprite), selected: spriteRef(d.m_SpriteState?.m_SelectedSprite), disabled: spriteRef(d.m_SpriteState?.m_DisabledSprite) },
    animationTriggers: d.m_AnimationTriggers ? { normal: d.m_AnimationTriggers.m_NormalTrigger, highlighted: d.m_AnimationTriggers.m_HighlightedTrigger, pressed: d.m_AnimationTriggers.m_PressedTrigger, selected: d.m_AnimationTriggers.m_SelectedTrigger, disabled: d.m_AnimationTriggers.m_DisabledTrigger } : null,
    targetGraphic: refTarget(d.m_TargetGraphic),
  };
}
function onClickCalls(d) {
  return (d.m_OnClick?.m_PersistentCalls?.m_Calls || []).map((k) => ({ target: refTarget(k.m_Target), method: k.m_MethodName, arg: k.m_Arguments?.m_StringArgument || k.m_Arguments?.m_IntArgument }));
}

function describeComponents(g, at) {
  const out = {};
  const others = [];
  for (const c of g.components) {
    if (c.classId === 4 || c.classId === 224 || c.classId === 222) continue;
    const n = scriptName(c);
    const d = c.data;
    switch (n) {
      case 'Image': out.image = imageComp(c, at); break;
      case 'RawImage': out.rawImage = { texture: refTarget(d.m_Texture), color: color(d.m_Color), uvRect: d.m_UVRect }; break;
      case 'TextMeshProUGUI': case 'TextMeshPro': out.text = tmpComp(c); break;
      case 'Text': out.legacyText = legacyTextComp(c); break;
      case 'Button': out.button = { ...selectableBase(d), onClick: onClickCalls(d) }; break;
      case 'Toggle': out.toggle = { ...selectableBase(d), isOn: d.m_IsOn === '1', graphic: refTarget(d.graphic) }; break;
      case 'Slider': out.slider = { ...selectableBase(d), direction: ['LeftToRight', 'RightToLeft', 'BottomToTop', 'TopToBottom'][num(d.m_Direction)], min: num(d.m_MinValue), max: num(d.m_MaxValue, 1), value: num(d.m_Value), wholeNumbers: d.m_WholeNumbers === '1', fillRect: refTarget(d.m_FillRect), handleRect: refTarget(d.m_HandleRect) }; break;
      case 'Animator': {
        const cp = d.m_Controller?.guid && P.pathOf(d.m_Controller.guid);
        if (cp) controllersUsed.add(cp);
        out.animator = { enabled: d.m_Enabled !== '0', controller: cp ? rel(cp) : null, updateMode: ['Normal', 'AnimatePhysics', 'UnscaledTime'][num(d.m_UpdateMode)], cullingMode: num(d.m_CullingMode), keepStateOnDisable: d.m_KeepAnimatorStateOnDisable === '1' };
        break;
      }
      case 'CanvasGroup': out.canvasGroup = { enabled: d.m_Enabled !== '0', alpha: r4(num(d.m_Alpha, 1)), interactable: d.m_Interactable !== '0', blocksRaycasts: d.m_BlocksRaycasts !== '0', ignoreParentGroups: d.m_IgnoreParentGroups === '1' }; break;
      case 'Mask': out.mask = { enabled: d.m_Enabled !== '0', showMaskGraphic: d.m_ShowMaskGraphic !== '0' }; break;
      case 'RectMask2D': out.rectMask2D = { enabled: d.m_Enabled !== '0', padding: v4(d.m_Padding), softness: d.m_Softness }; break;
      case 'HorizontalLayoutGroup': case 'VerticalLayoutGroup': case 'GridLayoutGroup':
        out.layoutGroup = { kind: n, enabled: d.m_Enabled !== '0', padding: d.m_Padding ? { left: num(d.m_Padding.m_Left), right: num(d.m_Padding.m_Right), top: num(d.m_Padding.m_Top), bottom: num(d.m_Padding.m_Bottom) } : null, spacing: d.m_Spacing && typeof d.m_Spacing === 'object' ? v2(d.m_Spacing) : num(d.m_Spacing), childAlignment: TEXT_ANCHOR[num(d.m_ChildAlignment)], reverse: d.m_ReverseArrangement === '1', controlW: d.m_ChildControlWidth === '1', controlH: d.m_ChildControlHeight === '1', expandW: d.m_ChildForceExpandWidth === '1', expandH: d.m_ChildForceExpandHeight === '1', scaleW: d.m_ChildScaleWidth === '1', scaleH: d.m_ChildScaleHeight === '1', cellSize: d.m_CellSize ? v2(d.m_CellSize) : undefined, constraint: d.m_Constraint, constraintCount: d.m_ConstraintCount };
        break;
      case 'ContentSizeFitter': out.contentSizeFitter = { horizontal: ['Unconstrained', 'MinSize', 'PreferredSize'][num(d.m_HorizontalFit)], vertical: ['Unconstrained', 'MinSize', 'PreferredSize'][num(d.m_VerticalFit)] }; break;
      case 'LayoutElement': out.layoutElement = { ignoreLayout: d.m_IgnoreLayout === '1', minWidth: num(d.m_MinWidth, -1), minHeight: num(d.m_MinHeight, -1), preferredWidth: num(d.m_PreferredWidth, -1), preferredHeight: num(d.m_PreferredHeight, -1), flexibleWidth: num(d.m_FlexibleWidth, -1), flexibleHeight: num(d.m_FlexibleHeight, -1) }; break;
      case 'Outline': case 'Shadow': out[n === 'Outline' ? 'uiOutline' : 'uiShadow'] = { color: color(d.m_EffectColor), distance: v2(d.m_EffectDistance), useGraphicAlpha: d.m_UseGraphicAlpha !== '0' }; break;
      case 'Canvas': case 'CanvasScaler': case 'GraphicRaycaster': break; // reported on the canvas entry
      case 'ParticleSystem': case 'ParticleSystemRenderer': if (!others.includes('ParticleSystem (VFX)')) others.push('ParticleSystem (VFX)'); break;
      default: {
        const sp = c.classId === 114 ? scriptPath(c) : null;
        if (sp && (sp.startsWith('Assets/Scripts/') || /^MM(Position|Rotation|Scale)Shaker$|^MMWiggle$/.test(n))) others.push({ script: n, file: sp, enabled: d.m_Enabled !== '0', fields: fieldsOf(c) });
        else others.push(n);
      }
    }
  }
  if (others.length) out.other = others;
  return out;
}

// ------------------------------------------------------------------------------------------ rect layout

// Layout in canvas-root local space (Unity convention: y up, origin = root pivot). Each node keeps a 2D affine
// (a, b, c, d, tx, ty) mapping its own local space (origin = own pivot) into root space.
function layoutNode(g, parentRect, parentM) {
  const t = g.transform.data;
  const aMin = v2(t.m_AnchorMin), aMax = v2(t.m_AnchorMax), ap = v2(t.m_AnchoredPosition), sd = v2(t.m_SizeDelta), pv = v2(t.m_Pivot);
  const scale = v3(t.m_LocalScale);
  const q = q7(t.m_LocalRotation);
  const rotZ = quatToEuler(q)[2] * Math.PI / 180;
  let w, h, px, py;
  if (!parentRect) { w = sd[0]; h = sd[1]; px = 0; py = 0; }
  else {
    const ax0 = parentRect.x + parentRect.w * aMin[0], ax1 = parentRect.x + parentRect.w * aMax[0];
    const ay0 = parentRect.y + parentRect.h * aMin[1], ay1 = parentRect.y + parentRect.h * aMax[1];
    w = ax1 - ax0 + sd[0]; h = ay1 - ay0 + sd[1];
    px = ax0 + (ax1 - ax0) * pv[0] + ap[0];
    py = ay0 + (ay1 - ay0) * pv[1] + ap[1];
  }
  const cos = Math.cos(rotZ), sin = Math.sin(rotZ);
  const L = { a: cos * scale[0], b: sin * scale[0], c: -sin * scale[1], d: cos * scale[1], tx: px, ty: py };
  const M = parentM ? { a: parentM.a * L.a + parentM.c * L.b, b: parentM.b * L.a + parentM.d * L.b, c: parentM.a * L.c + parentM.c * L.d, d: parentM.b * L.c + parentM.d * L.d, tx: parentM.a * L.tx + parentM.c * L.ty + parentM.tx, ty: parentM.b * L.tx + parentM.d * L.ty + parentM.ty } : { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const own = { x: -w * pv[0], y: -h * pv[1], w, h };
  const corners = [[own.x, own.y], [own.x + w, own.y], [own.x, own.y + h], [own.x + w, own.y + h]].map(([x, y]) => [M.a * x + M.c * y + M.tx, M.b * x + M.d * y + M.ty]);
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  return { own, M, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], pivotRoot: [M.tx, M.ty], scaleRoot: [Math.hypot(M.a, M.b), Math.hypot(M.c, M.d)], rotRoot: Math.atan2(M.b, M.a) * 180 / Math.PI };
}

// ------------------------------------------------------------------------------------------ theme (runtime overrides)

const themeLib = parseUnityFile(path.join(ROOT, 'Assets/Resources/ThemeLibrary.asset'))[0].data;
const tmDocs = (() => { // ThemeManager.defaultTheme is a serialized default; the manager is bootstrapped at runtime.
  const src = fs.readFileSync(path.join(ROOT, 'Assets/Scripts/Game/Theming/ThemeManager.cs'), 'utf8');
  const m = /defaultTheme\s*=\s*Theme\.(\w+)/.exec(src); return m ? m[1] : 'Default';
})();
const THEME_ENUM = ['Default', 'Neon_City', 'Forest', 'Desert', 'Town'];
const packs = (themeLib.packs || []).map((p) => ({
  theme: THEME_ENUM[num(p.theme)], displayName: p.displayName,
  menuButton: spriteRef(p.menuButton, 'theme:menuButton'), menuButtonType: IMAGE_TYPE[num(p.menuButtonType)],
  buttonLabelColor: color(p.buttonLabelColor), accentColor: color(p.accentColor), panelColor: color(p.panelColor),
  pot: spriteRef(p.pot, 'theme:pot'),
  // 3D / menu art: recorded as Unity paths only (the 3D scene owns the felt, background and card backs).
  unityOnly: Object.fromEntries(['board', 'tableBackground', 'cardBack', 'cardBackFolded', 'preview', 'toggleTrack'].map((k) => [k, p[k] && !isNullRef(p[k]) ? rel(P.pathOf(p[k].guid) || '') : null])),
}));
const defaultPack = packs.find((p) => p.theme === tmDocs) || packs[0];

// Re-implements ThemeManager.Apply's passes for the default pack over the exported node trees, in the
// same order (ApplyGameplayUi -> ApplyChatAndReactionChrome -> ApplyPotChrome), so later passes win.
// Each node gets themeDefault = { rules: [...], image: {...merged}, text: {...merged} }.
const WHITE = () => color({ r: 1, g: 1, b: 1, a: 1 });
function applyTheme(canvas) {
  const pack = defaultPack;
  const label = pack.buttonLabelColor, accent = pack.accentColor;
  const all = [];
  const link = (n, parent) => { Object.defineProperty(n, '_p', { value: parent, enumerable: false }); all.push(n); (n.children || []).forEach((k) => { if (!k.excluded) link(k, n); }); };
  link(canvas.root, null);
  const ops = new Map();
  const op = (n, rule, patch) => { if (!n) return; if (!ops.has(n)) ops.set(n, []); ops.get(n).push({ rule, ...patch }); };
  const anc = (n, name, self = true) => { let t = self ? n : n._p; while (t) { if (t.name === name) return true; t = t._p; } return false; };
  const desc = (n) => { const out = []; const w = (x) => { out.push(x); (x.children || []).forEach((k) => { if (!k.excluded) w(k); }); }; w(n); return out; };
  const img = (n) => n?.components?.image;
  const spName = (n) => sprites[img(n)?.sprite]?.name || '';
  const spBuiltin = (n) => !!sprites[img(n)?.sprite]?.builtin;
  const alpha = (n) => img(n)?.color?.rgba[3] ?? 1;
  const size = (n) => n.layout?.size || [0, 0];
  const child = (n, name) => (n.children || []).find((k) => k.name === name && !k.excluded);
  const looksFrame = (n) => /^xxx_3/i.test(spName(n)) || /^button$/i.test(spName(n)) || /^button05/i.test(spName(n));
  const catcher = (n) => !img(n) || (!img(n).sprite && alpha(n) < 0.05) || /catcher/i.test(n.name) || n.name === 'Backdrop';
  const chromeImage = (n) => { const b = child(n, 'Background'); const t = b && img(b) ? b : (img(n) ? n : null); return t && !catcher(t) ? t : null; };
  const isIcon = (n) => {
    const i = img(n); if (!i) return true;
    if (i.type === 'Sliced' || looksFrame(n)) return false;
    if (/^(icon|plus|handle|dot|logo|discord|twitter)$/i.test(n.name) || /icon/i.test(n.name)) return true;
    if (spBuiltin(n)) return true;
    const [w, h] = size(n);
    if (i.type === 'Simple' && w > 0 && w <= 48 && h <= 48) return true;
    if (spName(n) === 'Circle' && (n.name === 'Handle' || (w > 0 && w <= 64 && h <= 64))) return true;
    return false;
  };
  const tintKeepAlpha = (n, c) => ({ color: color({ r: c.rgba[0], g: c.rgba[1], b: c.rgba[2], a: alpha(n) }) });
  const frame = (n) => ({ sprite: pack.menuButton, type: pack.menuButtonType, color: WHITE(), pixelsPerUnitMultiplier: pack.menuButtonType === 'Sliced' && img(n).pixelsPerUnitMultiplier < 1.05 ? 20 : img(n).pixelsPerUnitMultiplier });
  const potPlate = (n) => ({ sprite: pack.pot, type: 'Sliced', color: WHITE(), pixelsPerUnitMultiplier: spName(n).toLowerCase() === 'circle' ? 15 : img(n).pixelsPerUnitMultiplier < 1.05 ? 8 : img(n).pixelsPerUnitMultiplier });
  const labels = (root, c, rule) => { for (const d of desc(root)) if (d.components?.text && !anc(d, 'D_Token')) op(d, rule, { text: { color: c, vertexGradient: null } }); };
  const glyphs = (root, rule) => {
    for (const d of desc(root)) {
      if (d === root || !img(d)) continue;
      if (['Background', 'Border', 'window', 'Knob'].includes(d.name) || looksFrame(d) || img(d).type !== 'Simple') continue;
      if (anc(d, 'How_to_play') && !/^icon$/i.test(d.name) && !['How_to_play', 'Ring', 'window'].includes(d.name)) { if (d.name === 'Content') op(d, rule, { image: { color: WHITE() } }); continue; }
      op(d, rule, { image: { color: label } });
    }
  };
  const isConfirmStepper = (n) => anc(n, 'Confirm_Panel') && ((n.components?.button && anc(n, 'Value')) || /^(plus|minus)$/i.test(n.name) || ['05', '07'].includes(spName(n)));
  const underSlider = (n) => { let t = n; while (t) { if (t.components?.slider) return true; t = t._p; } return false; };
  const panelWindow = (n, rule) => { if (n.components?.mask) return; if (anc(n, 'How_to_play')) op(n, rule + ' (pot plate)', { image: potPlate(n) }); else if (pack.menuButtonType === 'Sliced') op(n, rule, { image: frame(n) }); else op(n, rule + ' (pot plate)', { image: potPlate(n) }); };
  const skip = (n) => {
    if (canvas.renderMode === 'WorldSpace') return true;
    const start = n.name; let t = n, self = true;
    while (t) {
      const m = t.name;
      if (m === 'How_to_play' && !['How_to_play', 'Ring', 'window'].includes(start)) return true;
      if (/^(theme|Theme_Panel|Cards_Holder|ThemeParallax|Table_Canvas)$/.test(m) || m.startsWith('Theme_Card') || m.startsWith('ThemeDrift') || m.startsWith('Name_Canvas') || /catcher/i.test(m)) return true;
      if (['Reaction_Panel', 'Reaction_Tray', 'Reaction_Grid'].includes(m) && !['Chat_Toggle', 'Reaction_Toggle'].includes(start)) return true;
      if (self && /^(Logo|Theme_Image|Background_Image|Table)$/.test(m)) return true;
      if ((t.components?.other || []).some((o) => o && ['SeatView', 'CardView', 'ThemeExempt', 'ThemeCard'].includes(o.script))) return true;
      self = false; t = t._p;
    }
    return false;
  };
  // --- ApplyGameplayUi: buttons
  for (const n of all) {
    if (!n.components?.button || skip(n)) continue;
    const R = 'ApplyGameplayUi.ApplyButtonGraphic';
    let target = child(n, 'Background'); if (!img(target)) target = null;
    const tg = n.components.button.targetGraphic; if (!target && tg?.path) target = all.find((x) => x.path === tg.path && img(x)) || null;
    if (!target && img(n)) target = n;
    if (!target) continue;
    if (n.name === 'Send_Button' || ['Discord', 'Twitter', 'Setting'].includes(n.name)) { const pl = chromeImage(n) || target; op(pl, R, { image: frame(pl) }); labels(n, label, R + ' labels'); if (n.name !== 'Send_Button') glyphs(n, R + ' glyphs'); continue; }
    if (isConfirmStepper(n)) { op(target, R + ' (confirm stepper)', { image: tintKeepAlpha(target, accent) }); labels(n, label, R + ' labels'); continue; }
    if (isIcon(target) || catcher(target)) continue;
    if (/^(PlayerNameButton|Wallet_Connect|Wallet_ID_Text|CodeInputButton|ThemeToggle_ONOFF)$/.test(n.name) || n.name.startsWith('InviteButton')) continue;
    if (['Chat_Toggle', 'Reaction_Toggle'].includes(n.name)) { op(target, R + ' (toggle tint)', { image: tintKeepAlpha(target, accent) }); continue; }
    const hud = ['How_to_play', 'Settings_button', 'Setting', 'Ring'].includes(n.name);
    const kids = (n.children || []).map((k) => k.name);
    const chrome = img(target).type === 'Sliced' || looksFrame(target) || img(target).sprite === pack.menuButton || kids.some((k) => /^(icon|Border|Background|Discord|Twitter|Knob)$/i.test(k)) || (img(target).sprite && img(target).type === 'Simple' && Math.max(...size(target)) >= 64);
    if (!hud && !chrome) continue;
    op(target, R, { image: frame(target) }); labels(n, label, R + ' labels'); glyphs(n, R + ' glyphs');
  }
  // --- ApplyGameplayUi: images
  for (const n of all) {
    if (!img(n) || skip(n)) continue;
    const R = 'ApplyGameplayUi.images';
    if (isConfirmStepper(n)) { op(n, R + ' (confirm stepper tint)', { image: tintKeepAlpha(n, accent) }); continue; }
    if (n.name === 'Value' && anc(n, 'Confirm_Panel')) { op(n, R + ' (ValueBorderColor)', { image: tintKeepAlpha(n, label) }); continue; }
    if (isIcon(n)) continue;
    if (underSlider(n)) {
      if (/^handle$/i.test(n.name)) op(n, R + ' (slider handle tint)', { image: tintKeepAlpha(n, accent) });
      else if (/fill/i.test(n.name)) { const b = sprites[img(n).sprite]?.border || [0]; op(n, R + ' (slider fill tint)', { image: { ...tintKeepAlpha(n, accent), ...(b.some((v) => v) ? { type: 'Sliced', pixelsPerUnitMultiplier: img(n).pixelsPerUnitMultiplier < 8 ? 40 : img(n).pixelsPerUnitMultiplier } : {}) } }); }
      continue;
    }
    if (['window', 'Confirm_Panel', 'Chat_Window'].includes(n.name)) { panelWindow(n, R + ' ApplyPanelWindow'); continue; }
    if (!img(n).sprite || ['ThemeToggle_ONOFF', 'Knob', 'HintPopUp'].includes(n.name)) continue;
    if (n.name === 'Border' ? !anc(n, 'How_to_play') : (looksFrame(n) || img(n).sprite === pack.menuButton)) op(n, R + ' ApplyFrame (gameplay frame)', { image: frame(n) });
  }
  // --- ApplyGameplayUi: HUD plates + panel labels
  for (const n of all) {
    if (skip(n)) continue;
    if (['Chat_Toggle', 'Reaction_Toggle'].includes(n.name) && img(n) && !catcher(n)) op(n, 'ApplyHudPlates (toggle tint)', { image: tintKeepAlpha(n, accent) });
    if (['How_to_play', 'Settings_button', 'Setting', 'Ring'].includes(n.name)) {
      const t = chromeImage(n) || (img(n) ? n : null);
      if (t && !catcher(t) && !/^icon$/i.test(t.name)) { op(t, 'ApplyHudPlates', { image: frame(t) }); for (const k of n.children || []) if (/^(icon|Discord)$/i.test(k.name) && img(k)) op(k, 'ApplyHudPlates (icon tint)', { image: { color: label } }); }
    }
  }
  for (const n of all) if (/^(Settings_Panel|SettingsPanel|CashOut_Panel|How_to_play)$/.test(n.name)) labels(n, label, 'ApplyPanelLabels');
  // --- ApplyChatAndReactionChrome (no skip test)
  for (const root of all.filter((n) => n.name === 'Chat_Panel' || n.name === 'Reaction_Panel')) {
    const R = 'ApplyChatAndReactionChrome';
    for (const n of desc(root)) {
      if (!img(n) || catcher(n) || /^icon$/i.test(n.name)) continue;
      if (['Chat_Toggle', 'Reaction_Toggle', 'Unread_Badge'].includes(n.name)) { op(n, R + ' (accent tint)', { image: tintKeepAlpha(n, accent) }); continue; }
      if (alpha(n) < 0.05) continue;
      if (n.name === 'Chat_Window') { panelWindow(n, R + ' ApplyPanelWindow'); continue; }
      if (n.name === 'Send_Button' || looksFrame(n)) { op(n, R + ' ApplyFrame', { image: frame(n) }); continue; }
      const chatPlate = /^(Chat_Window|Reaction_Tray|Chat_Input|Header|Input_Row|Presets_Row|Log_Scroll|Send_Button|Close_Button)$/.test(n.name) || /^Preset_/i.test(n.name) || (/^Reaction_/i.test(n.name) && !/^(Reaction_Panel|Reaction_Tray|Reaction_Grid|Reaction_Toggle|Reaction_Status)$/.test(n.name));
      if (chatPlate || /^pot/i.test(spName(n))) op(n, R + ' (pot plate)', { image: potPlate(n) });
    }
    for (const n of desc(root)) {
      if (!n.components?.button || ['Chat_Toggle', 'Reaction_Toggle'].includes(n.name)) continue;
      const t = chromeImage(n);
      if (t && alpha(t) >= 0.05) op(t, R + ' (button plate)', { image: looksFrame(t) || t.name === 'Chat_Window' || t.name === 'Send_Button' || n.name === 'Send_Button' ? frame(t) : potPlate(t) });
      labels(n, label, R + ' (button labels)');
    }
    for (const n of desc(root)) {
      if (!n.components?.text) continue;
      if (/^(Title_Label|Status_Label|Unread_Label|Send_Label|Close_Label|Reaction_Status|Reaction_Toggle_Label)$/.test(n.name) || n.name.startsWith('Row_Template') || (n.name === 'Text' && anc(n, 'Chat_Input'))) op(n, R + ' (labels)', { text: { color: label, vertexGradient: null } });
      if (n.name === 'Placeholder') op(n, R + ' (placeholder 55%)', { text: { color: color({ r: label.rgba[0], g: label.rgba[1], b: label.rgba[2], a: 0.55 }), vertexGradient: null } });
    }
  }
  // --- ApplyPotChrome (every canvas, world-space included)
  for (const n of all) {
    const potName = /^(Name_bar|Bottom_bar|Pot|PlayerNameButton|Wallet_Connect|Wallet_ID_Text|CodeInputButton)$/.test(n.name) || n.name.startsWith('InviteButton');
    if (potName || (n.name === 'bar' && anc(n, 'Pot_UI'))) {
      const t = potName ? chromeImage(n) : (img(n) ? n : null);
      if (t) op(t, 'ApplyPotChrome', { image: potPlate(t) });
      labels(n, label, 'ApplyPotChrome labels');
    }
    if (n.name === 'bg_circle' && img(n)) op(n, 'ApplyPotChrome.TintAvatarCircle', { image: { color: accent } });
  }
  // --- runtime label paint that is not theme but always applies
  for (const n of all) if (n.components?.text && anc(n, 'D_Token')) op(n, 'SeatView.PaintRoleLabel', { text: { color: color({ r: 0.12, g: 0.12, b: 0.14, a: 1 }), vertexGradient: null } });
  for (const [n, list] of ops) {
    const merged = { rules: list.map((o) => o.rule) };
    for (const o of list) { if (o.image) merged.image = { ...(merged.image || {}), ...o.image }; if (o.text) merged.text = { ...(merged.text || {}), ...o.text }; }
    n.themeDefault = merged;
  }
}

// ------------------------------------------------------------------------------------------ tree export

const RENDER_MODE = ['ScreenSpaceOverlay', 'ScreenSpaceCamera', 'WorldSpace'];
const SCREEN_SIZES = { '16:9': [1920, 1080], '20:9': [2400, 1080] };

function canvasSizeFor(scaler, screen) {
  const [sw, sh] = screen; const [rw, rh] = scaler.referenceResolution;
  let s;
  if (scaler.uiScaleMode !== 'ScaleWithScreenSize') s = scaler.scaleFactor || 1;
  else if (scaler.screenMatchMode === 'MatchWidthOrHeight') s = Math.pow(2, (1 - scaler.matchWidthOrHeight) * Math.log2(sw / rw) + scaler.matchWidthOrHeight * Math.log2(sh / rh));
  else if (scaler.screenMatchMode === 'Expand') s = Math.min(sw / rw, sh / rh);
  else s = Math.max(sw / rw, sh / rh);
  return { scaleFactor: r4(s), width: r4(sw / s), height: r4(sh / s) };
}

function exportTree(g, ctx, parentLayout, parentActive) {
  const p = nodePath(g);
  const t = g.transform?.data;
  const selfActive = g.go.data.m_IsActive !== '0';
  const node = { name: g.go.data.m_Name, path: p, active: selfActive, activeInHierarchy: parentActive && selfActive };
  if (g.transform?.prefab && g.transform.prefabRoot) node.prefab = g.transform.prefab;
  if (t && g.transform.classId === 224) {
    node.rect = {
      anchorMin: v2(t.m_AnchorMin), anchorMax: v2(t.m_AnchorMax), anchoredPosition: v2(t.m_AnchoredPosition), sizeDelta: v2(t.m_SizeDelta), pivot: v2(t.m_Pivot),
      localZ: r4(num(t.m_LocalPosition?.z)), rotation: q7(t.m_LocalRotation), euler: quatToEuler(q7(t.m_LocalRotation)), scale: v3(t.m_LocalScale),
    };
    // A screen-space canvas root serialises whatever the editor game view was (often size 0, scale 0):
    // lay it out at the 16:9 reference canvas instead.
    const screenRoot = ctx.screenFrames && !parentLayout;
    const fr0 = screenRoot ? ctx.screenFrames['16:9'] : null;
    const lay = screenRoot
      ? layoutNode({ transform: { data: { ...t, m_SizeDelta: { x: fr0.width, y: fr0.height }, m_Pivot: { x: 0.5, y: 0.5 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 } } } }, null, null)
      : layoutNode(g, parentLayout?.rect || null, parentLayout?.M || null);
    g._layout = lay;
    if (screenRoot) node.rect.note = 'root of a screen-space canvas: size/scale are driven by the CanvasScaler (see canvasSizes)';
    node.layout = {
      size: [r4(lay.own.w), r4(lay.own.h)], box: lay.box.map(r4), pivot: lay.pivotRoot.map(r4),
      ...(Math.abs(lay.scaleRoot[0] - 1) > 1e-4 || Math.abs(lay.scaleRoot[1] - 1) > 1e-4 ? { scale: lay.scaleRoot.map(r4) } : {}),
      ...(Math.abs(lay.rotRoot) > 1e-3 ? { rotationZ: r4(lay.rotRoot) } : {}),
    };
    if (ctx.screenFrames) {
      node.css = {};
      for (const [k, fr] of Object.entries(ctx.screenFrames)) {
        const l2 = layoutNode(g, k in (parentLayout?.frames || {}) ? parentLayout.frames[k].rect : (parentLayout ? null : null), parentLayout?.frames?.[k]?.M || null);
        // root: use the frame's canvas size
        const L = parentLayout ? l2 : layoutNode({ transform: { data: { ...t, m_SizeDelta: { x: fr.width, y: fr.height }, m_Pivot: { x: 0.5, y: 0.5 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 } } } }, null, null);
        (node._frames ||= {})[k] = { rect: { x: L.own.x, y: L.own.y, w: L.own.w, h: L.own.h }, M: L.M };
        // css box: top-left origin of the canvas, y down, canvas units
        node.css[k] = [r4(L.box[0] + fr.width / 2), r4(fr.height / 2 - (L.box[1] + L.box[3])), r4(L.box[2]), r4(L.box[3])];
      }
    }
    node._rect = { x: lay.own.x, y: lay.own.y, w: lay.own.w, h: lay.own.h };
  } else if (t) {
    node.transform = { position: v3(t.m_LocalPosition), rotation: q7(t.m_LocalRotation), scale: v3(t.m_LocalScale) };
  }
  const comps = describeComponents(g, p);
  if (Object.keys(comps).length) node.components = comps;
  const kids = [];
  for (const c of g.children) {
    const cp = nodePath(c);
    if (EXCLUDE_CHILDREN[cp]) { kids.push({ name: c.go.data.m_Name, path: cp, excluded: EXCLUDE_CHILDREN[cp] }); continue; }
    const childParent = node._rect ? { rect: node._rect, M: g._layout.M, frames: node._frames } : parentLayout;
    kids.push(exportTree(c, ctx, childParent, node.activeInHierarchy));
  }
  if (kids.length) node.children = kids;
  delete node._rect; delete node._frames;
  return node;
}

function worldMatrixOf(g) {
  const chain = []; let t = g; while (t) { chain.unshift(t); t = t.parent; }
  let M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const n of chain) {
    const d = n.transform.data;
    let pos = v3(d.m_LocalPosition);
    if (n.transform.classId === 224 && !(n.parent && n.parent.transform.classId === 224)) { const ap = v2(d.m_AnchoredPosition); pos = [ap[0], ap[1], pos[2]]; }
    M = matMul(M, trsMatrix(pos, q7(d.m_LocalRotation), v3(d.m_LocalScale)));
  }
  return M;
}

function canvasEntry(g, role, extra = {}) {
  const canvas = g.components.find((c) => c.classId === 223);
  const scalerC = g.components.find((c) => scriptName(c) === 'CanvasScaler');
  const cd = canvas.data;
  const sd = scalerC?.data || {};
  const scaler = scalerC ? {
    uiScaleMode: ['ConstantPixelSize', 'ScaleWithScreenSize', 'ConstantPhysicalSize'][num(sd.m_UiScaleMode)], referenceResolution: v2(sd.m_ReferenceResolution),
    screenMatchMode: ['MatchWidthOrHeight', 'Expand', 'Shrink'][num(sd.m_ScreenMatchMode)], matchWidthOrHeight: num(sd.m_MatchWidthOrHeight), referencePixelsPerUnit: num(sd.m_ReferencePixelsPerUnit, 100),
    dynamicPixelsPerUnit: num(sd.m_DynamicPixelsPerUnit, 1), scaleFactor: num(sd.m_ScaleFactor, 1),
  } : null;
  const renderMode = RENDER_MODE[num(cd.m_RenderMode)];
  const entry = { name: g.go.data.m_Name, path: nodePath(g), role, renderMode, sortingOrder: num(cd.m_SortingOrder), sortingLayerID: cd.m_SortingLayerID, pixelPerfect: cd.m_PixelPerfect === '1', planeDistance: num(cd.m_PlaneDistance), worldCamera: refTarget(cd.m_Camera), scaler, ...extra };
  const ctx = { renderMode };
  if (renderMode !== 'WorldSpace' && scaler) {
    entry.canvasSizes = {};
    ctx.screenFrames = {};
    for (const [k, s] of Object.entries(SCREEN_SIZES)) { const cs = canvasSizeFor(scaler, s); entry.canvasSizes[k] = { screen: s, ...cs }; ctx.screenFrames[k] = cs; }
  } else {
    const M = worldMatrixOf(g);
    entry.world = { matrix: M.map((v) => Math.round(v * 1e7) / 1e7), matrixOrder: 'column-major, Unity world space (left-handed, y up)', ...decompose(M) };
    entry.world.euler = quatToEuler(entry.world.rotation);
    entry.world.unitsPerCanvasUnit = entry.world.scale[0];
  }
  entry.root = exportTree(g, ctx, null, true);
  applyTheme(entry);
  return entry;
}

// ------------------------------------------------------------------------------------------ pick canvases

const byPath = new Map(); for (const [, g] of gos) byPath.set(nodePath(g), g);
const tableView = [...gos.values()].flatMap((g) => g.components).find((c) => scriptName(c) === 'TableView');
const tv = tableView.data;
const seatGos = tv.seatViews.map((r) => compOwner.get(normId(r.fileID)));
const potGo = compOwner.get(normId(tv.potView.fileID));
const bettingGo = compOwner.get(normId(tv.bettingPanel.fileID));

const canvases = [];
seatGos.forEach((g, i) => canvases.push(canvasEntry(g, 'seat', { seatSlot: i })));
canvases.push(canvasEntry(potGo, 'pot'));
const tableCanvas = byPath.get('Background/Table_Canvas');
if (tableCanvas) canvases.push(canvasEntry(tableCanvas, 'table-felt', { note: 'Felt image + voice labels; the SeatView on it is not in TableView.seatViews (unused).' }));
canvases.push(canvasEntry(bettingGo, 'screen-hud', { note: 'Screen-space overlay: action buttons (BettingPanel), confirm/raise panel, lobby buttons, chat + reaction panels, settings/how-to-play buttons.' }));

const compRef = (r) => refTarget(r);
const seatViewsOut = seatGos.map((g, i) => {
  const sv = g.components.find((c) => scriptName(c) === 'SeatView');
  return { slot: i, canvas: g.go.data.m_Name, prefab: g.transform.prefab || null, mirrored: /Right/.test(g.go.data.m_Name), fields: fieldsOf(sv) };
});
const potC = potGo.components.find((c) => scriptName(c) === 'PotView');
const betC = bettingGo.components.find((c) => scriptName(c) === 'BettingPanel');

// Camera (for projecting world-space seat canvases to screen)
const camGo = [...gos.values()].find((g) => g.components.some((c) => c.classId === 20) && g.go.data.m_Name === 'Main Camera');
const camC = camGo.components.find((c) => c.classId === 20).data;
const camM = worldMatrixOf(camGo);
const camera = { name: 'Main Camera', world: { ...decompose(camM), euler: null }, fieldOfView: num(camC['field of view']), fovAxis: num(camC.m_FOVAxisMode) === 0 ? 'vertical' : 'horizontal', orthographic: camC.orthographic === '1', orthographicSize: num(camC['orthographic size']), near: num(camC['near clip plane']), far: num(camC['far clip plane']), background: color(camC.m_BackGroundColor), components: camGo.components.map(scriptName) };
camera.world.euler = quatToEuler(camera.world.rotation);

// reaction + avatar art
const reactionLib = parseUnityFile(path.join(ROOT, 'Assets/SO/ReactionLibrary.asset'))[0].data;
const reactions = { bubbleSeconds: num(reactionLib.bubbleSeconds, 3), popSeconds: 0.18, popFromScale: 0.6, easing: 'easeOutQuad (1-(1-k)^2), unscaled time', bubbleSize: 360, bubbleHeight: 415, entries: (reactionLib.entries || []).map((e) => ({ id: num(e.id), label: e.label, sprite: spriteRef(e.sprite, 'ReactionLibrary #' + e.id) })) };
const avatarLib = parseUnityFile(path.join(ROOT, 'Assets/Resources/AvatarLibrary.asset'))[0].data;
const catalogSrc = fs.readFileSync(path.join(ROOT, 'Assets/Scripts/Core/Social/AvatarCatalog.cs'), 'utf8');
const avatarIds = [...(/Ids\s*=\s*\{([\s\S]*?)\};/.exec(catalogSrc)?.[1] || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const avatars = { note: 'Wire value N (1-based) = sprites[N-1]. Unset (0) -> FNV-1a 64 of the player name % count + 1 (AvatarCatalog.FallbackFor / PokerTokenHash).', fallbackHash: 'FNV-1a 64-bit over UTF-16 code units: h=14695981039346656037; for c: h^=c; h*=1099511628211 (mod 2^64); as signed long, 0 -> 1; avatar = (ulong)h % count + 1', entries: (avatarLib.sprites || []).map((s, i) => ({ value: i + 1, id: avatarIds[i] || null, sprite: spriteRef(s, 'AvatarLibrary #' + (i + 1)) })) };

// ------------------------------------------------------------------------------------------ animations

const CLASS_FOR_ANIM = { 1: 'GameObject', 4: 'Transform', 224: 'RectTransform', 225: 'CanvasGroup', 222: 'CanvasRenderer', 212: 'SpriteRenderer', 23: 'MeshRenderer', 114: 'MonoBehaviour', 95: 'Animator' };
function keyframes(curve) {
  return (curve?.m_Curve || []).map((k) => {
    const isVec = k.value && typeof k.value === 'object';
    const val = isVec ? (('w' in k.value) ? v4(k.value) : v3(k.value)) : r4(num(k.value));
    const sl = (s) => (s && typeof s === 'object' ? (('w' in s) ? v4(s) : v3(s)) : r4(num(s)));
    return { time: r4(num(k.time)), value: val, inSlope: sl(k.inSlope), outSlope: sl(k.outSlope), tangentMode: num(k.tangentMode), weightedMode: num(k.weightedMode), inWeight: sl(k.inWeight), outWeight: sl(k.outWeight) };
  });
}
const clipCache = new Map();
// abs = .anim file, or "<controller>#<fileID>" for a clip embedded as a sub-asset of a controller.
function convertClip(abs, embeddedDoc = null) {
  if (clipCache.has(abs)) return clipCache.get(abs);
  const d = embeddedDoc ? embeddedDoc.data : parseUnityFile(abs).find((x) => x.classId === 74).data;
  const st = d.m_AnimationClipSettings || {};
  const compName = (c) => { if (num(c.classID) === 114 && c.script?.guid) return KNOWN_SCRIPTS[c.script.guid] || path.basename(P.pathOf(c.script.guid) || 'MonoBehaviour').replace(/\.cs$/, ''); return CLASS_FOR_ANIM[num(c.classID)] || 'class' + c.classID; };
  const curves = [];
  const editor = d.m_EditorCurves || [];
  const src = editor.length ? editor : (d.m_FloatCurves || []);
  for (const c of src) curves.push({ path: c.path || '', component: compName(c), attribute: c.attribute, preInfinity: num(c.curve?.m_PreInfinity), postInfinity: num(c.curve?.m_PostInfinity), keys: keyframes(c.curve) });
  if (!editor.length) {
    for (const [field, attr] of [['m_PositionCurves', 'm_LocalPosition'], ['m_ScaleCurves', 'm_LocalScale'], ['m_EulerCurves', 'localEulerAnglesRaw'], ['m_RotationCurves', 'm_LocalRotation']]) {
      for (const c of d[field] || []) curves.push({ path: c.path || '', component: 'Transform', attribute: attr, vector: true, keys: keyframes(c.curve) });
    }
  }
  const pptr = (d.m_PPtrCurves || []).map((c) => ({ path: c.path || '', component: compName(c), attribute: c.attribute, keys: (c.curve || []).map((k) => ({ time: r4(num(k.time)), sprite: spriteRef(k.value, 'anim:' + path.basename(abs)) })) }));
  let maxT = 0; for (const c of curves) for (const k of c.keys) maxT = Math.max(maxT, k.time); for (const c of pptr) for (const k of c.keys) maxT = Math.max(maxT, k.time);
  const start = num(st.m_StartTime), stop = num(st.m_StopTime, maxT);
  const out = {
    name: d.m_Name, file: embeddedDoc ? rel(abs.split('#')[0]) + ' (embedded sub-asset)' : rel(abs), sampleRate: num(d.m_SampleRate, 60), length: r4(stop - start), startTime: r4(start), stopTime: r4(stop), loop: st.m_LoopTime === '1', loopBlend: st.m_LoopBlend === '1', wrapMode: num(d.m_WrapMode),
    curves, pptrCurves: pptr, events: (d.m_Events || []).map((e) => ({ time: r4(num(e.time)), function: e.functionName, data: e.data, int: num(e.intParameter), float: num(e.floatParameter) })),
  };
  clipCache.set(abs, out);
  return out;
}
function convertController(abs) {
  const docs = parseUnityFile(abs);
  const byId = new Map(docs.map((d) => [d.fileId, d]));
  const ctl = docs.find((d) => d.classId === 91);
  if (!ctl) { // override controller
    const oc = docs.find((d) => d.classId === 221);
    return oc ? { name: oc.data.m_Name, file: rel(abs), override: true, base: oc.data.m_Controller?.guid ? rel(P.pathOf(oc.data.m_Controller.guid)) : null, overrides: (oc.data.m_Clips || []).map((c) => ({ original: c.m_OriginalClip?.guid ? rel(P.pathOf(c.m_OriginalClip.guid)) : null, override: c.m_OverrideClip?.guid ? rel(P.pathOf(c.m_OverrideClip.guid)) : null })) } : null;
  }
  const stateName = (id) => byId.get(normId(id))?.data.m_Name || null;
  const clipOf = (m) => { if (isNullRef(m)) return null; if (m.guid) { const p = P.pathOf(m.guid); if (p && p.endsWith('.anim')) { convertClip(p); return rel(p); } return p ? rel(p) : m.guid; } const bt = byId.get(normId(m.fileID)); if (!bt) return null; if (bt.classId === 74) { const key = abs + '#' + bt.fileId; convertClip(key, bt); return rel(abs) + '#' + bt.data.m_Name; } return { blendTree: bt.data.m_Name }; };
  const conds = (t) => (t.m_Conditions || []).map((c) => ({ mode: ({ 1: 'If', 2: 'IfNot', 3: 'Greater', 4: 'Less', 6: 'Equals', 7: 'NotEqual' })[num(c.m_ConditionMode)] || c.m_ConditionMode, parameter: c.m_ConditionEvent, threshold: num(c.m_EventTreshold) }));
  const trans = (ids) => (ids || []).map((r) => { const t = byId.get(normId(r.fileID))?.data; if (!t) return null; return { to: t.m_IsExit === '1' ? '(exit)' : stateName(t.m_DstState?.fileID), conditions: conds(t), hasExitTime: t.m_HasExitTime === '1', exitTime: r4(num(t.m_ExitTime)), duration: r4(num(t.m_TransitionDuration)), fixedDuration: t.m_HasFixedDuration === '1', offset: r4(num(t.m_TransitionOffset)), canTransitionToSelf: t.m_CanTransitionToSelf === '1' }; }).filter(Boolean);
  const layers = (ctl.data.m_AnimatorLayers || []).map((L) => {
    const sm = byId.get(normId(L.m_StateMachine?.fileID))?.data || {};
    const states = (sm.m_ChildStates || []).map((cs) => { const s = byId.get(normId(cs.m_State?.fileID))?.data || {}; return { name: s.m_Name, clip: clipOf(s.m_Motion), speed: num(s.m_Speed, 1), speedParameter: s.m_SpeedParameterActive === '1' ? s.m_SpeedParameter : null, writeDefaults: s.m_WriteDefaultValues === '1', transitions: trans(s.m_Transitions), tag: s.m_Tag || '' }; });
    return { name: L.m_Name, defaultState: stateName(sm.m_DefaultState?.fileID), states, anyStateTransitions: trans(sm.m_AnyStateTransitions), entryTransitions: (sm.m_EntryTransitions || []).map((r) => { const t = byId.get(normId(r.fileID))?.data; return t ? { to: stateName(t.m_DstState?.fileID), conditions: conds(t) } : null; }).filter(Boolean), weight: num(L.m_DefaultWeight, 1), blending: num(L.m_BlendingMode) };
  });
  return { name: ctl.data.m_Name, file: rel(abs), parameters: (ctl.data.m_AnimatorParameters || []).map((p) => ({ name: p.m_Name, type: ({ 1: 'Float', 3: 'Int', 4: 'Bool', 9: 'Trigger' })[num(p.m_Type)] || p.m_Type, default: p.m_Type === '1' ? num(p.m_DefaultFloat) : p.m_Type === '3' ? num(p.m_DefaultInt) : p.m_DefaultBool === '1' })), layers };
}

console.log('Converting animations…');
const animDir = path.join(ROOT, 'Assets/Test/Animations');
const controllerFiles = new Set([...controllersUsed]);
for (const f of fs.readdirSync(animDir)) if (f.endsWith('.controller') || f.endsWith('.overrideController')) controllerFiles.add(path.join(animDir, f));
for (const f of fs.readdirSync(path.join(animDir, 'Face'))) if (f.endsWith('.controller')) controllerFiles.add(path.join(animDir, 'Face', f));
const controllers = {};
for (const f of [...controllerFiles].sort()) { const c = convertController(f); if (c) controllers[rel(f)] = { ...c, usedByHud: controllersUsed.has(f) }; }
for (const n of REQUESTED_CLIPS) { const f = path.join(animDir, n + '.anim'); if (fs.existsSync(f)) convertClip(f); else console.warn('missing clip', n); }
const clips = {}; for (const [abs, c] of [...clipCache].sort((a, b) => a[0].localeCompare(b[0]))) clips[abs.includes('#') ? rel(abs.split('#')[0]) + '#' + c.name : rel(abs)] = c;

// which HUD nodes each controller drives
const animatorUsers = {};
const walkAnim = (n) => { if (n.components?.animator?.controller) (animatorUsers[n.components.animator.controller] ||= []).push(n.path); (n.children || []).forEach(walkAnim); };
canvases.forEach((c) => walkAnim(c.root));
for (const [k, v] of Object.entries(animatorUsers)) if (controllers[k]) controllers[k].hudNodes = v;

// ------------------------------------------------------------------------------------------ write

const hud = {
  generatedBy: 'web/tools/extract-unity-hud.mjs', scene: SCENE, generatedAt: new Date().toISOString(),
  conventions: {
    rect: 'Unity RectTransform values as authored (anchors 0..1, y up, pivot 0..1, sizeDelta/anchoredPosition in canvas units).',
    layout: 'Resolved rects: size=[w,h]; box=[xMin,yMin,w,h] axis-aligned in the canvas ROOT local space (y up, origin = root pivot); pivot=[x,y] of the node pivot in that space. Layout groups are not re-run (Unity serialises their last result).',
    css: 'Screen canvases only: [left, top, width, height] in canvas units from the canvas top-left (y down) for each aspect in canvasSizes. Multiply by canvasSizes[k].scaleFactor to get device pixels.',
    world: 'World-space canvases: world.matrix maps canvas-root local units (x right, y up, origin = root pivot) to Unity world space. Unity is left-handed (+z forward); a right-handed three.js scene usually negates z: (x, y, -z), quaternion (-x, -y, z, w).',
    colors: 'hex is sRGB #rrggbb[aa]; rgba floats 0..1 as authored (project colour space affects nothing for UI).',
    sprites: 'Image.sprite is a key into sprites{}. file = texture under web/public, written at exportSize (exportScale x source; Unity itself renders it at unityImport.size). rect/border/pivot are in SOURCE-texture pixels (rect y from bottom, rectTopLeft y from top); rectExported/borderExported are the same in the exported file\'s pixels (use these for CSS border-image-slice / background-position). Border order: left, bottom, right, top. Sliced images: a border of b source px is drawn b * scaler.referencePixelsPerUnit / (sprite.ppu * image.pixelsPerUnitMultiplier) canvas units wide (Unity Image.multipliedPixelsPerUnit); if the rect is smaller than both borders Unity shrinks them proportionally.',
    themeDefault: `Runtime overrides ThemeManager applies for the default pack (${defaultPack.theme} / ${defaultPack.displayName}) — approximated from ThemeManager.cs rules; apply on top of the authored values.`,
    activeInHierarchy: 'authored state at scene load; TableView.Initialize hides every seat until bound, BettingPanel.Hide() runs at start.',
  },
  camera,
  theme: { default: defaultPack.theme, packs },
  tableView: { seatViews: seatViewsOut, potView: { canvas: potGo.go.data.m_Name, fields: fieldsOf(potC) }, boardView: refTarget(tv.boardView), bettingPanel: { canvas: bettingGo.go.data.m_Name, fields: fieldsOf(betC) }, reactionLibrary: refTarget(tv.reactionLibrary), cardDealer: refTarget(tv.cardDealer) },
  canvases,
  sprites, fonts, materials, reactions, avatars,
};
// unused builtin field cleanup
fs.mkdirSync(path.dirname(OUT_HUD), { recursive: true });
fs.writeFileSync(OUT_HUD, JSON.stringify(hud, null, 1));
fs.writeFileSync(OUT_ANIMS, JSON.stringify({ generatedBy: 'web/tools/extract-unity-hud.mjs', conventions: {
  keys: 'Unity Keyframe fields. time in seconds, slopes in value/second. Evaluate a segment k0->k1 (dt = t1 - t0) as a cubic Hermite with m0 = k0.outSlope*dt and m1 = k1.inSlope*dt (weightedMode 0 = unweighted, which is every key here). "Infinity" as a slope means a stepped (constant) segment: hold k0.value until t1.',
  tangentMode: 'packed int: bit0 = broken, bits1-4 = left mode, bits5-8 = right mode; mode 0 Free, 1 Auto, 2 Linear, 3 Constant, 4 ClampedAuto. 136 = ClampedAuto both sides (smooth, flat at extremes), 69 = broken Linear/Linear. The slopes are already baked, so tangentMode is informational.',
  curves: 'path is relative to the GameObject carrying the Animator ("" = that object). component names the animated component (RectTransform, Image, CanvasGroup, GameObject...). attribute examples: m_AnchoredPosition.x, m_SizeDelta.y, m_LocalScale.x, m_LocalRotation.z (quaternion component), m_Color.a, m_FillAmount, m_IsActive, m_Alpha. Curves come from m_EditorCurves (per-float) when present.',
  pre_postInfinity: 'Unity curve wrap (2 = clamp, the default for every curve here). Whether a clip repeats is the clip loop flag.',
  controllers: 'Every state here has writeDefaults=true: a state whose clip does not animate a property restores that property to its authored (scene) value. Transitions with conditions on Trigger parameters are fired by Button "Animation" transitions (trigger names in the node\'s button.animationTriggers) or by code (SetTrigger). Empty conditions + hasExitTime=false never occur here. An Animator restarts at the layer defaultState every time its GameObject is enabled (keepStateOnDisable=false).',
}, controllers, clips }, null, 1));
console.log('Wrote', rel(OUT_HUD), (fs.statSync(OUT_HUD).size / 1024).toFixed(0) + 'KB;', rel(OUT_ANIMS), (fs.statSync(OUT_ANIMS).size / 1024).toFixed(0) + 'KB');

// ------------------------------------------------------------------------------------------ copy assets + manifest

let bytes = 0, files = 0;
const copied = [];
function copy(src, webRel, scale = 1) {
  const dst = path.join(WEB, 'public', webRel);
  let buf = fs.readFileSync(src), resized = null;
  if (scale < 1 && /.png$/i.test(src)) {
    const img = decodePng(buf);
    if (img) { const nw = Math.max(1, Math.round(img.width * scale)), nh = Math.max(1, Math.round(img.height * scale)); buf = encodePng(resizeRgba(img, nw, nh)); resized = [nw, nh]; }
    else console.warn('could not decode (copied full size):', rel(src));
  }
  if (COPY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  bytes += buf.length; files++;
  copied.push({ src: rel(src), web: webRel, size: buf.length, resized });
}
console.log('Copying assets…');
for (const [src, t] of textureCopies) copy(src, t.file, t.scale);
for (const [src, w] of fontCopies) copy(src, w);

const usesByFile = new Map();
for (const [key, s] of Object.entries(sprites)) {
  if (!s.file) continue;
  const u = usesByFile.get(s.file) || { subs: new Set(), uses: new Set() };
  if (s.subSprite) u.subs.add(s.subSprite + (s.border && s.border.some((b) => b) ? ` (9-slice ${s.border.join(',')})` : ''));
  else if (s.border && s.border.some((b) => b)) u.subs.add(`9-slice ${s.border.join(',')}`);
  for (const p of spriteUse.get(key) || []) u.uses.add(p);
  usesByFile.set(s.file, u);
}
const fontUses = new Map();
for (const [g, f] of Object.entries(fonts)) if (f.file) fontUses.set(f.file, (fontUses.get(f.file) || []).concat(f.name || f.unity));
const short = (p) => p.replace(/^(Name_Canvas[^/]*|Pot_UI|Canvas|Background\/Table_Canvas)/, (m) => m);
const summarizeUses = (set) => {
  const arr = [...set];
  const groups = new Map();
  for (const p of arr) { const k = p.replace(/^Name_Canvas[^/]*/, 'Name_Canvas*'); groups.set(k, (groups.get(k) || 0) + 1); }
  return [...groups.keys()].slice(0, 6).join('; ') + (groups.size > 6 ? `; +${groups.size - 6} more` : '');
};
let md = `# Table HUD assets (from Unity)\n\nGenerated by \`web/tools/extract-unity-hud.mjs\` from \`${SCENE}\` — re-run it rather than editing by hand.\n\n` +
  `${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB. Sprite rects / 9-slice borders / pixels-per-unit for every sprite are in \`web/src/data/unity-hud.json\` → \`sprites\` (keys \`<guid>:<fileID>\`).\n` +
  `\`Name_Canvas*\` = any of the 8 seat HUD canvases. "theme:" uses come from the ThemeLibrary packs (runtime skin), "anim:" from animation sprite swaps.\n\n` +
  `## Sprites\n\n| File (web/public/…) | Unity source | Size | Sub-sprites / 9-slice | Used by |\n|---|---|---|---|---|\n`;
for (const c of copied.filter((c) => c.web.startsWith('assets/ui')).sort((a, b) => a.web.localeCompare(b.web))) {
  const u = usesByFile.get(c.web) || { subs: new Set(), uses: new Set() };
  md += `| \`${c.web}\` | \`${c.src}\` | ${(c.size / 1024).toFixed(0)} KB${c.resized ? ' (' + c.resized.join('×') + ')' : ''} | ${[...u.subs].join('<br>') || '—'} | ${summarizeUses(u.uses).replace(/\|/g, '\\|') || '—'} |\n`;
}
md += `\n## Fonts\n\n| File | Unity source | Size | TMP font assets |\n|---|---|---|---|\n`;
for (const c of copied.filter((c) => c.web.startsWith('assets/fonts'))) md += `| \`${c.web}\` | \`${c.src}\` | ${(c.size / 1024).toFixed(0)} KB | ${(fontUses.get(c.web) || []).join(', ')} |\n`;
const notCopied = Object.entries(sprites).filter(([, s]) => !s.file);
if (notCopied.length) { md += `\n## Not copied\n\n`; for (const [k, s] of notCopied) md += `- \`${k}\` ${s.name || ''}: ${s.note || (s.missing ? 'GUID not found in project' : '')}\n`; }
if (COPY) { fs.mkdirSync(OUT_UI, { recursive: true }); fs.writeFileSync(path.join(OUT_UI, 'MANIFEST.md'), md); }
console.log(`Assets: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB${COPY ? ' copied' : ' (dry run)'}`);
