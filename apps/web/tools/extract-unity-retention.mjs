#!/usr/bin/env node
// Extracts the retention UI (level-up celebration, weekly rewards, daily spin, missions, stake select, the Lucky Slot
// screens and the table chips the menu art provides) from the Unity project, so the web port can match it 1:1.
//
//   node web/tools/extract-unity-retention.mjs [--no-copy]
//
// Reads (never writes) Assets/. Writes:
//   web/src/data/retention-ui.json          RectTransform trees + the serialized fields of the retention scripts
//   web/public/assets/retention/**          sprites (resized like the HUD extractor) and TMP source fonts
//   web/public/assets/retention/MANIFEST.md file -> Unity source -> where used
//
// Sources (what the shipped game shows, see NomadUiHost / RetentionMenuHud / LevelUpPanel):
//   - Assets/Resources/Retention/LevelUp panel ui.prefab            LevelUpPanel (auto on level-up)
//   - Assets/Prefabs/UI/WeeklyRewards/Screens/WeeklyRewards_Screen  LoginRewardsPanel + WeeklyRewardCard (Nomad menu)
//   - RetentionHud instance in Assets/Photon/FusionMenu/FusionSampleMenu_Game.unity: Spin_Panel_UI, Missions panel ui,
//     StakeSelect_Panel (opened from the table chips when the Nomad menu is not running)
//   - Assets/Prefabs/UI/NomadScreens/Rewards/LuckySlot_Win / LuckySlot_Lost (NomadSlotSpin + NomadSparkles)
//   - Assets/Prefabs/UI/NomadScreens/MainMenu/MainMenu.prefab: the Coins / Level / Missions / Friends widgets that
//     TableMenuChips clones onto the RetentionHud canvas
//   - Assets/Resources/Retention/Art/**: sprites NomadRetentionRuntime.Apply loads by Resources path
//
// Dependency-free (Node 22). Unity YAML parsing + prefab resolution live in ./lib/unity-yaml.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnityProject, buildHierarchy, normId, parseUnityFile, readMeta, imageSize } from './lib/unity-yaml.mjs';
import { decodePng, resizeRgba, encodePng } from './lib/png.mjs';
import { optimizeAssets } from './optimize-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '..');
const OUT_JSON = path.join(WEB, 'src/data/retention-ui.json');
const OUT_DIR = 'assets/retention';
const COPY = !process.argv.includes('--no-copy');
const EXPORT_MULT = 2;
const EXPORT_CAP = 1024;
const EXPORT_CAP_BY_NAME = { BG_Town: 1920, Img_Background: 1920, Backdrop: 1920 };

const KNOWN_SCRIPTS = {
  fe87c0e1cc204ed48ad3b37840f39efc: 'Image', '4e29b1a8efbd4b44bb3f3716e73f07ff': 'Button',
  '0cd44c1031e13a943bb63640046fad76': 'CanvasScaler', dc42784cf147c0c48a680349fa168899: 'GraphicRaycaster',
  f4688fdb7df04437aeb418b961361dc5: 'TextMeshProUGUI', '5f7201a12d95ffc409449d95f23cf332': 'Text',
  '31a19414c41e5ae4aae2af33fee712f6': 'Mask', '3312d7739989d2b4e91e6319e9a96d76': 'RectMask2D',
  '30649d3a9faa99c48a7b1166b86bf2a0': 'HorizontalLayoutGroup', '59f8146938fff824cb5fd77236b75775': 'VerticalLayoutGroup',
  '8a8695521f0d02e499659fee002a26c2': 'GridLayoutGroup', '3245ec927659c4140ac4f8d17403cc18': 'ContentSizeFitter',
  '306cc8c2b49d7114eaa3623786fc2126': 'LayoutElement', '1aa08ab6e0800fa44ae55d278d1423e3': 'ScrollRect',
  '86710e43de46f6f4bac7c8e50813a599': 'AspectRatioFitter', '2a4db7a114972834c8e4117be1d82ba3': 'Toggle',
  '2da0c512f12947e489f739169773d7ca': 'TMP_InputField', '1344c3c82d62a2a41a3576d8abb8e3ea': 'RawImage',
};
const BUILTIN_SPRITES = { 10905: 'UISprite', 10907: 'Background', 10909: 'InputFieldBackground', 10911: 'Knob', 10913: 'Checkmark' };
/** Project scripts whose serialized fields the web port reads (sprites, tuning, wiring). */
const SCRIPTS_WITH_FIELDS = new Set(['LevelUpPanel', 'LoginRewardsPanel', 'WeeklyRewardCard', 'DailySpinPanel', 'MissionsPanel', 'MissionRowView',
  'StakeSelectPanel', 'NomadSlotSpin', 'NomadSparkles', 'TitleOrnament', 'RetentionMenuHud', 'SafeAreaFitter', 'PokerButtonSfx']);

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
function quatToEulerZ(q) {
  const x = num(q?.x), y = num(q?.y), z = num(q?.z), w = num(q?.w, 1);
  return r4(Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI);
}

// ------------------------------------------------------------------------------------------ sprites

const sprites = {};
const spriteUse = new Map();
const textureCopies = new Map();
function webAssetPath(abs, base) {
  const r = rel(abs).replace(/^Assets\//, '');
  return base + '/' + r.split('/').map((s) => s.replace(/[^A-Za-z0-9._()-]+/g, '_')).join('/');
}
// Textures the table HUD extractor already ships (assets/ui): reuse its file instead of a second copy.
const HUD_JSON = path.join(WEB, 'src/data/unity-hud.json');
const hudData = fs.existsSync(HUD_JSON) ? JSON.parse(fs.readFileSync(HUD_JSON, 'utf8')) : { sprites: {}, fonts: {} };
const hudFileByUnity = new Map(Object.values(hudData.sprites || {}).filter((s) => s.file && s.unity).map((s) => [s.unity, s]));
/**
 * drawLongest: the longest side (canvas units) this sprite is drawn at on a fixed-size rect, or null when the rect
 * stretches with its parent. Textures only ever drawn small are exported at 2x that size (hi-DPI) instead of 2x the
 * import size, which keeps the payload lean without visible loss.
 */
function spriteRef(ref, usedAt, capHint, drawLongest = null) {
  if (isNullRef(ref)) return null;
  const guid = ref.guid, fid = normId(ref.fileID);
  if (!guid) return null;
  const key = guid + ':' + fid;
  if (!sprites[key]) sprites[key] = describeSprite(guid, fid, capHint);
  if (usedAt) { if (!spriteUse.has(key)) spriteUse.set(key, new Set()); spriteUse.get(key).add(usedAt); }
  const s = sprites[key];
  const abs = s.unity && path.join(ROOT, s.unity);
  const t = abs && textureCopies.get(abs);
  if (t) {
    const texLongest = Math.max(...(s.texture || [1, 1]));
    const spLongest = Math.max(s.rect[2], s.rect[3]) || 1;
    if (drawLongest === null || !(drawLongest > 0) || s.border.some((b) => b > 0)) t.uncapped = true;
    else t.drawMax = Math.max(t.drawMax || 0, drawLongest * (texLongest / spLongest));
  }
  return key;
}
function describeSprite(guid, fid, capHint) {
  if (guid === '0000000000000000f000000000000000') {
    const n = BUILTIN_SPRITES[+fid] || 'builtin' + fid;
    return { name: n, builtin: true, file: null, border: n === 'UISprite' || n === 'Background' || n === 'InputFieldBackground' ? [10, 10, 10, 10] : [0, 0, 0, 0], ppu: 100, rect: [0, 0, 32, 32] };
  }
  const abs = P.pathOf(guid);
  if (!abs) return { name: null, missing: true, guid, ppu: 100, rect: [0, 0, 1, 1], border: [0, 0, 0, 0] };
  const meta = readMeta(abs) || {};
  const ti = meta.TextureImporter || {};
  const size = imageSize(abs);
  const ppu = num(ti.spritePixelsToUnits, 100);
  const info = { name: path.basename(abs, path.extname(abs)), unity: rel(abs), file: null, ppu };
  const plats = ti.platformSettings || [];
  const web = plats.find((p) => p.buildTarget === 'WebGL' && p.overridden === '1');
  const def = plats.find((p) => p.buildTarget === 'DefaultTexturePlatform');
  const effMax = num((web || def || {}).maxTextureSize, num(ti.maxTextureSize, 2048));
  const ext = path.extname(abs).toLowerCase();
  if (size) {
    const longest = Math.max(size.w, size.h);
    const cap = capHint || EXPORT_CAP;
    info.exportScale = ext === '.png' ? Math.min(1, Math.min(EXPORT_MULT * effMax, cap) / longest) : 1;
    info.exportSize = [Math.round(size.w * info.exportScale), Math.round(size.h * info.exportScale)];
  }
  if (size) info.texture = [size.w, size.h];
  const hudCopy = hudFileByUnity.get(rel(abs));
  if (hudCopy) {
    info.file = hudCopy.file;
    info.exportScale = hudCopy.exportScale ?? 1;
    info.sharedWithHud = true;
  } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
    info.file = webAssetPath(abs, OUT_DIR);
    const prev = textureCopies.get(abs);
    if (!prev || prev.scale < info.exportScale) textureCopies.set(abs, { file: info.file, scale: info.exportScale ?? 1 });
  } else info.note = `source is ${ext}: not browser-native`;
  const sheet = ti.spriteSheet?.sprites || [];
  let entry = null;
  if (fid !== '21300000' || num(ti.spriteMode, 1) === 2) {
    entry = sheet.find((s) => normId(s.internalID) === fid);
    if (!entry) for (const t of ti.internalIDToNameTable || []) { const k = t.first && Object.values(t.first)[0]; if (normId(k) === fid) { entry = sheet.find((s) => s.name === t.second); break; } }
  }
  const toBorder = (b) => [num(b?.x), num(b?.y), num(b?.z), num(b?.w)];
  if (entry) {
    const rr = entry.rect || {};
    info.name = entry.name;
    info.rect = [num(rr.x), num(rr.y), num(rr.width), num(rr.height)];
    info.border = toBorder(entry.border);
  } else {
    info.rect = size ? [0, 0, size.w, size.h] : [0, 0, 1, 1];
    info.border = toBorder(ti.spriteBorder);
  }
  if (info.exportScale !== undefined && info.exportScale < 1) info.borderExported = info.border.map((v) => r4(v * info.exportScale));
  return info;
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
  if (!fa) return guid;
  const d = fa.data;
  info.name = d.m_Name;
  const fi = d.m_FaceInfo || {};
  info.faceInfo = { familyName: fi.m_FamilyName, styleName: fi.m_StyleName, pointSize: num(fi.m_PointSize), lineHeight: num(fi.m_LineHeight), ascentLine: num(fi.m_AscentLine), descentLine: num(fi.m_DescentLine) };
  const srcGuid = d.m_SourceFontFile?.guid || d.m_SourceFontFileGUID || d.m_CreationSettings?.sourceFontFileGUID || d.fontAssetCreationSettings?.sourceFontFileGUID;
  const src = srcGuid && P.pathOf(srcGuid);
  info.family = 'Retention_' + String(info.name).replace(/[^A-Za-z0-9]+/g, '_');
  // The table HUD already ships these two (styles.css @font-face): reuse its families.
  const HUD_FAMILIES = { 'NotoSans-Bold SDF': 'UnityNotoSansBold', 'NotoSans-Bold SDF_Stroke': 'UnityNotoSansBold', 'LiberationSans SDF': 'UnityLiberationSans' };
  if (HUD_FAMILIES[info.name]) { info.family = HUD_FAMILIES[info.name]; info.sharedWithHud = true; return guid; }
  if (src) { info.sourceFont = rel(src); info.file = webAssetPath(src, OUT_DIR + '/fonts'); fontCopies.set(src, info.file); }
  return guid;
}
function materialRef(ref) {
  if (isNullRef(ref) || !ref.guid) return null;
  const key = ref.guid + ':' + normId(ref.fileID);
  if (materials[key]) return key;
  const abs = P.pathOf(ref.guid);
  const info = {};
  materials[key] = info;
  if (!abs) return key;
  const docs = /\.mat$/.test(abs) ? parseUnityFile(abs) : parseUnityFile(abs, { skipClasses: [28, 114] });
  const m = docs.find((x) => x.classId === 21 && (x.fileId === normId(ref.fileID) || /\.mat$/.test(abs)));
  if (!m) return key;
  const d = m.data;
  info.name = d.m_Name;
  const kw = (Array.isArray(d.m_ValidKeywords) ? d.m_ValidKeywords : String(d.m_ShaderKeywords || '').split(/\s+/)).filter(Boolean);
  const floats = {}; for (const f of d.m_SavedProperties?.m_Floats || []) Object.assign(floats, f);
  const cols = {}; for (const c of d.m_SavedProperties?.m_Colors || []) Object.assign(cols, c);
  const pickF = (k) => (k in floats ? r4(num(floats[k])) : undefined);
  info.underlay = { enabled: kw.includes('UNDERLAY_ON') || kw.includes('UNDERLAY_INNER'), color: color(cols._UnderlayColor), offsetX: pickF('_UnderlayOffsetX'), offsetY: pickF('_UnderlayOffsetY'), dilate: pickF('_UnderlayDilate'), softness: pickF('_UnderlaySoftness') };
  info.outline = { enabled: kw.includes('OUTLINE_ON') || (pickF('_OutlineWidth') || 0) > 0, width: pickF('_OutlineWidth'), color: color(cols._OutlineColor) };
  info.glow = { enabled: kw.includes('GLOW_ON'), color: color(cols._GlowColor), outer: pickF('_GlowOuter') };
  return key;
}

// ------------------------------------------------------------------------------------------ components

const H_ALIGN = { 1: 'left', 2: 'center', 4: 'right', 8: 'justified', 16: 'flush', 32: 'geometry' };
const V_ALIGN = { 256: 'top', 512: 'middle', 1024: 'bottom', 2048: 'baseline', 4096: 'geometry', 8192: 'capline' };
const IMAGE_TYPE = ['Simple', 'Sliced', 'Tiled', 'Filled'];
const FILL_METHOD = ['Horizontal', 'Vertical', 'Radial90', 'Radial180', 'Radial360'];
const TEXT_ANCHOR = ['UpperLeft', 'UpperCenter', 'UpperRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'LowerLeft', 'LowerCenter', 'LowerRight'];
const ARF_MODE = ['None', 'WidthControlsHeight', 'HeightControlsWidth', 'FitInParent', 'EnvelopeParent'];

function makeCtx(file, objs, gos) {
  const compOwner = new Map();
  for (const [, g] of gos) for (const c of g.components) compOwner.set(c.id, g);
  return { file, objs, gos, compOwner, root: null };
}
function scriptName(c) {
  if (c.classId !== 114) return c.type || 'class' + c.classId;
  const g = c.data.m_Script?.guid;
  if (KNOWN_SCRIPTS[g]) return KNOWN_SCRIPTS[g];
  const p = g && P.pathOf(g);
  return p ? path.basename(p).replace(/\.cs$/, '') : 'MonoBehaviour(' + g + ')';
}
function relPath(ctx, g) { const a = []; while (g && g !== ctx.root) { a.unshift(g.go.data.m_Name); g = g.parent; } return a.join('/'); }
function refTarget(ctx, ref, at) {
  if (isNullRef(ref)) return null;
  if (ref.guid) {
    const p = P.pathOf(ref.guid);
    if (p && /\.(png|jpe?g|psd|psb|tga)$/i.test(p)) return { sprite: spriteRef(ref, at) };
    return { asset: p ? rel(p) : ref.guid };
  }
  const id = normId(ref.fileID);
  if (ctx.gos.has(id)) return { path: relPath(ctx, ctx.gos.get(id)) };
  const owner = ctx.compOwner.get(id);
  if (owner) { const c = owner.components.find((x) => x.id === id); return { path: relPath(ctx, owner), component: scriptName(c) }; }
  return { missing: id };
}
function fieldsOf(ctx, c, at) {
  const out = {};
  const SKIP = new Set(['m_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_Name', 'm_EditorClassIdentifier']);
  const conv = (v) => {
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object') {
      if ('fileID' in v) return refTarget(ctx, v, at);
      if ('r' in v && 'g' in v && 'b' in v && 'a' in v) return color(v);
      const o = {}; for (const k of Object.keys(v)) o[k] = conv(v[k]); return o;
    }
    if (typeof v === 'string' && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v)) return Number(v);
    return v;
  };
  for (const [k, v] of Object.entries(c.data)) if (!SKIP.has(k)) out[k] = conv(v);
  return out;
}
function imageComp(c, at, capHint, drawLongest) {
  const d = c.data;
  return {
    enabled: d.m_Enabled !== '0', sprite: spriteRef(d.m_Sprite, at, capHint, drawLongest), color: color(d.m_Color),
    type: IMAGE_TYPE[num(d.m_Type)] || d.m_Type, preserveAspect: d.m_PreserveAspect === '1', fillCenter: d.m_FillCenter !== '0',
    fillMethod: FILL_METHOD[num(d.m_FillMethod)], fillAmount: r4(num(d.m_FillAmount, 1)), fillClockwise: d.m_FillClockwise !== '0', fillOrigin: num(d.m_FillOrigin),
    pixelsPerUnitMultiplier: r4(num(d.m_PixelsPerUnitMultiplier, 1)), raycastTarget: d.m_RaycastTarget !== '0',
  };
}
function tmpComp(c) {
  const d = c.data;
  let h = num(d.m_HorizontalAlignment, 0), v = num(d.m_VerticalAlignment, 0);
  if (!h && d.m_textAlignment && d.m_textAlignment !== '65535') { const a = num(d.m_textAlignment); h = a & 0xff; v = a & 0xff00; }
  const style = num(d.m_fontStyle);
  const styles = []; ['bold', 'italic', 'underline', 'lowercase', 'uppercase', 'smallcaps', 'strikethrough'].forEach((n, i) => { if (style & (1 << i)) styles.push(n); });
  const out = {
    enabled: d.m_Enabled !== '0', text: d.m_text ?? '', font: fontAsset(d.m_fontAsset), material: materialRef(d.m_sharedMaterial),
    fontSize: r4(num(d.m_fontSize)), autoSize: d.m_enableAutoSizing === '1', fontSizeMin: r4(num(d.m_fontSizeMin)), fontSizeMax: r4(num(d.m_fontSizeMax)),
    fontStyle: styles, color: color(d.m_fontColor) || color32(d.m_fontColor32?.rgba),
    vertexGradient: d.m_enableVertexGradient === '1' ? { topLeft: color(d.m_fontColorGradient?.topLeft), bottomLeft: color(d.m_fontColorGradient?.bottomLeft) } : null,
    alignH: H_ALIGN[h] || h, alignV: V_ALIGN[v] || v,
    wrapping: d.m_TextWrappingMode !== undefined ? num(d.m_TextWrappingMode) !== 0 : d.m_enableWordWrapping === '1',
    characterSpacing: r4(num(d.m_characterSpacing)), margin: v4(d.m_margin), richText: d.m_isRichText !== '0',
  };
  return out;
}
function selectable(ctx, d, at) {
  const cs = d.m_Colors || {};
  return {
    interactable: d.m_Interactable !== '0', transition: ['None', 'ColorTint', 'SpriteSwap', 'Animation'][num(d.m_Transition)],
    colors: { normal: color(cs.m_NormalColor), highlighted: color(cs.m_HighlightedColor), pressed: color(cs.m_PressedColor), disabled: color(cs.m_DisabledColor), colorMultiplier: num(cs.m_ColorMultiplier, 1), fadeDuration: num(cs.m_FadeDuration, 0.1) },
    targetGraphic: refTarget(ctx, d.m_TargetGraphic, at)?.path ?? null,
  };
}
function describeComponents(ctx, g, at) {
  const out = {};
  const scripts = [];
  const capHint = EXPORT_CAP_BY_NAME[g.go.data.m_Name];
  const t = g.transform?.data;
  let drawLongest = null;
  if (t && g.transform.classId === 224) {
    const amin = v2(t.m_AnchorMin), amax = v2(t.m_AnchorMax), sd = v2(t.m_SizeDelta), sc = v3(t.m_LocalScale);
    let k = Math.max(Math.abs(sc[0]), Math.abs(sc[1])) || 1;
    for (let p = g.parent; p && p.transform && p !== ctx.root; p = p.parent) { const ps = v3(p.transform.data.m_LocalScale); k *= Math.max(Math.abs(ps[0]), Math.abs(ps[1])) || 1; }
    if (amin[0] === amax[0] && amin[1] === amax[1]) drawLongest = Math.max(sd[0], sd[1]) * Math.max(1, k);
  }
  for (const c of g.components) {
    if (c.classId === 4 || c.classId === 224 || c.classId === 222) continue;
    const n = scriptName(c);
    const d = c.data;
    switch (n) {
      case 'Image': out.image = imageComp(c, at, capHint, drawLongest); break;
      case 'TextMeshProUGUI': out.text = tmpComp(c); break;
      case 'Button': out.button = selectable(ctx, d, at); break;
      case 'CanvasGroup': out.canvasGroup = { alpha: r4(num(d.m_Alpha, 1)) }; break;
      case 'Mask': out.mask = { enabled: d.m_Enabled !== '0', showMaskGraphic: d.m_ShowMaskGraphic !== '0' }; break;
      case 'RectMask2D': out.rectMask2D = { enabled: d.m_Enabled !== '0' }; break;
      case 'HorizontalLayoutGroup': case 'VerticalLayoutGroup': case 'GridLayoutGroup':
        out.layoutGroup = { kind: n, enabled: d.m_Enabled !== '0', padding: d.m_Padding ? [num(d.m_Padding.m_Left), num(d.m_Padding.m_Right), num(d.m_Padding.m_Top), num(d.m_Padding.m_Bottom)] : [0, 0, 0, 0], spacing: d.m_Spacing && typeof d.m_Spacing === 'object' ? v2(d.m_Spacing) : num(d.m_Spacing), childAlignment: TEXT_ANCHOR[num(d.m_ChildAlignment)], controlW: d.m_ChildControlWidth === '1', controlH: d.m_ChildControlHeight === '1', expandW: d.m_ChildForceExpandWidth === '1', expandH: d.m_ChildForceExpandHeight === '1', cellSize: d.m_CellSize ? v2(d.m_CellSize) : undefined, constraintCount: d.m_ConstraintCount ? num(d.m_ConstraintCount) : undefined };
        break;
      case 'ContentSizeFitter': out.contentSizeFitter = { horizontal: num(d.m_HorizontalFit), vertical: num(d.m_VerticalFit) }; break;
      case 'LayoutElement': out.layoutElement = { ignoreLayout: d.m_IgnoreLayout === '1', minWidth: num(d.m_MinWidth, -1), minHeight: num(d.m_MinHeight, -1), preferredWidth: num(d.m_PreferredWidth, -1), preferredHeight: num(d.m_PreferredHeight, -1), flexibleWidth: num(d.m_FlexibleWidth, -1), flexibleHeight: num(d.m_FlexibleHeight, -1) }; break;
      case 'AspectRatioFitter': out.aspectRatioFitter = { mode: ARF_MODE[num(d.m_AspectMode)], ratio: r4(num(d.m_AspectRatio, 1)) }; break;
      case 'ScrollRect': out.scrollRect = { vertical: d.m_Vertical !== '0', horizontal: d.m_Horizontal === '1' }; break;
      case 'CanvasScaler': out.canvasScaler = { mode: num(d.m_UiScaleMode), referenceResolution: v2(d.m_ReferenceResolution), match: r4(num(d.m_MatchWidthOrHeight)) }; break;
      case 'Canvas': case 'GraphicRaycaster': case 'ThemeExempt': break;
      default:
        if (SCRIPTS_WITH_FIELDS.has(n)) scripts.push({ script: n, enabled: d.m_Enabled !== '0', fields: fieldsOf(ctx, c, at) });
        else if (c.classId === 114) scripts.push({ script: n });
    }
  }
  if (scripts.length) out.scripts = scripts;
  return out;
}

function exportTree(ctx, g) {
  const t = g.transform?.data;
  const node = { name: g.go.data.m_Name, path: relPath(ctx, g), active: g.go.data.m_IsActive !== '0' };
  if (t && g.transform.classId === 224) {
    node.rect = {
      anchorMin: v2(t.m_AnchorMin), anchorMax: v2(t.m_AnchorMax), anchoredPosition: v2(t.m_AnchoredPosition), sizeDelta: v2(t.m_SizeDelta), pivot: v2(t.m_Pivot),
      euler: [0, 0, quatToEulerZ(t.m_LocalRotation)], scale: v3(t.m_LocalScale),
    };
  }
  const comps = describeComponents(ctx, g, ctx.label + ':' + node.path);
  if (Object.keys(comps).length) node.components = comps;
  if (g.children.length) node.children = g.children.map((c) => exportTree(ctx, c));
  return node;
}

function loadFile(relFile) {
  const file = path.join(ROOT, relFile);
  const objs = P.resolve(file);
  const { gos } = buildHierarchy(objs);
  return makeCtx(relFile, objs, gos);
}
function findGo(ctx, pred) { for (const [, g] of ctx.gos) if (pred(g)) return g; return null; }
const rootOf = (ctx) => findGo(ctx, (g) => !g.parent);
function byPath(ctx, from, p) {
  let g = from;
  for (const part of p.split('/')) { g = g.children.find((c) => c.go.data.m_Name === part); if (!g) return null; }
  return g;
}
function exportRoot(ctx, g, label, extra = {}) {
  ctx.root = g.parent; ctx.label = label;
  const node = exportTree(ctx, g);
  return { name: label, source: ctx.file, ...extra, root: node };
}
const DEFAULT_SCALER = { mode: 1, referenceResolution: [1920, 1080], match: 0.5 };

// ------------------------------------------------------------------------------------------ export

console.log('Indexing GUIDs + resolving retention prefabs…');
const canvases = {};

{ // LevelUpPanel.EnsureCanvasScaler forces 1920x1080 match 0.5.
  const ctx = loadFile('Assets/Resources/Retention/LevelUp panel ui.prefab');
  canvases.levelUp = exportRoot(ctx, rootOf(ctx), 'levelUp', { scaler: DEFAULT_SCALER, sortingOrder: 900 });
}
{ // NomadUiHost.MountOverlay: 1920x1080 match 0.5, order 560.
  const ctx = loadFile('Assets/Prefabs/UI/WeeklyRewards/Screens/WeeklyRewards_Screen.prefab');
  canvases.weekly = exportRoot(ctx, rootOf(ctx), 'weekly', { scaler: DEFAULT_SCALER, sortingOrder: 560 });
}
{ // The RetentionHud instance the menu scene carries (RetentionMenuHud.Bootstrap keeps the scene one).
  const ctx = loadFile('Assets/Photon/FusionMenu/FusionSampleMenu_Game.unity');
  const hud = findGo(ctx, (g) => g.go.data.m_Name === 'RetentionHud' && g.components.some((c) => scriptName(c) === 'RetentionMenuHud'));
  if (!hud) throw new Error('RetentionHud not found in FusionSampleMenu_Game.unity');
  const scalerC = hud.components.find((c) => scriptName(c) === 'CanvasScaler');
  const scaler = scalerC ? { mode: num(scalerC.data.m_UiScaleMode), referenceResolution: v2(scalerC.data.m_ReferenceResolution), match: r4(num(scalerC.data.m_MatchWidthOrHeight)) } : DEFAULT_SCALER;
  const hudScript = hud.components.find((c) => scriptName(c) === 'RetentionMenuHud');
  ctx.root = hud.parent; ctx.label = 'hud';
  for (const [key, child] of [['spin', 'Spin_Panel_UI'], ['missions', 'Missions panel ui'], ['stakes', 'StakeSelect_Panel']]) {
    const g = hud.children.find((c) => c.go.data.m_Name === child);
    if (!g) { console.warn('missing RetentionHud child', child); continue; }
    canvases[key] = exportRoot(ctx, g, key, { scaler, sortingOrder: 500, hudChild: child });
  }
  ctx.root = hud.parent;
  canvases.spin.hudFields = fieldsOf(ctx, hudScript, 'hud');
}
for (const [key, file] of [['luckyWin', 'Assets/Prefabs/UI/NomadScreens/Rewards/LuckySlot_Win.prefab'], ['luckyLost', 'Assets/Prefabs/UI/NomadScreens/Rewards/LuckySlot_Lost.prefab']]) {
  const ctx = loadFile(file);
  const r = rootOf(ctx);
  const sc = r.components.find((c) => scriptName(c) === 'CanvasScaler');
  const scaler = sc ? { mode: num(sc.data.m_UiScaleMode), referenceResolution: v2(sc.data.m_ReferenceResolution), match: r4(num(sc.data.m_MatchWidthOrHeight)) } : DEFAULT_SCALER;
  canvases[key] = exportRoot(ctx, r, key, { scaler });
}
{ // TableMenuChips: Coins, Level, Missions, Friends cloned from the menu art onto the RetentionHud canvas.
  const ctx = loadFile('Assets/Prefabs/UI/NomadScreens/MainMenu/MainMenu.prefab');
  const r = rootOf(ctx);
  const sc = r.components.find((c) => scriptName(c) === 'CanvasScaler');
  const scaler = sc ? { mode: num(sc.data.m_UiScaleMode), referenceResolution: v2(sc.data.m_ReferenceResolution), match: r4(num(sc.data.m_MatchWidthOrHeight)) } : DEFAULT_SCALER;
  const chips = {};
  for (const [key, p] of [['coins', 'TopBar/Stat_Coins'], ['level', 'TopBar/Stat_Level'], ['missions', 'SideTabs_Expanded/Panel_Rewards/Row_Missions'], ['friends', 'SideTabs_Expanded/Panel_Community/Row_Friends']]) {
    const g = byPath(ctx, r, p);
    if (!g) { console.warn('missing MainMenu widget', p); continue; }
    ctx.root = g.parent; ctx.label = 'chips.' + key;
    chips[key] = exportTree(ctx, g);
  }
  canvases.chips = { name: 'chips', source: ctx.file, scaler, chips };
}

// NomadRetentionRuntime.Apply(image, "Retention/Art/...") loads these by Resources path at runtime.
const resourceSprites = {};
for (const sub of ['Missions', 'Tables', 'WeeklyRewards', 'TopBar']) {
  const dir = path.join(ROOT, 'Assets/Resources/Retention/Art', sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.png$/i.test(f)) continue;
    const used = sub === 'Missions' || sub === 'Tables' || f === 'close_btn.png';
    if (!used) continue;
    const meta = readMeta(path.join(dir, f));
    const guid = meta?.guid;
    if (!guid) continue;
    resourceSprites[`Retention/Art/${sub}/${f.replace(/\.png$/i, '')}`] = spriteRef({ guid, fileID: '21300000' }, 'NomadRetentionRuntime.Apply');
  }
}

// ------------------------------------------------------------------------------------------ copy assets + manifest

let bytes = 0, files = 0;
const copied = [];
function copy(src, webRel, scale = 1) {
  const dst = path.join(WEB, 'public', webRel);
  let buf = fs.readFileSync(src), resized = null;
  if (scale < 1 && /\.png$/i.test(src)) {
    const img = decodePng(buf);
    if (img) { const nw = Math.max(1, Math.round(img.width * scale)), nh = Math.max(1, Math.round(img.height * scale)); buf = encodePng(resizeRgba(img, nw, nh)); resized = [nw, nh]; }
  }
  if (COPY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  bytes += buf.length; files++;
  copied.push({ src: rel(src), web: webRel, size: buf.length, resized });
}
// Fixed-size-only textures: at most 2x their largest drawn size.
for (const [src, t] of textureCopies) {
  if (t.uncapped || !t.drawMax) continue;
  const size = imageSize(src);
  if (!size) continue;
  t.scale = Math.min(t.scale, Math.max(0.05, (2 * t.drawMax) / Math.max(size.w, size.h)));
}
// Every sprite of one texture shares its file: keep the largest export scale for it.
for (const s of Object.values(sprites)) if (s.file) { const t = [...textureCopies.values()].find((x) => x.file === s.file); if (t && s.exportScale !== t.scale) { s.exportScale = t.scale; if (t.scale < 1) s.borderExported = s.border.map((v) => r4(v * t.scale)); else delete s.borderExported; } }
console.log('Copying assets…');
for (const [src, t] of textureCopies) copy(src, t.file, t.scale);
for (const [src, w] of fontCopies) copy(src, w);

const out = { generatedBy: 'web/tools/extract-unity-retention.mjs', canvases, resourceSprites, sprites, fonts, materials };
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out));

let md = `# Retention UI assets (from Unity)\n\nGenerated by \`web/tools/extract-unity-retention.mjs\`; re-run it rather than editing by hand. ` +
  `${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB. Sprite rects / borders are in \`web/src/data/retention-ui.json\` → \`sprites\`.\n\n` +
  `| File (web/public/…) | Unity source | Size | Used by |\n|---|---|---|---|\n`;
const usesByFile = new Map();
for (const [k, s] of Object.entries(sprites)) if (s.file) { const set = usesByFile.get(s.file) || new Set(); for (const u of spriteUse.get(k) || []) set.add(u); usesByFile.set(s.file, set); }
for (const c of copied.sort((a, b) => a.web.localeCompare(b.web))) {
  const uses = [...(usesByFile.get(c.web) || [])];
  md += `| \`${c.web}\` | \`${c.src}\` | ${(c.size / 1024).toFixed(0)} KB${c.resized ? ' (' + c.resized.join('×') + ')' : ''} | ${(uses.slice(0, 4).join('; ') + (uses.length > 4 ? `; +${uses.length - 4} more` : '')).replace(/\|/g, '\\|') || (c.web.includes('/fonts/') ? 'TMP font source' : '—')} |\n`;
}
const missing = Object.entries(sprites).filter(([, s]) => !s.file && !s.builtin);
if (missing.length) { md += `\n## Not copied\n\n`; for (const [k, s] of missing) md += `- \`${k}\` ${s.name || ''}: ${s.note || (s.missing ? 'GUID not found' : '')}\n`; }
if (COPY) fs.writeFileSync(path.join(WEB, 'public', OUT_DIR, 'MANIFEST.md'), md);
console.log(`Wrote ${rel(OUT_JSON)} (${(fs.statSync(OUT_JSON).size / 1024).toFixed(0)} KB); assets: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB${COPY ? '' : ' (dry run)'}`);
if (missing.length) console.warn('Sprites not copied:', missing.map(([, s]) => s.name + ' ' + (s.note || '')).join(', '));

// WebP + right-size what was just copied (or, without copying, point the JSON at the existing WebP files).
await optimizeAssets({ dirs: ['retention'], convert: COPY });
