#!/usr/bin/env node
// Extracts the Unity UI the web3 screens draw, so they match the Unity client 1:1.
//
//   node web/tools/extract-web3-ui.mjs [--no-copy]
//
// Reads (never writes) Assets/. Writes:
//   web/src/data/web3-ui.json        RectTransform trees (same node shape src/hud/unityUi.ts buildNode takes, plus
//                                    Button / ScrollRect / Scrollbar / Mask / layout groups / ContentSizeFitter /
//                                    LayoutElement) of
//                                      - Assets/Resources/SolanaUnitySDK/WalletAdapterUI.prefab     (the wallet picker)
//                                      - Assets/Resources/SolanaUnitySDK/WalletAdapterButton.prefab (one row of it)
//                                    and the Resources/BuyInTables sprites Net/PrivateBuyInPrompt.cs loads by name
//                                    ("bg 4", "scroll bg 1", "yellow scroll 1", "join green 1"); sprites, fonts.
//   web/public/assets/web3/ui/**     those sprites (re-encoded / resized), MANIFEST.md (web/public/assets/web3/)
//
// The cash-out dialog (CashOut_Panel in Assets/Test/Test.unity) is NOT re-extracted here: extract-unity-hud.mjs
// already exports it with the table HUD's overlay canvas (unity-hud.json, sprites in assets/ui) and its Animator
// controller (ui-anims.json), and the web3 screen builds it from there.
//
// Component readers are trimmed copies of extract-unity-menu.mjs's (that script runs on import, so it can't be
// imported); prefab resolution is ./lib/unity-yaml.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnityProject, buildHierarchy, normId, parseUnityFile, readMeta, imageSize } from './lib/unity-yaml.mjs';
import { decodePng, resizeRgba, encodePng } from './lib/png.mjs';
import { optimizeAssets } from './optimize-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const OUT_JSON = path.join(WEB, 'src/data/web3-ui.json');
const OUT_ASSETS = path.join(WEB, 'public/assets/web3');
const ASSET_BASE = 'assets/web3/ui';
const COPY = !process.argv.includes('--no-copy');

const PREFABS = {
  walletAdapterUI: 'Assets/Resources/SolanaUnitySDK/WalletAdapterUI.prefab',
  walletAdapterButton: 'Assets/Resources/SolanaUnitySDK/WalletAdapterButton.prefab',
};
// PrivateBuyInPrompt.Load(name) = Resources.Load<Sprite>("BuyInTables/" + name), with the size it draws each at.
const BUY_IN_SPRITES = { 'bg 4': [640, 280], 'scroll bg 1': [560, 36], 'yellow scroll 1': [548, 22], 'join green 1': [280, 64] };

const CAP_SLICED = 1024;
const EXPORT_MULT = 2;

const KNOWN_SCRIPTS = {
  fe87c0e1cc204ed48ad3b37840f39efc: 'Image', '4e29b1a8efbd4b44bb3f3716e73f07ff': 'Button',
  '0cd44c1031e13a943bb63640046fad76': 'CanvasScaler', dc42784cf147c0c48a680349fa168899: 'GraphicRaycaster',
  f4688fdb7df04437aeb418b961361dc5: 'TextMeshProUGUI', '31a19414c41e5ae4aae2af33fee712f6': 'Mask',
  '3312d7739989d2b4e91e6319e9a96d76': 'RectMask2D', '30649d3a9faa99c48a7b1166b86bf2a0': 'HorizontalLayoutGroup',
  '59f8146938fff824cb5fd77236b75775': 'VerticalLayoutGroup', '3245ec927659c4140ac4f8d17403cc18': 'ContentSizeFitter',
  '306cc8c2b49d7114eaa3623786fc2126': 'LayoutElement', '1aa08ab6e0800fa44ae55d278d1423e3': 'ScrollRect',
  '2a4db7a114972834c8e4117be1d82ba3': 'Toggle', '67db9e8f0e2ae9c40bc1e2b64352a6b4': 'Slider',
};
const BUILTIN_SPRITES = { 10905: 'UISprite', 10907: 'Background', 10909: 'InputFieldBackground', 10911: 'Knob', 10913: 'Checkmark', 10915: 'DropdownArrow', 10917: 'UIMask' };

const P = new UnityProject(ROOT);
const num = (v, d = 0) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const r4 = (n) => (typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : n);
const v2 = (o) => [r4(num(o?.x)), r4(num(o?.y))];
const v3 = (o) => [r4(num(o?.x)), r4(num(o?.y)), r4(num(o?.z))];
const v4 = (o) => [r4(num(o?.x)), r4(num(o?.y)), r4(num(o?.z)), r4(num(o?.w, 1))];
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
function quatZ(q) {
  const x = num(q?.x), y = num(q?.y), z = num(q?.z), w = num(q?.w, 1);
  return r4(Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI);
}

// ------------------------------------------------------------------------------------------ sprites

const sprites = {};
const spriteUse = new Map(); // key -> { paths:Set, drawn, sliced }
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
function webAssetPath(abs) {
  const r = rel(abs).replace(/^Assets\//, '');
  return ASSET_BASE + '/' + r.split('/').map((s) => s.replace(/[^A-Za-z0-9._()-]+/g, '_')).join('/');
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
  if (/\.(png|jpe?g)$/i.test(abs)) info.file = webAssetPath(abs);
  const toBorder = (b) => [num(b?.x), num(b?.y), num(b?.z), num(b?.w)];
  const sheet = ti.spriteSheet?.sprites || [];
  const entry = fid !== '21300000' || num(ti.spriteMode, 1) === 2 ? sheet.find((s) => normId(s.internalID) === fid) : null;
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
/** Export scale per texture: Unity's import size, at most 2x what the screens draw (min 128), sliced at most 1024. */
function finalizeSprites() {
  const copies = [];
  const byFile = new Map();
  for (const [key, s] of Object.entries(sprites)) {
    if (!s.file || !s.texture) continue;
    const u = spriteUse.get(key) || { drawn: 0, sliced: false };
    const f = byFile.get(s.file) || { abs: P.pathOf(key.split(':')[0]), tex: s.texture, max: s.maxTextureSize, drawn: 0, sliced: false, keys: [] };
    f.drawn = Math.max(f.drawn, u.drawn);
    f.sliced ||= u.sliced;
    f.keys.push(key);
    byFile.set(s.file, f);
  }
  for (const [file, f] of byFile) {
    const longest = Math.max(...f.tex);
    let cap = Math.min(EXPORT_MULT * f.max, 2048);
    cap = f.sliced ? Math.min(cap, CAP_SLICED) : Math.min(cap, Math.max(128, Math.ceil(f.drawn * EXPORT_MULT)));
    const scale = Math.min(1, cap / longest);
    const out = [Math.round(f.tex[0] * scale), Math.round(f.tex[1] * scale)];
    for (const k of f.keys) {
      const s = sprites[k];
      s.exportSize = out;
      if (scale < 1) s.borderExported = s.border.map((v) => r4(v * scale));
      delete s.maxTextureSize;
    }
    copies.push({ abs: f.abs, file, scale });
  }
  return copies;
}

// ------------------------------------------------------------------------------------------ fonts

const fonts = {};
const fontCopies = new Map(); // source .ttf -> web path
function fontAsset(ref) {
  if (isNullRef(ref) || !ref.guid) return null;
  const guid = ref.guid;
  if (fonts[guid]) return guid;
  const abs = P.pathOf(guid);
  const info = { unity: abs ? rel(abs) : null };
  fonts[guid] = info;
  if (!abs) return guid;
  const fa = parseUnityFile(abs, { skipClasses: [28] }).find((d) => d.classId === 114 && (d.data.m_FaceInfo || d.data.m_fontInfo));
  if (fa) {
    const fi = fa.data.m_FaceInfo || {};
    info.name = fa.data.m_Name;
    info.faceInfo = { familyName: fi.m_FamilyName, pointSize: num(fi.m_PointSize), lineHeight: num(fi.m_LineHeight), ascentLine: num(fi.m_AscentLine), descentLine: num(fi.m_DescentLine) };
    const srcGuid = fa.data.m_SourceFontFile?.guid || fa.data.m_SourceFontFileGUID || fa.data.m_CreationSettings?.sourceFontFileGUID;
    const src = srcGuid && P.pathOf(srcGuid);
    if (src) { info.sourceFont = rel(src); info.file = 'assets/web3/fonts/' + path.basename(src); fontCopies.set(src, info.file); }
  }
  return guid;
}

// ------------------------------------------------------------------------------------------ components

const H_ALIGN = { 1: 'left', 2: 'center', 4: 'right', 8: 'justified', 16: 'flush', 32: 'geometry' };
const V_ALIGN = { 256: 'top', 512: 'middle', 1024: 'bottom', 2048: 'baseline', 4096: 'geometry', 8192: 'capline' };
const IMAGE_TYPE = ['Simple', 'Sliced', 'Tiled', 'Filled'];
const TRANSITION = ['None', 'ColorTint', 'SpriteSwap', 'Animation'];
const OVERFLOW = ['Overflow', 'Ellipsis', 'Masking', 'Truncate', 'ScrollRect', 'Page', 'Linked'];
const TEXT_ANCHOR = ['UpperLeft', 'UpperCenter', 'UpperRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'LowerLeft', 'LowerCenter', 'LowerRight'];
const FITS = ['Unconstrained', 'MinSize', 'PreferredSize'];

function scriptName(c) {
  if (c.classId !== 114) return { 223: 'Canvas', 222: 'CanvasRenderer', 225: 'CanvasGroup', 95: 'Animator' }[c.classId] || 'class' + c.classId;
  const g = c.data.m_Script?.guid;
  if (KNOWN_SCRIPTS[g]) return KNOWN_SCRIPTS[g];
  const p = g && P.pathOf(g);
  return p ? path.basename(p).replace(/\.cs$/, '') : 'MonoBehaviour(' + g + ')';
}
function persistentCalls(ev) {
  return (ev?.m_PersistentCalls?.m_Calls || []).map((k) => ({ target: scriptOrPath(k.m_Target), method: k.m_MethodName, mode: num(k.m_Mode, 1), arg: k.m_Arguments?.m_StringArgument ?? null }));
}
let compOwner = new Map();
let nodePathOf = () => '';
function scriptOrPath(ref) {
  if (isNullRef(ref)) return null;
  const id = normId(ref.fileID);
  const owner = compOwner.get(id);
  if (!owner) return { missing: id };
  const c = owner.components.find((x) => x.id === id);
  return { path: nodePathOf(owner), component: c ? scriptName(c) : null };
}
function describeComponents(g, at, size) {
  const out = {};
  const other = [];
  for (const c of g.components) {
    if (c.classId === 4 || c.classId === 224 || c.classId === 222) continue;
    const n = scriptName(c);
    const d = c.data;
    const on = d.m_Enabled !== '0';
    switch (n) {
      case 'Image': {
        const type = IMAGE_TYPE[num(d.m_Type)] || d.m_Type;
        out.image = {
          enabled: on, sprite: spriteRef(d.m_Sprite, at, Math.max(size[0], size[1]), type === 'Sliced' || type === 'Tiled'), color: color(d.m_Color), type,
          preserveAspect: d.m_PreserveAspect === '1', fillCenter: d.m_FillCenter !== '0', pixelsPerUnitMultiplier: r4(num(d.m_PixelsPerUnitMultiplier, 1)), raycastTarget: d.m_RaycastTarget !== '0',
        };
        break;
      }
      case 'TextMeshProUGUI': {
        let h = num(d.m_HorizontalAlignment, 0), v = num(d.m_VerticalAlignment, 0);
        if (!h && d.m_textAlignment && d.m_textAlignment !== '65535') { const a = num(d.m_textAlignment); h = a & 0xff; v = a & 0xff00; }
        const style = num(d.m_fontStyle);
        const styles = []; ['bold', 'italic', 'underline', 'lowercase', 'uppercase', 'smallcaps', 'strikethrough'].forEach((s, i) => { if (style & (1 << i)) styles.push(s); });
        out.text = {
          enabled: on, text: d.m_text ?? '', font: fontAsset(d.m_fontAsset), fontSize: r4(num(d.m_fontSize)), autoSize: d.m_enableAutoSizing === '1',
          fontSizeMin: r4(num(d.m_fontSizeMin)), fontSizeMax: r4(num(d.m_fontSizeMax)), fontStyle: styles,
          color: color(d.m_fontColor) || color32(d.m_fontColor32?.rgba), alignH: H_ALIGN[h] || h, alignV: V_ALIGN[v] || v,
          wrapping: d.m_TextWrappingMode !== undefined ? num(d.m_TextWrappingMode) !== 0 : d.m_enableWordWrapping === '1',
          overflow: OVERFLOW[num(d.m_overflowMode)] || d.m_overflowMode, margin: v4(d.m_margin), richText: d.m_isRichText !== '0',
        };
        break;
      }
      case 'Button': {
        const cs = d.m_Colors || {};
        out.button = {
          interactable: d.m_Interactable !== '0', transition: TRANSITION[num(d.m_Transition)] || d.m_Transition,
          colors: { normal: color(cs.m_NormalColor), highlighted: color(cs.m_HighlightedColor), pressed: color(cs.m_PressedColor), selected: color(cs.m_SelectedColor), disabled: color(cs.m_DisabledColor), colorMultiplier: num(cs.m_ColorMultiplier, 1), fadeDuration: num(cs.m_FadeDuration, 0.1) },
          targetGraphic: scriptOrPath(d.m_TargetGraphic), onClick: persistentCalls(d.m_OnClick),
        };
        break;
      }
      case 'Scrollbar': out.scrollbar = { direction: num(d.m_Direction), value: num(d.m_Value), size: num(d.m_Size, 1) }; break;
      case 'ScrollRect': out.scrollRect = { horizontal: d.m_Horizontal === '1', vertical: d.m_Vertical !== '0', movementType: ['Unrestricted', 'Elastic', 'Clamped'][num(d.m_MovementType, 1)], scrollSensitivity: num(d.m_ScrollSensitivity, 1), horizontalScrollbarVisibility: num(d.m_HorizontalScrollbarVisibility), verticalScrollbarVisibility: num(d.m_VerticalScrollbarVisibility) }; break;
      case 'CanvasGroup': out.canvasGroup = { alpha: r4(num(d.m_Alpha, 1)) }; break;
      case 'Mask': out.mask = { enabled: on, showMaskGraphic: d.m_ShowMaskGraphic !== '0' }; break;
      case 'RectMask2D': out.rectMask2D = { enabled: on }; break;
      case 'HorizontalLayoutGroup': case 'VerticalLayoutGroup':
        out.layoutGroup = {
          kind: n, enabled: on, padding: d.m_Padding ? { left: num(d.m_Padding.m_Left), right: num(d.m_Padding.m_Right), top: num(d.m_Padding.m_Top), bottom: num(d.m_Padding.m_Bottom) } : { left: 0, right: 0, top: 0, bottom: 0 },
          spacing: num(d.m_Spacing), childAlignment: TEXT_ANCHOR[num(d.m_ChildAlignment)], reverse: d.m_ReverseArrangement === '1',
          controlW: d.m_ChildControlWidth === '1', controlH: d.m_ChildControlHeight === '1', expandW: d.m_ChildForceExpandWidth === '1', expandH: d.m_ChildForceExpandHeight === '1',
        };
        break;
      case 'ContentSizeFitter': out.contentSizeFitter = { horizontal: FITS[num(d.m_HorizontalFit)], vertical: FITS[num(d.m_VerticalFit)] }; break;
      case 'LayoutElement': out.layoutElement = { ignoreLayout: d.m_IgnoreLayout === '1', minWidth: num(d.m_MinWidth, -1), minHeight: num(d.m_MinHeight, -1), preferredWidth: num(d.m_PreferredWidth, -1), preferredHeight: num(d.m_PreferredHeight, -1), flexibleWidth: num(d.m_FlexibleWidth, -1), flexibleHeight: num(d.m_FlexibleHeight, -1) }; break;
      case 'Canvas': out.canvas = { renderMode: ['ScreenSpaceOverlay', 'ScreenSpaceCamera', 'WorldSpace'][num(d.m_RenderMode)], sortingOrder: num(d.m_SortingOrder) }; break;
      case 'CanvasScaler': out.canvasScaler = { uiScaleMode: ['ConstantPixelSize', 'ScaleWithScreenSize', 'ConstantPhysicalSize'][num(d.m_UiScaleMode)], referenceResolution: v2(d.m_ReferenceResolution), matchWidthOrHeight: num(d.m_MatchWidthOrHeight), scaleFactor: num(d.m_ScaleFactor, 1) }; break;
      case 'GraphicRaycaster': break;
      case 'Animator': out.animator = { enabled: on, controller: d.m_Controller?.guid ? rel(P.pathOf(d.m_Controller.guid)) : null }; break;
      default: other.push(n);
    }
  }
  if (other.length) out.other = other;
  return out;
}

// ------------------------------------------------------------------------------------------ trees

function sizeOf(t, parent) {
  const aMin = v2(t.m_AnchorMin), aMax = v2(t.m_AnchorMax), sd = v2(t.m_SizeDelta);
  return [(aMax[0] - aMin[0]) * parent[0] + sd[0], (aMax[1] - aMin[1]) * parent[1] + sd[1]];
}
function exportTree(g, parentSize, isRoot) {
  const p = nodePathOf(g);
  const t = g.transform?.data;
  const node = { name: g.go.data.m_Name, path: p, active: g.go.data.m_IsActive !== '0' };
  let size = parentSize;
  if (t && g.transform.classId === 224) {
    node.rect = { anchorMin: v2(t.m_AnchorMin), anchorMax: v2(t.m_AnchorMax), anchoredPosition: v2(t.m_AnchoredPosition), sizeDelta: v2(t.m_SizeDelta), pivot: v2(t.m_Pivot), euler: [0, 0, quatZ(t.m_LocalRotation)], scale: v3(t.m_LocalScale) };
    if (!isRoot) size = sizeOf(t, parentSize);
  }
  const comps = describeComponents(g, p, size);
  if (Object.keys(comps).length) node.components = comps;
  const kids = g.children.map((c) => exportTree(c, size, false));
  if (kids.length) node.children = kids;
  return node;
}

console.log('Indexing GUIDs + resolving the SDK picker prefabs…');
const trees = {};
for (const [key, file] of Object.entries(PREFABS)) {
  const objs = P.resolve(path.join(ROOT, file));
  const { gos } = buildHierarchy(objs);
  compOwner = new Map();
  for (const [, g] of gos) for (const c of g.components) compOwner.set(c.id, g);
  nodePathOf = (g) => { const a = []; while (g) { a.unshift(g.go.data.m_Name); g = g.parent; } return a.join('/'); };
  const root = [...gos.values()].find((g) => !g.parent);
  trees[key] = { prefab: file, root: exportTree(root, [1920, 1080], true) };
}

// PrivateBuyInPrompt's art (Resources.Load<Sprite>("BuyInTables/<name>")): the texture's main sprite.
const buyInSprites = {};
for (const [name, drawn] of Object.entries(BUY_IN_SPRITES)) {
  const abs = path.join(ROOT, 'Assets/Resources/BuyInTables', name + '.png');
  const guid = readMeta(abs)?.guid;
  if (!guid) { console.warn('missing BuyInTables sprite', name); continue; }
  buyInSprites[name] = spriteRef({ fileID: '21300000', guid }, 'PrivateBuyInPrompt:' + name, Math.max(...drawn), true);
}

const copies = finalizeSprites();
const out = {
  generatedBy: 'web/tools/extract-web3-ui.mjs', generatedAt: new Date().toISOString(),
  conventions: {
    rect: 'Unity RectTransform values as authored (anchors 0..1, y up); same node shape as unity-hud.json (src/hud/unityUi.ts buildNode).',
    sprites: 'Image.sprite is a key into sprites{}. file is under web/public at exportSize; border in SOURCE pixels (left, bottom, right, top), borderExported in the exported file.',
    buyInSprites: 'PrivateBuyInPrompt.Load(name) -> sprite key.',
  },
  trees, buyInSprites, sprites, fonts,
};
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out));
console.log('Wrote', rel(OUT_JSON), (fs.statSync(OUT_JSON).size / 1024).toFixed(1) + 'KB;', Object.keys(sprites).length, 'sprites');

let md = '# web3 UI assets (from Unity)\n\nGenerated by `web/tools/extract-web3-ui.mjs`: re-run it rather than editing by hand. ' +
  'Sprite rects and 9-slice borders are in `web/src/data/web3-ui.json` → `sprites`.\n\n' +
  'Not generated: `per-attest.js` (the TEE attestation verifier bundle, see the web3 module).\n\n' +
  '| File (web/public/…) | Unity source | Size | Used by |\n|---|---|---|---|\n';
let bytes = 0;
for (const c of copies.sort((a, b) => a.file.localeCompare(b.file))) {
  let buf = fs.readFileSync(c.abs);
  let resized = null;
  const img = /\.png$/i.test(c.abs) ? decodePng(buf) : null;
  if (img) {
    let o = img;
    if (c.scale < 1) { const w = Math.max(1, Math.round(img.width * c.scale)), h = Math.max(1, Math.round(img.height * c.scale)); o = resizeRgba(img, w, h); resized = [w, h]; }
    const enc = encodePng(o);
    if (enc.length < buf.length || resized) buf = enc;
  }
  if (COPY) { const dst = path.join(WEB, 'public', c.file); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  bytes += buf.length;
  const uses = new Set();
  for (const [k, s] of Object.entries(sprites)) if (s.file === c.file) for (const u of spriteUse.get(k)?.paths || []) uses.add(u.split('/').slice(0, 2).join('/'));
  md += `| \`${c.file}\` | \`${rel(c.abs)}\` | ${(buf.length / 1024).toFixed(1)} KB${resized ? ' (' + resized.join('×') + ')' : ''} | ${[...uses].join('; ').replace(/\|/g, '\\|')} |\n`;
}
for (const [src, w] of fontCopies) {
  const buf = fs.readFileSync(src);
  if (COPY) { const dst = path.join(WEB, 'public', w); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  const tmp = Object.values(fonts).find((f) => f.file === w)?.name;
  md += `| \`${w}\` | \`${rel(src)}\` | ${(buf.length / 1024).toFixed(1)} KB | TMP font of the wallet picker (${tmp}) |\n`;
}
const notCopied = Object.entries(sprites).filter(([, s]) => !s.file);
if (notCopied.length) { md += '\n## Not copied\n\n'; for (const [k, s] of notCopied) md += `- \`${k}\` ${s.name || ''}: ${s.builtin ? 'Unity built-in UI sprite (drawn as a rounded rect)' : s.missing ? 'GUID not found' : ''}\n`; }
md += '\nThe cash-out dialog uses the table HUD\'s sprites (`assets/ui/…`, extract-unity-hud.mjs).\n';
if (COPY) { fs.mkdirSync(OUT_ASSETS, { recursive: true }); fs.writeFileSync(path.join(OUT_ASSETS, 'MANIFEST.md'), md); }
console.log(`Assets: ${copies.length} files, ${(bytes / 1024).toFixed(1)} KB${COPY ? ' copied' : ' (dry run)'}`);

// WebP + right-size what was just copied (or, without copying, point the JSON at the existing WebP files).
await optimizeAssets({ dirs: ['web3'], convert: COPY });
