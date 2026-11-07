#!/usr/bin/env node
// Extracts the Nomad menu (the art team's screens in Assets/Scenes/PokerUI.unity) so the web port can match it 1:1.
//
//   node web/tools/extract-unity-menu.mjs [--no-copy]
//
// Reads (never writes) Assets/. Writes:
//   web/src/data/menu-ui.json          RectTransform trees of every Nomad screen canvas (inactive ones too), with
//                                      Image / TMP / Button (+ persistent onClick calls) / Toggle / Slider / ScrollRect /
//                                      TMP_InputField / masks / layout groups / AspectRatioFitter and the Nomad scripts'
//                                      serialized fields; sprites, fonts, TMP materials; ThemeLibrary previews for table select
//   web/public/assets/menu/**          sprites (resized to what the screens draw), MANIFEST.md
//
// Fonts: the screens use the same two TMP fonts as the table HUD (NotoSans-Bold SDF, LiberationSans SDF); their .ttf
// files are already in web/public/assets/fonts (extract-unity-hud.mjs) — copied here only if missing.
//
// Based on extract-unity-hud.mjs (component readers) and ./lib/unity-yaml.mjs (prefab resolution).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnityProject, buildHierarchy, normId, parseUnityFile, readMeta, imageSize } from './lib/unity-yaml.mjs';
import { decodePng, resizeRgba, encodePng } from './lib/png.mjs';
import { optimizeAssets } from './optimize-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const SCENE = 'Assets/Scenes/PokerUI.unity';
const OUT_JSON = path.join(WEB, 'src/data/menu-ui.json');
const OUT_ASSETS = path.join(WEB, 'public/assets/menu');
const COPY = !process.argv.includes('--no-copy');

// NomadUiHost.ScreenNames: the scene roots the host binds (RetentionHud, the camera and light are not screens).
const SCREENS = [
  'Login', 'MainMenu', 'TableSelect_TownLobby', 'Friends', 'PartyMenu',
  'Tournaments_Browse', 'Tournaments_MyTournaments', 'Tournaments_Host', 'Tournaments_JoinByCode',
  'Leaderboard', 'Agents_Overview', 'Agents_Strategy', 'Agents_SessionHistory',
  'LevelRewards', 'LuckySlot_Win', 'LuckySlot_Lost',
];

// Export sizing: Unity imports at maxTextureSize (WebGL override, else Default); we write at most 2x that, at most
// 2x the largest size the screens draw a Simple sprite at (min 256), and Sliced/Tiled sprites at most 1024 (their
// borders, not their size, set the look). Never upscaled.
const EXPORT_MULT = 2;
const CAP_SLICED = 1024;
const CAP_MAX = 2048;

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
const CLASS_NAMES = { 1: 'GameObject', 4: 'Transform', 224: 'RectTransform', 114: 'MonoBehaviour', 225: 'CanvasGroup', 222: 'CanvasRenderer', 223: 'Canvas', 95: 'Animator' };
// Project scripts whose serialized fields the web runtime reads (refs become node paths / sprite keys).
const SCRIPT_FIELDS = new Set(['TitleOrnament', 'NomadSelectable', 'NomadRowFilter', 'TableSelectController', 'PokerButtonSfx',
  'NomadTournamentScreen', 'NomadSlotSpin', 'NomadSparkles', 'NomadStrategyPanel', 'NomadAgentStrategySummary', 'ThemeExempt']);

// ------------------------------------------------------------------------------------------ helpers

const P = new UnityProject(ROOT);
const num = (v, d = 0) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
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
function color32(v) {
  const n = Number(v); if (!Number.isFinite(n)) return null;
  return color({ r: (n & 255) / 255, g: ((n >>> 8) & 255) / 255, b: ((n >>> 16) & 255) / 255, a: ((n >>> 24) & 255) / 255 });
}
const isNullRef = (r) => !r || normId(r.fileID) === '0';
const rel = (p) => P.rel(p);
function quatToEuler(q) {
  const [x, y, z, w] = q;
  const sinX = 2 * (w * x - y * z);
  if (Math.abs(sinX) > 0.99999) return [Math.sign(sinX) * 90, r4((2 * Math.atan2(y, w) * 180) / Math.PI) || 0, 0];
  const ex = Math.asin(sinX) * 180 / Math.PI;
  const ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) * 180 / Math.PI;
  const ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI;
  return [r4(ex), r4(ey), r4(ez)];
}

// ------------------------------------------------------------------------------------------ scene

console.log('Indexing GUIDs + resolving PokerUI prefabs…');
const objs = P.resolve(path.join(ROOT, SCENE));
const { gos } = buildHierarchy(objs);

function scriptName(c) {
  if (c.classId !== 114) return c.type || CLASS_NAMES[c.classId] || ('class' + c.classId);
  const g = c.data.m_Script?.guid;
  if (KNOWN_SCRIPTS[g]) return KNOWN_SCRIPTS[g];
  const p = g && P.pathOf(g);
  return p ? path.basename(p).replace(/\.cs$/, '') : 'MonoBehaviour(' + g + ')';
}
const nodePath = (g) => { const a = []; while (g) { a.unshift(g.go.data.m_Name); g = g.parent; } return a.join('/'); };
const compOwner = new Map();
for (const [, g] of gos) for (const c of g.components) compOwner.set(c.id, g);
function refTarget(ref) {
  if (isNullRef(ref)) return null;
  if (ref.guid) {
    const p = P.pathOf(ref.guid);
    if (p && /\.(png|jpe?g|psd|tga|webp)$/i.test(p)) return { sprite: spriteRef(ref) };
    return { asset: p ? rel(p) : ref.guid };
  }
  const id = normId(ref.fileID);
  if (gos.has(id)) return { path: nodePath(gos.get(id)) };
  const owner = compOwner.get(id);
  if (owner) { const c = owner.components.find((x) => x.id === id); return { path: nodePath(owner), component: scriptName(c) }; }
  return { missing: id };
}

// ------------------------------------------------------------------------------------------ sprites

const sprites = {};
const spriteUse = new Map(); // key -> { paths:Set, drawn: longest canvas size a Simple image draws it at, sliced: bool }
function spriteRef(ref, usedAt, drawn = 0, sliced = false) {
  if (isNullRef(ref)) return null;
  const key = ref.guid + ':' + normId(ref.fileID);
  if (!sprites[key]) sprites[key] = describeSprite(ref.guid, normId(ref.fileID));
  const u = spriteUse.get(key) || { paths: new Set(), drawn: 0, sliced: false };
  if (usedAt) u.paths.add(usedAt);
  u.drawn = Math.max(u.drawn, drawn);
  u.sliced ||= sliced;
  spriteUse.set(key, u);
  return key;
}
function webAssetPath(abs, base) {
  const r = rel(abs).replace(/^Assets\//, '');
  return base + '/' + r.split('/').map((s) => s.replace(/[^A-Za-z0-9._()-]+/g, '_')).join('/');
}
function describeSprite(guid, fid) {
  if (guid === '0000000000000000f000000000000000') {
    const n = BUILTIN_SPRITES[+fid] || 'builtin' + fid;
    return { name: n, builtin: true, file: null, border: ['UISprite', 'Background', 'InputFieldBackground'].includes(n) ? [10, 10, 10, 10] : [0, 0, 0, 0], ppu: 100, rect: [0, 0, 32, 32] };
  }
  const abs = P.pathOf(guid);
  if (!abs) return { name: null, missing: true, guid, ppu: 100, rect: [0, 0, 1, 1], border: [0, 0, 0, 0] };
  const meta = readMeta(abs) || {};
  const ti = meta.TextureImporter || {};
  const size = imageSize(abs);
  const info = { name: path.basename(abs, path.extname(abs)), unity: rel(abs), file: null, texture: size ? [size.w, size.h] : null, ppu: num(ti.spritePixelsToUnits, 100) };
  const plats = ti.platformSettings || [];
  const web = plats.find((p) => p.buildTarget === 'WebGL' && p.overridden === '1');
  const def = plats.find((p) => p.buildTarget === 'DefaultTexturePlatform');
  info.maxTextureSize = num((web || def || {}).maxTextureSize, num(ti.maxTextureSize, 2048));
  const ext = path.extname(abs).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) info.file = webAssetPath(abs, 'assets/menu');
  else info.note = `source is ${ext} — not browser-native`;
  const sheet = ti.spriteSheet?.sprites || [];
  let entry = null;
  if (fid !== '21300000' || num(ti.spriteMode, 1) === 2) {
    entry = sheet.find((s) => normId(s.internalID) === fid);
    if (!entry) for (const t of ti.internalIDToNameTable || []) { const k = t.first && Object.values(t.first)[0]; if (normId(k) === fid) { entry = sheet.find((s) => s.name === t.second); break; } }
    if (!entry && ti.fileIDToRecycleName?.[fid]) entry = sheet.find((s) => s.name === ti.fileIDToRecycleName[fid]);
  }
  const toBorder = (b) => [num(b?.x), num(b?.y), num(b?.z), num(b?.w)];
  if (entry) {
    const rr = entry.rect || {};
    info.name = entry.name; info.subSprite = entry.name;
    info.rect = [num(rr.x), num(rr.y), num(rr.width), num(rr.height)];
    info.border = toBorder(entry.border);
  } else {
    info.rect = size ? [0, 0, size.w, size.h] : [0, 0, 1, 1];
    info.border = toBorder(ti.spriteBorder);
  }
  return info;
}
/** Decides each texture's export scale once every use is known; fills exportSize / borderExported / rectExported. */
function finalizeSprites() {
  const byFile = new Map();
  for (const [key, s] of Object.entries(sprites)) {
    if (!s.file || !s.texture) continue;
    const u = spriteUse.get(key) || { drawn: 0, sliced: false };
    const f = byFile.get(s.file) || { abs: P.pathOf(key.split(':')[0]), tex: s.texture, max: s.maxTextureSize, drawn: 0, sliced: false, sub: false, keys: [] };
    f.drawn = Math.max(f.drawn, u.drawn * (s.subSprite ? s.texture[0] / Math.max(1, s.rect[2]) : 1));
    f.sliced ||= u.sliced; f.sub ||= !!s.subSprite; f.keys.push(key);
    byFile.set(s.file, f);
  }
  const copies = [];
  for (const [file, f] of byFile) {
    const longest = Math.max(...f.tex);
    let cap = Math.min(EXPORT_MULT * f.max, CAP_MAX);
    if (f.sliced || f.sub) cap = Math.min(cap, Math.max(CAP_SLICED, f.sub ? 2048 : 0));
    else cap = Math.min(cap, Math.max(256, Math.ceil(f.drawn * (f.drawn >= 1000 ? 1.1 : EXPORT_MULT)))); // screen-size art: ~its drawn size
    const scale = /\.png$/i.test(file) ? Math.min(1, cap / longest) : 1;
    const out = [Math.round(f.tex[0] * scale), Math.round(f.tex[1] * scale)];
    for (const k of f.keys) {
      const s = sprites[k];
      s.exportSize = out;
      if (scale < 1) {
        s.borderExported = s.border.map((v) => r4(v * scale));
        const H = s.texture[1];
        s.rectExported = [s.rect[0], H - s.rect[1] - s.rect[3], s.rect[2], s.rect[3]].map((v) => r4(v * scale));
      } else if (s.subSprite) {
        const H = s.texture[1];
        s.rectExported = [s.rect[0], H - s.rect[1] - s.rect[3], s.rect[2], s.rect[3]];
      }
      delete s.maxTextureSize;
    }
    copies.push({ abs: f.abs, file, scale });
  }
  return copies;
}

// ------------------------------------------------------------------------------------------ fonts + TMP materials

const fonts = {};
const materials = {};
const fontCopies = new Map();
function fontAsset(ref) {
  if (isNullRef(ref) || !ref.guid) return null;
  const guid = ref.guid;
  if (fonts[guid]) return guid;
  const abs = P.pathOf(guid);
  const info = { unity: abs ? rel(abs) : null };
  fonts[guid] = info;
  if (!abs) return guid;
  const docs = parseUnityFile(abs, { skipClasses: [28] });
  const fa = docs.find((d) => d.classId === 114 && (d.data.m_FaceInfo || d.data.m_fontInfo));
  if (fa) {
    const d = fa.data, fi = d.m_FaceInfo || {};
    info.name = d.m_Name;
    info.faceInfo = { familyName: fi.m_FamilyName, pointSize: num(fi.m_PointSize), lineHeight: num(fi.m_LineHeight), ascentLine: num(fi.m_AscentLine), descentLine: num(fi.m_DescentLine), capLine: num(fi.m_CapLine), baseline: num(fi.m_Baseline) };
    const srcGuid = d.m_SourceFontFile?.guid || d.m_SourceFontFileGUID || d.m_CreationSettings?.sourceFontFileGUID;
    const src = srcGuid && P.pathOf(srcGuid);
    if (src) { info.sourceFont = rel(src); info.file = webAssetPath(src, 'assets/fonts'); fontCopies.set(src, info.file); }
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
  const kw = (Array.isArray(d.m_ValidKeywords) ? d.m_ValidKeywords : String(d.m_ShaderKeywords || '').split(/\s+/)).filter(Boolean);
  const floats = {}; for (const f of d.m_SavedProperties?.m_Floats || []) Object.assign(floats, f);
  const cols = {}; for (const c of d.m_SavedProperties?.m_Colors || []) Object.assign(cols, c);
  const pickF = (k) => (k in floats ? r4(num(floats[k])) : undefined);
  info.outline = { enabled: kw.includes('OUTLINE_ON') || (pickF('_OutlineWidth') || 0) > 0, width: pickF('_OutlineWidth'), color: color(cols._OutlineColor) };
  info.underlay = { enabled: kw.includes('UNDERLAY_ON') || kw.includes('UNDERLAY_INNER'), color: color(cols._UnderlayColor), offsetX: pickF('_UnderlayOffsetX'), offsetY: pickF('_UnderlayOffsetY'), dilate: pickF('_UnderlayDilate'), softness: pickF('_UnderlaySoftness') };
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
const SKIP_FIELDS = new Set(['m_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_Name', 'm_EditorClassIdentifier']);

function fieldsOf(c) {
  const out = {};
  const conv = (v) => {
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object') { if ('fileID' in v) return refTarget(v); if ('r' in v && 'g' in v && 'b' in v && 'a' in v) return color(v); const o = {}; for (const k of Object.keys(v)) o[k] = conv(v[k]); return o; }
    return v;
  };
  for (const [k, v] of Object.entries(c.data)) if (!SKIP_FIELDS.has(k)) out[k] = conv(v);
  return out;
}
function persistentCalls(ev) {
  return (ev?.m_PersistentCalls?.m_Calls || []).map((k) => {
    const a = k.m_Arguments || {};
    const mode = num(k.m_Mode, 1); // 1 Void? (0 EventDefined, 1 Void, 2 Object, 3 Int, 4 Float, 5 String, 6 Bool)
    const arg = mode === 6 ? a.m_BoolArgument === '1' : mode === 3 ? num(a.m_IntArgument) : mode === 4 ? num(a.m_FloatArgument) : mode === 5 ? (a.m_StringArgument ?? '') : mode === 2 ? refTarget(a.m_ObjectArgument) : null;
    return { target: refTarget(k.m_Target), method: k.m_MethodName, mode, arg, callState: num(k.m_CallState, 2) };
  });
}
function imageComp(c, at, size) {
  const d = c.data;
  const type = IMAGE_TYPE[num(d.m_Type)] || d.m_Type;
  return {
    enabled: d.m_Enabled !== '0', sprite: spriteRef(d.m_Sprite, at, Math.max(size[0], size[1]), type !== 'Simple' && type !== 'Filled'), color: color(d.m_Color),
    type, preserveAspect: d.m_PreserveAspect === '1', fillCenter: d.m_FillCenter !== '0',
    fillMethod: FILL_METHOD[num(d.m_FillMethod)], fillAmount: r4(num(d.m_FillAmount, 1)), fillClockwise: d.m_FillClockwise !== '0', fillOrigin: num(d.m_FillOrigin),
    pixelsPerUnitMultiplier: r4(num(d.m_PixelsPerUnitMultiplier, 1)), raycastTarget: d.m_RaycastTarget !== '0',
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
    fontStyle: styles, color: color(d.m_fontColor) || color32(d.m_fontColor32?.rgba),
    alignH: H_ALIGN[h] || h, alignV: V_ALIGN[v] || v,
    wrapping: d.m_TextWrappingMode !== undefined ? num(d.m_TextWrappingMode) !== 0 : d.m_enableWordWrapping === '1',
    overflow: OVERFLOW[num(d.m_overflowMode)] || d.m_overflowMode,
    characterSpacing: r4(num(d.m_characterSpacing)), lineSpacing: r4(num(d.m_lineSpacing)),
    margin: v4(d.m_margin), richText: d.m_isRichText !== '0', raycastTarget: d.m_RaycastTarget !== '0',
  };
  if (d.m_enableVertexGradient === '1') out.vertexGradient = { topLeft: color(d.m_fontColorGradient?.topLeft), topRight: color(d.m_fontColorGradient?.topRight), bottomLeft: color(d.m_fontColorGradient?.bottomLeft), bottomRight: color(d.m_fontColorGradient?.bottomRight) };
  return out;
}
function selectableBase(d) {
  const cs = d.m_Colors || {};
  return {
    interactable: d.m_Interactable !== '0', transition: TRANSITION[num(d.m_Transition)] || d.m_Transition,
    colors: { normal: color(cs.m_NormalColor), highlighted: color(cs.m_HighlightedColor), pressed: color(cs.m_PressedColor), selected: color(cs.m_SelectedColor), disabled: color(cs.m_DisabledColor), colorMultiplier: num(cs.m_ColorMultiplier, 1), fadeDuration: num(cs.m_FadeDuration, 0.1) },
    spriteState: { highlighted: spriteRef(d.m_SpriteState?.m_HighlightedSprite), pressed: spriteRef(d.m_SpriteState?.m_PressedSprite), disabled: spriteRef(d.m_SpriteState?.m_DisabledSprite) },
    targetGraphic: refTarget(d.m_TargetGraphic),
  };
}
const FITS = ['Unconstrained', 'MinSize', 'PreferredSize'];
const ASPECT = ['None', 'WidthControlsHeight', 'HeightControlsWidth', 'FitInParent', 'EnvelopeParent'];
const CONTENT_TYPE = ['Standard', 'Autocorrected', 'IntegerNumber', 'DecimalNumber', 'Alphanumeric', 'Name', 'EmailAddress', 'Password', 'Pin', 'Custom'];
const others = new Set();

function describeComponents(g, at, size) {
  const out = {};
  const extra = [];
  for (const c of g.components) {
    if (c.classId === 4 || c.classId === 224 || c.classId === 222) continue;
    const n = scriptName(c);
    const d = c.data;
    const on = d.m_Enabled !== '0';
    switch (n) {
      case 'Image': out.image = imageComp(c, at, size); break;
      case 'RawImage': out.rawImage = { texture: refTarget(d.m_Texture), color: color(d.m_Color) }; break;
      case 'TextMeshProUGUI': out.text = tmpComp(c); break;
      case 'Button': out.button = { ...selectableBase(d), onClick: persistentCalls(d.m_OnClick) }; break;
      case 'Toggle': out.toggle = { ...selectableBase(d), isOn: d.m_IsOn === '1', graphic: refTarget(d.graphic), group: refTarget(d.m_Group), onValueChanged: persistentCalls(d.onValueChanged) }; break;
      case 'Slider': out.slider = { ...selectableBase(d), direction: ['LeftToRight', 'RightToLeft', 'BottomToTop', 'TopToBottom'][num(d.m_Direction)], min: num(d.m_MinValue), max: num(d.m_MaxValue, 1), value: num(d.m_Value), wholeNumbers: d.m_WholeNumbers === '1', fillRect: refTarget(d.m_FillRect), handleRect: refTarget(d.m_HandleRect) }; break;
      case 'Scrollbar': out.scrollbar = { ...selectableBase(d), direction: num(d.m_Direction), value: num(d.m_Value), size: num(d.m_Size, 1), handleRect: refTarget(d.m_HandleRect) }; break;
      case 'ScrollRect': out.scrollRect = { enabled: on, content: refTarget(d.m_Content), viewport: refTarget(d.m_Viewport), horizontal: d.m_Horizontal === '1', vertical: d.m_Vertical !== '0', movementType: ['Unrestricted', 'Elastic', 'Clamped'][num(d.m_MovementType, 1)], elasticity: num(d.m_Elasticity, 0.1), inertia: d.m_Inertia !== '0', decelerationRate: num(d.m_DecelerationRate, 0.135), scrollSensitivity: num(d.m_ScrollSensitivity, 1), verticalScrollbar: refTarget(d.m_VerticalScrollbar), horizontalScrollbar: refTarget(d.m_HorizontalScrollbar) }; break;
      case 'TMP_InputField': out.inputField = { ...selectableBase(d), textViewport: refTarget(d.m_TextViewport), textComponent: refTarget(d.m_TextComponent), placeholder: refTarget(d.m_Placeholder), text: d.m_Text ?? '', characterLimit: num(d.m_CharacterLimit), contentType: CONTENT_TYPE[num(d.m_ContentType)], lineType: ['SingleLine', 'MultiLineSubmit', 'MultiLineNewline'][num(d.m_LineType)], caretColor: color(d.m_CaretColor), selectionColor: color(d.m_SelectionColor), pointSize: num(d.m_GlobalPointSize), readOnly: d.m_ReadOnly === '1' }; break;
      case 'CanvasGroup': out.canvasGroup = { enabled: on, alpha: r4(num(d.m_Alpha, 1)), interactable: d.m_Interactable !== '0', blocksRaycasts: d.m_BlocksRaycasts !== '0', ignoreParentGroups: d.m_IgnoreParentGroups === '1' }; break;
      case 'Mask': out.mask = { enabled: on, showMaskGraphic: d.m_ShowMaskGraphic !== '0' }; break;
      case 'RectMask2D': out.rectMask2D = { enabled: on, padding: v4(d.m_Padding), softness: v2(d.m_Softness) }; break;
      case 'HorizontalLayoutGroup': case 'VerticalLayoutGroup': case 'GridLayoutGroup':
        out.layoutGroup = { kind: n, enabled: on, padding: d.m_Padding ? { left: num(d.m_Padding.m_Left), right: num(d.m_Padding.m_Right), top: num(d.m_Padding.m_Top), bottom: num(d.m_Padding.m_Bottom) } : { left: 0, right: 0, top: 0, bottom: 0 }, spacing: d.m_Spacing && typeof d.m_Spacing === 'object' ? v2(d.m_Spacing) : num(d.m_Spacing), childAlignment: TEXT_ANCHOR[num(d.m_ChildAlignment)], reverse: d.m_ReverseArrangement === '1', controlW: d.m_ChildControlWidth === '1', controlH: d.m_ChildControlHeight === '1', expandW: d.m_ChildForceExpandWidth === '1', expandH: d.m_ChildForceExpandHeight === '1', scaleW: d.m_ChildScaleWidth === '1', scaleH: d.m_ChildScaleHeight === '1', cellSize: d.m_CellSize ? v2(d.m_CellSize) : undefined, constraint: num(d.m_Constraint), constraintCount: num(d.m_ConstraintCount) };
        break;
      case 'ContentSizeFitter': out.contentSizeFitter = { horizontal: FITS[num(d.m_HorizontalFit)], vertical: FITS[num(d.m_VerticalFit)] }; break;
      case 'LayoutElement': out.layoutElement = { ignoreLayout: d.m_IgnoreLayout === '1', minWidth: num(d.m_MinWidth, -1), minHeight: num(d.m_MinHeight, -1), preferredWidth: num(d.m_PreferredWidth, -1), preferredHeight: num(d.m_PreferredHeight, -1), flexibleWidth: num(d.m_FlexibleWidth, -1), flexibleHeight: num(d.m_FlexibleHeight, -1) }; break;
      case 'AspectRatioFitter': out.aspectRatioFitter = { enabled: on, aspectMode: ASPECT[num(d.m_AspectMode)], aspectRatio: r4(num(d.m_AspectRatio, 1)) }; break;
      case 'Outline': case 'Shadow': out[n === 'Outline' ? 'uiOutline' : 'uiShadow'] = { color: color(d.m_EffectColor), distance: v2(d.m_EffectDistance), useGraphicAlpha: d.m_UseGraphicAlpha !== '0' }; break;
      case 'Canvas': case 'CanvasScaler': case 'GraphicRaycaster': break;
      default:
        if (SCRIPT_FIELDS.has(n)) extra.push({ script: n, enabled: on, fields: fieldsOf(c) });
        else { extra.push(n); others.add(n); }
    }
  }
  if (extra.length) out.other = extra;
  return out;
}

// ------------------------------------------------------------------------------------------ tree export

// Sizes for sprite export decisions only (the runtime lays out with the authored rects).
function sizeOf(t, parentSize) {
  if (!t) return [0, 0];
  const aMin = v2(t.m_AnchorMin), aMax = v2(t.m_AnchorMax), sd = v2(t.m_SizeDelta), sc = v3(t.m_LocalScale);
  return [((aMax[0] - aMin[0]) * parentSize[0] + sd[0]) * Math.abs(sc[0] || 1), ((aMax[1] - aMin[1]) * parentSize[1] + sd[1]) * Math.abs(sc[1] || 1)];
}

function exportTree(g, parentSize, isRoot) {
  const p = nodePath(g);
  const t = g.transform?.data;
  const node = { name: g.go.data.m_Name, path: p, active: g.go.data.m_IsActive !== '0' };
  let size = parentSize;
  if (t && g.transform.classId === 224) {
    node.rect = {
      anchorMin: v2(t.m_AnchorMin), anchorMax: v2(t.m_AnchorMax), anchoredPosition: v2(t.m_AnchoredPosition), sizeDelta: v2(t.m_SizeDelta), pivot: v2(t.m_Pivot),
      euler: quatToEuler(q7(t.m_LocalRotation)), scale: v3(t.m_LocalScale),
    };
    if (!isRoot) size = sizeOf(t, parentSize);
  } else if (t) node.transform = { position: v3(t.m_LocalPosition), scale: v3(t.m_LocalScale) };
  const comps = describeComponents(g, p, size);
  if (Object.keys(comps).length) node.components = comps;
  const kids = g.children.map((c) => exportTree(c, size, false));
  if (kids.length) node.children = kids;
  return node;
}

function canvasEntry(g) {
  const canvas = g.components.find((c) => c.classId === 223);
  const scalerC = g.components.find((c) => scriptName(c) === 'CanvasScaler');
  const cd = canvas.data, sd = scalerC?.data || {};
  return {
    name: g.go.data.m_Name, path: nodePath(g), role: 'nomad-screen', activeAtLoad: g.go.data.m_IsActive !== '0',
    prefab: g.transform?.prefab || null,
    renderMode: ['ScreenSpaceOverlay', 'ScreenSpaceCamera', 'WorldSpace'][num(cd.m_RenderMode)], sortingOrder: num(cd.m_SortingOrder), overrideSorting: cd.m_OverrideSorting === '1',
    scaler: scalerC ? {
      uiScaleMode: ['ConstantPixelSize', 'ScaleWithScreenSize', 'ConstantPhysicalSize'][num(sd.m_UiScaleMode)], referenceResolution: v2(sd.m_ReferenceResolution),
      screenMatchMode: ['MatchWidthOrHeight', 'Expand', 'Shrink'][num(sd.m_ScreenMatchMode)], matchWidthOrHeight: num(sd.m_MatchWidthOrHeight), referencePixelsPerUnit: num(sd.m_ReferencePixelsPerUnit, 100),
    } : null,
    root: exportTree(g, [1920, 1080], true),
  };
}

const roots = [...gos.values()].filter((g) => !g.parent);
const canvases = [];
for (const name of SCREENS) {
  const g = roots.find((r) => r.go.data.m_Name === name);
  if (!g) { console.warn('missing screen', name); continue; }
  canvases.push(canvasEntry(g));
}

// ThemeLibrary room + felt (table select's preview, NomadUiHost.PaintThemePreview; every pack has a tableBackground, so preview is not needed).
const THEME_ENUM = ['Default', 'Neon_City', 'Forest', 'Desert', 'Town'];
const themeLib = parseUnityFile(path.join(ROOT, 'Assets/Resources/ThemeLibrary.asset'))[0].data;
const themes = (themeLib.packs || []).map((pk) => ({
  theme: THEME_ENUM[num(pk.theme)], displayName: pk.displayName,
  tableBackground: spriteRef(pk.tableBackground, 'ThemeLibrary.tableBackground', 1400), board: spriteRef(pk.board, 'ThemeLibrary.board', 700),
}));

// ------------------------------------------------------------------------------------------ write + copy

const copies = finalizeSprites();
const out = {
  generatedBy: 'web/tools/extract-unity-menu.mjs', scene: SCENE, generatedAt: new Date().toISOString(),
  conventions: {
    rect: 'Unity RectTransform values as authored (anchors 0..1, y up). Screen roots: size comes from the CanvasScaler at runtime (NomadCanvasFit switches every ScaleWithScreenSize canvas to Expand).',
    calls: 'button.onClick / toggle.onValueChanged: persistent calls. target.path is a node path from a screen root ("MainMenu/SideTabs_Expanded"); mode 6 = bool argument (SetActive), callState 2 = RuntimeOnly (on).',
    sprites: 'Image.sprite is a key into sprites{}. file is under web/public at exportSize; border/rect in SOURCE pixels (rect y up), borderExported/rectExported (y down) in the exported file. Border order: left, bottom, right, top.',
    other: 'Project scripts the menu reads are listed with their serialized fields (refs: {path} node, {sprite} key, {asset} file).',
  },
  canvases, themes, sprites, fonts, materials,
};
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out));
console.log('Wrote', rel(OUT_JSON), (fs.statSync(OUT_JSON).size / 1024).toFixed(0) + 'KB;', canvases.length, 'screens;', Object.keys(sprites).length, 'sprites');
if (others.size) console.log('Components not read (no web behaviour needed):', [...others].join(', '));

let bytes = 0, files = 0;
const copied = [];
for (const c of copies) {
  if (!c.abs) continue;
  const dst = path.join(WEB, 'public', c.file);
  let buf = fs.readFileSync(c.abs), resized = null;
  if (/.png$/i.test(c.abs)) {
    // Always re-encode: many art PNGs are stored nearly uncompressed (a 768² panel was 2.3 MB).
    const img = decodePng(buf);
    if (img) {
      let out = img;
      if (c.scale < 1) { const nw = Math.max(1, Math.round(img.width * c.scale)), nh = Math.max(1, Math.round(img.height * c.scale)); out = resizeRgba(img, nw, nh); resized = [nw, nh]; }
      const enc = encodePng(out);
      if (enc.length < buf.length || resized) buf = enc;
    } else console.warn('could not decode (copied as is):', rel(c.abs));
  }
  if (COPY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  bytes += buf.length; files++;
  copied.push({ src: rel(c.abs), web: c.file, size: buf.length, resized });
}
for (const [src, w] of fontCopies) {
  const dst = path.join(WEB, 'public', w);
  if (!fs.existsSync(dst) && COPY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); console.log('copied font', w); }
}

const usesByFile = new Map();
for (const [key, s] of Object.entries(sprites)) {
  if (!s.file) continue;
  const u = usesByFile.get(s.file) || new Set();
  for (const p of spriteUse.get(key)?.paths || []) u.add(p.split('/').slice(0, 3).join('/'));
  usesByFile.set(s.file, u);
}
let md = `# Nomad menu assets (from Unity)\n\nGenerated by \`web/tools/extract-unity-menu.mjs\` from \`${SCENE}\` (+ \`Assets/Resources/ThemeLibrary.asset\` previews) — re-run it rather than editing by hand.\n\n` +
  `${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB. Rects / 9-slice borders per sprite are in \`web/src/data/menu-ui.json\` → \`sprites\`. Fonts: the table HUD's (\`web/public/assets/fonts\`).\n\n` +
  `| File (web/public/…) | Unity source | Size | Used by |\n|---|---|---|---|\n`;
for (const c of copied.sort((a, b) => a.web.localeCompare(b.web))) {
  const u = [...(usesByFile.get(c.web) || [])];
  md += `| \`${c.web}\` | \`${c.src}\` | ${(c.size / 1024).toFixed(0)} KB${c.resized ? ' (' + c.resized.join('×') + ')' : ''} | ${(u.slice(0, 4).join('; ') + (u.length > 4 ? `; +${u.length - 4} more` : '')).replace(/\|/g, '\\|') || '—'} |\n`;
}
const notCopied = Object.entries(sprites).filter(([, s]) => !s.file);
if (notCopied.length) { md += `\n## Not copied\n\n`; for (const [k, s] of notCopied) md += `- \`${k}\` ${s.name || ''}: ${s.builtin ? 'Unity built-in UI sprite (drawn as a rounded rect)' : s.note || (s.missing ? 'GUID not found' : '')}\n`; }
if (COPY) { fs.mkdirSync(OUT_ASSETS, { recursive: true }); fs.writeFileSync(path.join(OUT_ASSETS, 'MANIFEST.md'), md); }
console.log(`Assets: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB${COPY ? ' copied' : ' (dry run)'}`);

// WebP + right-size what was just copied (or, without copying, point the JSON at the existing WebP files).
await optimizeAssets({ dirs: ['menu'], convert: COPY });
