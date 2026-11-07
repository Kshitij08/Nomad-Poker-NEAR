#!/usr/bin/env node
// Extracts the theme packs (ThemeManager / ThemeLibrary) and the TABLES picker UI (Theme_Panel) for the web port.
//
//   node web/tools/extract-unity-themes.mjs [--no-copy]
//
// Reads (never writes) Assets/. Writes:
//   web/src/data/theming-themes.json   ThemeLibrary packs (colours + art per ThemeSlot), Theme enum, defaults,
//                                      the Theme_Panel node tree (unityUi.ts NodeData format) + its sprites / fonts
//   web/public/assets/theming/**       pack art not already exported by the scene / HUD extractors
//   web/public/assets/theming/MANIFEST.md
//
// Art that another extractor already ships is referenced instead of copied: the HUD pot / menuButton plates
// (unity-hud.json sprites, assets/ui) and the default SOLANA felt + card backs (assets/3d, see its MANIFEST.md).
// Run after extract-unity-hud.mjs and extract-unity-scene.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnityProject, buildHierarchy, normId, parseUnityFile, readMeta, imageSize } from './lib/unity-yaml.mjs';
import { decodePng, resizeRgba, encodePng } from './lib/png.mjs';
import { optimizeAssets } from './optimize-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const OUT_JSON = path.join(WEB, 'src/data/theming-themes.json');
const OUT_DIR = path.join(WEB, 'public/assets/theming');
const COPY = !process.argv.includes('--no-copy');
const MENU_SCENE = 'Assets/Photon/FusionMenu/FusionSampleMenu_Game.unity';
// PNGs are exported at 2x Unity's import size (platform maxTextureSize), capped here and at the source size.
const EXPORT_MULT = 2;
const EXPORT_CAP = 2048;

const P = new UnityProject(ROOT);
const rel = (p) => P.rel(p);
const num = (v, d = 0) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const v2 = (o) => [r4(num(o?.x)), r4(num(o?.y))];
const v3 = (o) => [r4(num(o?.x)), r4(num(o?.y)), r4(num(o?.z))];
const v4 = (o) => [r4(num(o?.x)), r4(num(o?.y)), r4(num(o?.z)), r4(num(o?.w))];
const hex2 = (f) => Math.max(0, Math.min(255, Math.round(f * 255))).toString(16).padStart(2, '0');
function color(c) {
  if (!c) return null;
  const r = num(c.r, 1), g = num(c.g, 1), b = num(c.b, 1), a = num(c.a, 1);
  return { hex: '#' + hex2(r) + hex2(g) + hex2(b) + (a < 1 ? hex2(a) : ''), rgba: [r4(r), r4(g), r4(b), r4(a)] };
}
const isNullRef = (r) => !r || normId(r.fileID) === '0';
function quatToEuler(q) { // Unity ZXY order, degrees (only z matters for UI)
  const [x, y, z, w] = q;
  const ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI;
  const ex = Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z)))) * 180 / Math.PI;
  const ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) * 180 / Math.PI;
  return [r4(ex), r4(ey), r4(ez)];
}

// ------------------------------------------------------------------------------------------ existing exports

const hud = JSON.parse(fs.readFileSync(path.join(WEB, 'src/data/unity-hud.json'), 'utf8'));
// assets/3d/MANIFEST.md rows: | `file` | `Unity source` | …
const scene3d = new Map();
{
  const man = path.join(WEB, 'public/assets/3d/MANIFEST.md');
  if (fs.existsSync(man)) for (const m of fs.readFileSync(man, 'utf8').matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)) scene3d.set(m[2], 'assets/3d/' + m[1]);
}

// ------------------------------------------------------------------------------------------ sprites

const sprites = {}; // key -> SpriteData (unityUi.ts format)
const copies = new Map(); // abs src -> { file, scale, uses:Set }
const BUILTIN_SPRITES = { 10905: 'UISprite', 10907: 'Background', 10909: 'InputFieldBackground', 10911: 'Knob', 10913: 'Checkmark', 10915: 'DropdownArrow', 10917: 'UIMask' };

function webFile(abs) {
  const r = rel(abs).replace(/^Assets\//, '').replace(/^Test\/UI\//, '').replace(/^Resources\//, '');
  return 'assets/theming/' + r.split('/').map((s) => s.replace(/[^A-Za-z0-9._()-]+/g, '_')).join('/');
}

/** Sprite ref → key into `sprites`, describing it the way unity-hud.json does (rect, 9-slice border, exported size). */
function spriteRef(ref, usedAt, noCopy = null) {
  if (isNullRef(ref)) return null;
  const key = ref.guid + ':' + normId(ref.fileID);
  if (!sprites[key]) sprites[key] = describeSprite(ref.guid, normId(ref.fileID), noCopy);
  const s = sprites[key];
  if (usedAt && s._abs && copies.has(s._abs)) copies.get(s._abs).uses.add(usedAt);
  return key;
}

function describeSprite(guid, fid, noCopy) {
  if (guid === '0000000000000000f000000000000000') {
    const n = BUILTIN_SPRITES[+fid] || 'builtin' + fid;
    return { name: n, builtin: true, ppu: 100, rect: [0, 0, 32, 32], border: n === 'UISprite' || n === 'Background' ? [10, 10, 10, 10] : [0, 0, 0, 0] };
  }
  const abs = P.pathOf(guid);
  if (!abs) return { name: null, missing: true, guid, ppu: 100, rect: [0, 0, 1, 1], border: [0, 0, 0, 0] };
  const ti = readMeta(abs)?.TextureImporter || {};
  const size = imageSize(abs) || { w: 1, h: 1 };
  const plats = ti.platformSettings || [];
  const web = plats.find((p) => p.buildTarget === 'WebGL' && p.overridden === '1');
  const def = plats.find((p) => p.buildTarget === 'DefaultTexturePlatform');
  const effMax = num((web || def || {}).maxTextureSize, num(ti.maxTextureSize, 2048));
  const longest = Math.max(size.w, size.h);
  const info = {
    name: path.basename(abs, path.extname(abs)), unity: rel(abs), ppu: num(ti.spritePixelsToUnits, 100),
    texture: [size.w, size.h], rect: [0, 0, size.w, size.h],
    border: [num(ti.spriteBorder?.x), num(ti.spriteBorder?.y), num(ti.spriteBorder?.z), num(ti.spriteBorder?.w)],
    unityImport: { maxTextureSize: effMax, size: [Math.round(size.w * Math.min(1, effMax / longest)), Math.round(size.h * Math.min(1, effMax / longest))] },
  };
  if (num(ti.spriteMode, 1) === 2) info.note = 'multi-sprite sheet: whole texture used';
  // 1) already exported by the HUD extractor (assets/ui) → same file + exported border
  const hudHit = Object.values(hud.sprites).find((s) => s.unity === info.unity && s.file && !s.subSprite);
  // 2) already exported by the scene extractor (assets/3d)
  const sceneHit = scene3d.get(info.unity);
  // The 3D copy wins so the default felt / card backs are the very files the table loads today.
  if (sceneHit) {
    info.file = sceneHit;
    const s3 = imageSize(path.join(WEB, 'public', sceneHit));
    if (s3) info.exportSize = [s3.w, s3.h];
    info.reused = 'assets/3d';
  } else if (hudHit) {
    info.file = hudHit.file;
    if (hudHit.exportSize) info.exportSize = hudHit.exportSize;
    if (hudHit.borderExported) info.borderExported = hudHit.borderExported;
    info.reused = 'unity-hud.json';
  } else if (noCopy) {
    info.file = null;
    info.note = noCopy;
  } else {
    const ext = path.extname(abs).toLowerCase();
    const scale = ext === '.png' ? Math.min(1, Math.min(EXPORT_MULT * effMax, EXPORT_CAP) / longest) : 1;
    info.file = webFile(abs);
    info.exportSize = [Math.round(size.w * scale), Math.round(size.h * scale)];
    if (scale < 1) info.borderExported = info.border.map((v) => r4(v * scale));
    copies.set(abs, { file: info.file, scale, uses: new Set() });
  }
  Object.defineProperty(info, '_abs', { value: abs, enumerable: false });
  return info;
}

// ------------------------------------------------------------------------------------------ packs

const THEME_ENUM = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'Assets/Scripts/Game/Theming/Theme.cs'), 'utf8');
  const body = /enum\s+Theme\s*\{([\s\S]*?)\}/.exec(src)[1];
  return body.split(',').map((s) => s.replace(/\/\/.*$/gm, '').trim()).filter(Boolean);
})();
const managerSrc = fs.readFileSync(path.join(ROOT, 'Assets/Scripts/Game/Theming/ThemeManager.cs'), 'utf8');
const defaultTheme = /defaultTheme\s*=\s*Theme\.(\w+)/.exec(managerSrc)?.[1] ?? 'Default';
const prefKey = /PrefKey\s*=\s*"([^"]+)"/.exec(managerSrc)?.[1] ?? 'Poker.ActiveTheme';
const IMAGE_TYPE = ['Simple', 'Sliced', 'Tiled', 'Filled'];
const SLOTS = ['preview', 'menuButton', 'toggleTrack', 'tableBackground', 'board', 'cardBack', 'cardBackFolded', 'pot', 'panelPlate'];

const lib = parseUnityFile(path.join(ROOT, 'Assets/Resources/ThemeLibrary.asset'))[0].data;
const packs = (lib.packs || []).map((p) => {
  const theme = THEME_ENUM[num(p.theme)];
  const art = {};
  for (const k of SLOTS) art[k] = spriteRef(p[k], `ThemeLibrary ${theme}.${k}`);
  // HUD plate keys into unity-hud.json sprites (same guid:fileID key format)
  const hudKey = (k) => (art[k] && hud.sprites[art[k]] ? art[k] : null);
  return {
    theme, index: num(p.theme), displayName: p.displayName || theme,
    menuButtonType: IMAGE_TYPE[num(p.menuButtonType, 1)],
    buttonLabelColor: color(p.buttonLabelColor), accentColor: color(p.accentColor), panelColor: color(p.panelColor),
    art, hudSprites: { pot: hudKey('pot'), menuButton: hudKey('menuButton') },
  };
});

// ------------------------------------------------------------------------------------------ Theme_Panel (TABLES picker)

console.log('Resolving', MENU_SCENE, '…');
const objs = P.resolve(path.join(ROOT, MENU_SCENE));
const { gos } = buildHierarchy(objs);
const KNOWN_SCRIPTS = {
  fe87c0e1cc204ed48ad3b37840f39efc: 'Image', '4e29b1a8efbd4b44bb3f3716e73f07ff': 'Button', '0cd44c1031e13a943bb63640046fad76': 'CanvasScaler',
  f4688fdb7df04437aeb418b961361dc5: 'TextMeshProUGUI', '31a19414c41e5ae4aae2af33fee712f6': 'Mask', '30649d3a9faa99c48a7b1166b86bf2a0': 'HorizontalLayoutGroup',
  '86710e43de46f6f4bac7c8e50813a599': 'AspectRatioFitter',
};
function scriptName(c) {
  if (c.classId !== 114) return { 95: 'Animator', 225: 'CanvasGroup', 223: 'Canvas' }[c.classId] || 'class' + c.classId;
  const g = c.data.m_Script?.guid;
  if (KNOWN_SCRIPTS[g]) return KNOWN_SCRIPTS[g];
  const p = g && P.pathOf(g);
  return p ? path.basename(p).replace(/\.cs$/, '') : 'MonoBehaviour(' + g + ')';
}
const nodePath = (g) => { const a = []; while (g) { a.unshift(g.go.data.m_Name); g = g.parent; } return a.join('/'); };

// fonts (TMP font assets → source TTF/OTF)
const fonts = {};
const fontCopies = new Map();
function fontAsset(ref) {
  if (isNullRef(ref) || !ref.guid) return null;
  if (fonts[ref.guid]) return ref.guid;
  const abs = P.pathOf(ref.guid);
  const info = { unity: abs ? rel(abs) : null };
  fonts[ref.guid] = info;
  if (!abs) return ref.guid;
  const docs = parseUnityFile(abs, { skipClasses: [28] });
  const fa = docs.find((d) => d.classId === 114 && d.data.m_FaceInfo);
  if (fa) {
    const d = fa.data, fi = d.m_FaceInfo;
    info.name = d.m_Name;
    info.faceInfo = { familyName: fi.m_FamilyName, pointSize: num(fi.m_PointSize), lineHeight: num(fi.m_LineHeight), ascentLine: num(fi.m_AscentLine), descentLine: num(fi.m_DescentLine) };
    const srcGuid = d.m_SourceFontFile?.guid || d.m_SourceFontFileGUID || d.m_CreationSettings?.sourceFontFileGUID;
    const src = srcGuid && P.pathOf(srcGuid);
    if (src) {
      // Same path scheme as extract-unity-hud.mjs: reuse its copy when it shipped this font already.
      const hudFont = 'assets/fonts/' + rel(src).replace(/^Assets\//, '').split('/').map((s) => s.replace(/[^A-Za-z0-9._()-]+/g, '_')).join('/');
      if (fs.existsSync(path.join(WEB, 'public', hudFont))) info.file = hudFont;
      else {
        info.file = 'assets/theming/fonts/' + path.basename(src).replace(/[^A-Za-z0-9._()-]+/g, '_');
        fontCopies.set(src, info.file);
      }
    }
  }
  return ref.guid;
}

const H_ALIGN = { 1: 'left', 2: 'center', 4: 'right', 8: 'justified' };
const V_ALIGN = { 256: 'top', 512: 'middle', 1024: 'bottom', 2048: 'baseline', 4096: 'geometry', 8192: 'capline' };
function components(g, at) {
  const out = {};
  const other = [];
  for (const c of g.components) {
    if (c.classId === 4 || c.classId === 224 || c.classId === 222) continue;
    const n = scriptName(c);
    const d = c.data;
    if (n === 'Image') {
      out.image = {
        enabled: d.m_Enabled !== '0', sprite: spriteRef(d.m_Sprite, at, RUNTIME_REPLACED[at] ?? null), color: color(d.m_Color), type: IMAGE_TYPE[num(d.m_Type)],
        preserveAspect: d.m_PreserveAspect === '1', pixelsPerUnitMultiplier: r4(num(d.m_PixelsPerUnitMultiplier, 1)), raycastTarget: d.m_RaycastTarget !== '0',
        fillMethod: ['Horizontal', 'Vertical', 'Radial90', 'Radial180', 'Radial360'][num(d.m_FillMethod)], fillAmount: r4(num(d.m_FillAmount, 1)), fillOrigin: num(d.m_FillOrigin), fillClockwise: d.m_FillClockwise !== '0',
      };
    } else if (n === 'TextMeshProUGUI') {
      let h = num(d.m_HorizontalAlignment), v = num(d.m_VerticalAlignment);
      if (!h && d.m_textAlignment && d.m_textAlignment !== '65535') { const a = num(d.m_textAlignment); h = a & 0xff; v = a & 0xff00; }
      const style = num(d.m_fontStyle);
      const styles = []; ['bold', 'italic', 'underline', 'lowercase', 'uppercase', 'smallcaps'].forEach((s, i) => { if (style & (1 << i)) styles.push(s); });
      out.text = {
        enabled: d.m_Enabled !== '0', text: d.m_text ?? '', font: fontAsset(d.m_fontAsset), fontSize: r4(num(d.m_fontSize)), autoSize: d.m_enableAutoSizing === '1',
        fontSizeMin: r4(num(d.m_fontSizeMin)), fontSizeMax: r4(num(d.m_fontSizeMax)), fontStyle: styles, color: color(d.m_fontColor),
        alignH: H_ALIGN[h] || 'left', alignV: V_ALIGN[v] || 'top',
        wrapping: d.m_TextWrappingMode !== undefined ? num(d.m_TextWrappingMode) !== 0 : d.m_enableWordWrapping === '1',
        lineSpacing: r4(num(d.m_lineSpacing)), margin: v4(d.m_margin),
      };
    } else if (n === 'Button') {
      out.button = { interactable: d.m_Interactable !== '0', transition: ['None', 'ColorTint', 'SpriteSwap', 'Animation'][num(d.m_Transition)] };
    } else if (n === 'Mask') out.mask = { enabled: d.m_Enabled !== '0', showMaskGraphic: d.m_ShowMaskGraphic !== '0' };
    else if (n === 'CanvasGroup') out.canvasGroup = { alpha: r4(num(d.m_Alpha, 1)) };
    else if (n === 'AspectRatioFitter') out.aspectRatioFitter = { mode: ['None', 'WidthControlsHeight', 'HeightControlsWidth', 'FitInParent', 'EnvelopeParent'][num(d.m_AspectMode)], aspectRatio: r4(num(d.m_AspectRatio, 1)) };
    else if (n === 'HorizontalLayoutGroup') out.layoutGroup = { kind: n, spacing: num(d.m_Spacing), childAlignment: num(d.m_ChildAlignment) };
    else if (n === 'Animator') out.animator = { enabled: d.m_Enabled !== '0', controller: d.m_Controller?.guid ? rel(P.pathOf(d.m_Controller.guid) || '') : null };
    else if (n === 'ThemedGraphic') other.push({ script: n, slot: ['MenuBackground', 'MenuButton', 'TableBackground', 'Board', 'CardBack', 'CardBackFolded', 'Pot', 'Preview'][num(d.slot)] });
    else other.push({ script: n });
  }
  if (other.length) out.other = other;
  return out;
}

// Authored art ThemePicker always replaces before the panel is seen (ApplyPreview → pack art): not copied.
const RUNTIME_REPLACED = {
  'Canvas/FusionMenu/Theme_Panel/BG': 'replaced at runtime by the selected pack tableBackground (ThemePicker.ApplyPreview) — not copied',
  'Canvas/FusionMenu/Theme_Panel/Table': 'replaced at runtime by the selected pack board (ThemePicker.ApplyPreview) — not copied',
};
// Subtrees ThemePicker.Bind switches off for good.
const EXCLUDE = { 'Canvas/FusionMenu/Theme_Panel/SocialButtons': 'ThemePicker.HideTablesSocialChrome hides it (Discord / X / Settings live on the main menu)' };

function exportTree(g) {
  const t = g.transform.data;
  const q = [num(t.m_LocalRotation?.x), num(t.m_LocalRotation?.y), num(t.m_LocalRotation?.z), num(t.m_LocalRotation?.w, 1)];
  const p = nodePath(g);
  const node = {
    name: g.go.data.m_Name, path: p, active: g.go.data.m_IsActive !== '0',
    rect: { anchorMin: v2(t.m_AnchorMin), anchorMax: v2(t.m_AnchorMax), anchoredPosition: v2(t.m_AnchoredPosition), sizeDelta: v2(t.m_SizeDelta), pivot: v2(t.m_Pivot), euler: quatToEuler(q), scale: v3(t.m_LocalScale) },
  };
  const comps = components(g, p);
  if (Object.keys(comps).length) node.components = comps;
  const kids = g.children.filter((c) => c.transform?.classId === 224).map((c) => (EXCLUDE[nodePath(c)] ? { name: c.go.data.m_Name, path: nodePath(c), active: false, excluded: EXCLUDE[nodePath(c)] } : exportTree(c)));
  if (kids.length) node.children = kids;
  return node;
}

const panelGo = [...gos.values()].find((g) => g.go.data.m_Name === 'Theme_Panel');
if (!panelGo) throw new Error('Theme_Panel not found in ' + MENU_SCENE);
let canvasGo = panelGo; while (canvasGo && !canvasGo.components.some((c) => c.classId === 223)) canvasGo = canvasGo.parent;
const scalerC = canvasGo?.components.find((c) => scriptName(c) === 'CanvasScaler');
const sd = scalerC?.data || {};
const picker = {
  source: MENU_SCENE,
  path: nodePath(panelGo),
  canvas: canvasGo ? {
    path: nodePath(canvasGo),
    renderMode: ['ScreenSpaceOverlay', 'ScreenSpaceCamera', 'WorldSpace'][num(canvasGo.components.find((c) => c.classId === 223).data.m_RenderMode)],
    scaler: { uiScaleMode: ['ConstantPixelSize', 'ScaleWithScreenSize', 'ConstantPhysicalSize'][num(sd.m_UiScaleMode)], referenceResolution: v2(sd.m_ReferenceResolution), matchWidthOrHeight: num(sd.m_MatchWidthOrHeight), screenMatchMode: ['MatchWidthOrHeight', 'Expand', 'Shrink'][num(sd.m_ScreenMatchMode)] },
  } : null,
  // Intermediate parents between the canvas and Theme_Panel (all stretch-to-fill in the scene).
  parents: (() => { const a = []; let g = panelGo.parent; while (g && g !== canvasGo) { const t = g.transform.data; a.unshift({ name: g.go.data.m_Name, anchorMin: v2(t.m_AnchorMin), anchorMax: v2(t.m_AnchorMax), sizeDelta: v2(t.m_SizeDelta), anchoredPosition: v2(t.m_AnchoredPosition), scale: v3(t.m_LocalScale) }); g = g.parent; } return a; })(),
  root: exportTree(panelGo),
  // NomadRetentionRuntime.DockCloseUnderTopBar: the Back button re-skins to this sprite (Simple, preserveAspect).
  dockCloseSprite: (() => {
    const base = path.join(ROOT, 'Assets/Resources/Retention/Art/WeeklyRewards/close_btn');
    const f = ['.png', '.jpg'].map((e) => base + e).find((x) => fs.existsSync(x));
    if (!f) return null;
    const g = /guid:\s*([0-9a-f]{32})/.exec(fs.readFileSync(f + '.meta', 'utf8'))?.[1];
    return g ? spriteRef({ guid: g, fileID: '21300000' }, 'ThemePicker Back (DockCloseUnderTopBar)') : null;
  })(),
};

// ------------------------------------------------------------------------------------------ write

const out = {
  $comment: 'Generated by web/tools/extract-unity-themes.mjs — do not edit. Sprite keys are guid:fileID (same scheme as unity-hud.json).',
  enum: THEME_ENUM,
  defaultTheme,
  prefKey,
  packs,
  sprites,
  fonts,
  picker,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1));
console.log('wrote', rel(OUT_JSON), (fs.statSync(OUT_JSON).size / 1024).toFixed(0) + ' KB');

// ------------------------------------------------------------------------------------------ copy + manifest

const rows = [];
let bytes = 0;
function copy(src, webRel, scale) {
  let buf = fs.readFileSync(src), resized = null;
  if (scale < 1 && /\.png$/i.test(src)) {
    const img = decodePng(buf);
    if (img) { const nw = Math.max(1, Math.round(img.width * scale)), nh = Math.max(1, Math.round(img.height * scale)); buf = encodePng(resizeRgba(img, nw, nh)); resized = [nw, nh]; }
    else console.warn('could not decode (copied full size):', rel(src));
  }
  if (COPY) { const dst = path.join(WEB, 'public', webRel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  bytes += buf.length;
  return { size: buf.length, resized };
}
for (const [src, c] of copies) { const r = copy(src, c.file, c.scale); rows.push({ file: c.file, src: rel(src), uses: [...c.uses], ...r }); }
for (const [src, file] of fontCopies) { const r = copy(src, file, 1); rows.push({ file, src: rel(src), uses: ['Theme_Panel TMP font'], ...r }); }
const reused = Object.values(sprites).filter((s) => s.reused).map((s) => `| \`${s.file}\` | \`${s.unity}\` | reused from ${s.reused} |`);
const md = [
  '# Theme art for the web port', '',
  'Generated by `node web/tools/extract-unity-themes.mjs` (data: `web/src/data/theming-themes.json`). PNGs are re-encoded at',
  `2x Unity's import size (platform maxTextureSize), capped at ${EXPORT_CAP} px. Total: ${rows.length} files, ${(bytes / 1e6).toFixed(2)} MB.`, '',
  '| File (under public/) | Unity source | Size | Used by |', '|---|---|---|---|',
  ...rows.sort((a, b) => a.file.localeCompare(b.file)).map((r) => `| \`${r.file}\` | \`${r.src}\` | ${(r.size / 1024).toFixed(0)} KB${r.resized ? ` (${r.resized.join('×')})` : ''} | ${r.uses.slice(0, 4).join('; ')}${r.uses.length > 4 ? ` (+${r.uses.length - 4})` : ''} |`),
  '', '## Referenced, not copied (already exported by another extractor)', '', '| File | Unity source | |', '|---|---|---|', ...reused, '',
];
if (COPY) { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.md'), md.join('\n')); }
console.log(`copied ${rows.length} files, ${(bytes / 1e6).toFixed(2)} MB`);

// WebP + right-size what was just copied (or, without copying, point the JSON at the existing WebP files).
await optimizeAssets({ dirs: ['theming'], convert: COPY });
