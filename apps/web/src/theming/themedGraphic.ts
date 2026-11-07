/**
 * Menu-side theming helpers — what ThemeManager does to the FusionMenu / Nomad UI, as functions over UNode
 * (src/hud/unityUi.ts) so the menu module can skin the trees it builds:
 *
 *   themedColor('label')                       pack colours (ThemeColorKey)
 *   themedSprite('MenuButton')                 pack art as unityUi SpriteData (null when the pack has none)
 *   bindThemedGraphic(node, 'MenuBackground')  ThemedGraphic: re-skins `node` now and on every theme change
 *   applyFrame / applyPotPlate / applyButtonLabels / applyMenuButton / applyMenuBackground   single passes
 *
 * Ports: ThemedGraphic.cs + ThemeManager.ApplySprite / ApplyFrame / ApplyPotPlate / ApplyButton / ApplyButtonLabels /
 * ApplyMenuBackground, ThemeBackgroundFitter.cs (cover fit) and ThemeBackgroundDrift.cs (drifting light orbs).
 */
import type { RGBA, SpriteData, UNode } from '../hud/unityUi';
import type { ThemeSlot, ThemePack } from './themeData';
import { spriteFor } from './themeData';
import { fitCover, WHITE } from './themeLogic';
import type { ThemeColorKey, ThemeService } from './themeService';

let service: ThemeService | null = null;

/** Called by the theming module's install(). */
export function setThemeServiceForGraphics(s: ThemeService): void {
  service = s;
}

function svc(): ThemeService {
  if (!service) throw new Error('[theming] theme service not installed yet');
  return service;
}

/** A colour of the current pack (see ThemeColorKey). */
export function themedColor(key: ThemeColorKey, pack?: ThemePack): RGBA {
  return svc().color(key, pack);
}

/** The current pack's sprite for a ThemedGraphic slot (SpriteData usable as UNode.image.sprite). */
export function themedSprite(slot: ThemeSlot, pack?: ThemePack): SpriteData | null {
  return spriteFor(pack ?? svc().pack, slot);
}

/** Subscribes to theme changes (pack shown now). */
export function onThemeChanged(fn: (pack: ThemePack) => void): () => void {
  return svc().onChanged((c) => fn(c.pack));
}

// ---------------------------------------------------------------- single passes (ThemeManager)

function ensureImage(n: UNode): NonNullable<UNode['image']> {
  n.image ??= { sprite: null, type: 'Simple', ppuM: 1, color: { ...WHITE }, preserveAspect: false, fillMethod: '', fillAmount: 1, fillOrigin: 0, fillClockwise: true };
  return n.image;
}

/** ThemeManager.ApplyFrame: pack menuButton 9-slice, white; a 1× slice multiplier becomes 20 (borders are ~850 px). */
export function applyFrame(n: UNode, pack: ThemePack = svc().pack): void {
  const sp = pack.art.menuButton;
  if (!sp) return;
  const img = ensureImage(n);
  const ppu = img.ppuM;
  img.sprite = sp;
  img.color = { ...WHITE };
  img.type = pack.menuButtonType;
  img.ppuM = img.type === 'Sliced' && ppu < 1.05 ? 20 : ppu;
  n.render();
}

/** ThemeManager.ApplyPotPlate: the pack's pot capsule, sliced (Circle art → ×15, a 1× multiplier → ×8). */
export function applyPotPlate(n: UNode, pack: ThemePack = svc().pack): void {
  const sp = pack.art.pot;
  if (!sp) return;
  const img = ensureImage(n);
  const fromCircle = img.sprite?.name?.toLowerCase() === 'circle';
  const ppu = img.ppuM;
  img.sprite = sp;
  img.color = { ...WHITE };
  img.type = 'Sliced';
  img.ppuM = fromCircle ? 15 : ppu < 1.05 ? 8 : ppu;
  n.render();
}

/** ThemeManager.ApplyButtonLabels: every TMP label under `root` (except the D/S/B chip) takes `color`. */
export function applyButtonLabels(root: UNode, color: RGBA = svc().labelColor): void {
  const walk = (n: UNode, underToken: boolean) => {
    const tok = underToken || n.name === 'D_Token';
    if (n.text && !tok) n.setTextColor({ ...color });
    for (const c of n.children) walk(c, tok);
  };
  walk(root, false);
}

/** ThemeManager.ApplyButton (MainButtons): frame on the Background image, labels on its button take the label colour. */
export function applyMenuButton(background: UNode, pack: ThemePack = svc().pack): void {
  applyFrame(background, pack);
  applyButtonLabels(background.name === 'Background' && background.parent ? background.parent : background, pack.buttonLabelColor);
}

/** ThemeManager.ApplySprite for a tagged graphic: sprite, white, `type`; a "Background" plate also paints its label. */
export function applySprite(n: UNode, sprite: SpriteData | null, type: string, labelColor: RGBA): void {
  if (!sprite) return;
  const img = ensureImage(n);
  img.sprite = sprite;
  img.color = { ...WHITE };
  img.type = type;
  if (n.name === 'Background') {
    const label = [...n.walk()].find((k) => k.text);
    if (label) label.setTextColor({ ...labelColor });
  }
  n.render();
}

// ---------------------------------------------------------------- menu background (fitter + drift)

/**
 * ThemeManager.ApplyMenuBackground: the pack preview as a Simple, unstretched background that covers its parent
 * (ThemeBackgroundFitter.FitCover), plus ThemeBackgroundDrift's light orbs when `drift` (FusionMenuBackgroundScreen).
 */
export function applyMenuBackground(n: UNode, sprite: SpriteData | null, drift = false): void {
  if (!sprite) return;
  const img = ensureImage(n);
  img.sprite = sprite;
  img.color = { ...WHITE };
  img.type = 'Simple';
  img.preserveAspect = false;
  fitBackground(n);
  if (drift) ensureDrift(n);
}

/** ThemeBackgroundFitter.Fit: centre anchors, size = cover of the parent rect. Call again when the parent resizes. */
export function fitBackground(n: UNode): void {
  const sp = n.image?.sprite;
  const p = n.parent;
  if (!sp || !p) return;
  const size = fitCover(sp.rect[2], sp.rect[3], p.w, p.h);
  if (!size) return;
  n.anchorMin = [0.5, 0.5];
  n.anchorMax = [0.5, 0.5];
  n.pivot = [0.5, 0.5];
  n.anchoredPosition = [0, 0];
  n.scale = [1, 1];
  n.sizeDelta = size;
  n.layout();
}

let glowUrl: string | null = null;
/** ThemeBackgroundDrift.EnsureGlow: 256² white disc, alpha = (smoothstep(1 − d))². */
function glow(): string {
  if (glowUrl) return glowUrl;
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const im = ctx.createImageData(size, size);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x - c) / c, (y - c) / c);
      let a = Math.max(0, Math.min(1, 1 - d));
      a = a * a * (3 - 2 * a);
      a *= a;
      const i = (y * size + x) * 4;
      im.data[i] = im.data[i + 1] = im.data[i + 2] = 255;
      im.data[i + 3] = Math.trunc(a * 255);
    }
  ctx.putImageData(im, 0, 0);
  return (glowUrl = cv.toDataURL());
}

const driftRoots = new WeakMap<UNode, HTMLElement>();

/** ThemeBackgroundDrift: 3 soft orbs over the background (slow Lissajous + pointer parallax + breathing). */
function ensureDrift(n: UNode): void {
  if (driftRoots.has(n)) return;
  const parentEl = n.parent?.el;
  if (!parentEl) return;
  const root = document.createElement('div');
  root.className = 'theme-parallax';
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible;';
  n.el.after(root); // sibling right after the image (C#: SetSiblingIndex(imageIndex + 1))
  driftRoots.set(n, root);
  const sizes = [0.95, 1.15, 0.75];
  const alphas = [0.1, 0.07, 0.08];
  const tints = ['rgb(255,245,230)', 'rgb(217,235,255)', 'rgb(255,255,255)'];
  const layers = sizes.map((_, i) => {
    const l = document.createElement('div');
    l.style.cssText = `position:absolute;left:50%;top:50%;opacity:${alphas[i]};background:${tints[i]};` +
      `-webkit-mask:url(${glow()}) center/100% 100% no-repeat;mask:url(${glow()}) center/100% 100% no-repeat;will-change:transform;`;
    root.append(l);
    return l;
  });
  let pointer = [0, 0];
  const onMove = (e: PointerEvent) => {
    pointer = [Math.max(-1, Math.min(1, (e.clientX / innerWidth) * 2 - 1)), Math.max(-1, Math.min(1, (1 - e.clientY / innerHeight) * 2 - 1))];
  };
  window.addEventListener('pointermove', onMove);
  const t0 = performance.now();
  const frame = () => {
    if (!root.isConnected) {
      window.removeEventListener('pointermove', onMove);
      driftRoots.delete(n);
      return;
    }
    const t = (performance.now() - t0) / 1000;
    const span = Math.max(root.clientWidth, root.clientHeight);
    layers.forEach((l, i) => {
      const s = span * sizes[i]!;
      l.style.width = l.style.height = `${s}px`;
      const ph = [i * 1.7, i * 2.3 + 0.4];
      const sp = [0.11 + i * 0.03, 0.09 + i * 0.025];
      const amp = [42 + i * 14, 28 + i * 10];
      const depth = 0.35 + i * 0.35;
      const x = Math.sin(t * sp[0]! + ph[0]!) * amp[0]! + pointer[0]! * 18 * depth;
      const y = Math.cos(t * sp[1]! + ph[1]!) * amp[1]! + pointer[1]! * 18 * depth;
      const k = 1 + 0.04 * Math.sin(t * (0.15 + i * 0.05) + ph[1]!);
      l.style.transform = `translate(-50%,-50%) translate(${x}px,${-y}px) scale(${k})`;
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- ThemedGraphic

/**
 * ThemedGraphic: marks `node` so its art follows the theme (ThemeManager.Apply's tagged pass). MenuBackground gets
 * the cover-fit background; MenuButton the pack frame with its 9-slice type; other slots a Simple sprite.
 * Returns an unbind function.
 */
export function bindThemedGraphic(node: UNode, slot: ThemeSlot, opts: { drift?: boolean } = {}): () => void {
  const apply = (pack: ThemePack) => {
    const sprite = spriteFor(pack, slot);
    if (slot === 'MenuBackground') applyMenuBackground(node, sprite, !!opts.drift);
    else applySprite(node, sprite, slot === 'MenuButton' ? pack.menuButtonType : 'Simple', pack.buttonLabelColor);
  };
  apply(svc().pack);
  return onThemeChanged(apply);
}
