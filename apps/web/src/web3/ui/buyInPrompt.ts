/**
 * 'private-buy-in': Net/PrivateBuyInPrompt.cs, the buy-in slider shown when Join Table is pressed at a private
 * (Photon) room. Code-built in Unity (an overlay canvas, sorting 950, ScaleWithScreenSize 1920×1080 → Expand), with
 * the Resources/BuyInTables art: a 640×280 "bg 4" plate, "Buy in" title, the range line, a 560×36 slider on
 * "scroll bg 1" filled with "yellow scroll 1", and a 280×64 "join green 1" JOIN button. The range is 500–1,000,
 * capped by the Coin balance; the slider starts at the most the player can put down. Clicking the dim cancels.
 * Built as uGUI node data (same numbers as the C#) rendered by src/hud/unityUi.ts; sprites from web3-ui.json.
 *
 * Params: { onConfirm: (amount: number) => void; coins?: number; onCancel?: () => void }
 *   coins defaults to ctx.services.wallet.coins (VirtualEconomy.Wallet.Coins).
 */
import type { AppContext, Screen } from '../../app/app';
import { buildNode, HUD_DATA, UNode, type NodeData } from '../../hud/unityUi';
import { formatN0 } from '../per/format';
import { ChainTableMode } from '../solana/identity';
import { closeScreen } from './lazy';
import { colorTint, UButton, UCanvas } from './ugui';
import { WEB3_UI } from './walletPicker';

export interface PrivateBuyInParams {
  onConfirm: (amount: number) => void;
  coins?: number;
  onCancel?: () => void;
}

/** TMP_Settings.defaultFontAsset: LiberationSans SDF (its guid in unity-hud.json's font table). */
const DEFAULT_FONT = Object.entries(HUD_DATA.fonts).find(([, f]) => f.name === 'LiberationSans SDF')?.[0] ?? '';

type Rect = NonNullable<NodeData['rect']>;
const col = (r: number, g: number, b: number, a: number) => ({ hex: '', rgba: [r, g, b, a] as [number, number, number, number] });
const WHITE = col(1, 1, 1, 1);

function rect(o: Partial<Rect> = {}): Rect {
  return { anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], anchoredPosition: [0, 0], sizeDelta: [100, 100], pivot: [0.5, 0.5], euler: [0, 0, 0], scale: [1, 1, 1], ...o };
}
/** anchorMin 0, anchorMax 1, offsetMin = offsetMax = 0 (or the given insets). */
const stretch = (minX = 0, maxX = 0): Partial<Rect> => ({ anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [maxX - minX, 0], anchoredPosition: [(minX + maxX) / 2, 0] });

function n(name: string, r: Partial<Rect>, components?: NodeData['components'], children?: NodeData[]): NodeData {
  return { name, path: 'PrivateBuyIn/' + name, active: true, rect: rect(r), components, children };
}
/** Image with a BuyInTables sprite (Sliced when it loaded, as the C# does). */
function image(sprite: string | null, color = WHITE): NonNullable<NodeData['components']>['image'] {
  const key = sprite ? (WEB3_UI.buyInSprites[sprite] ?? null) : null;
  return { enabled: true, sprite: key, color, type: key ? 'Sliced' : 'Simple', pixelsPerUnitMultiplier: 1 } as NonNullable<NodeData['components']>['image'];
}
/** PrivateBuyInPrompt.Text: TMP, centred, white, word wrap. */
function label(name: string, text: string, size: number, bold: boolean, pos: [number, number], box: [number, number], color = WHITE): NodeData {
  return n(name, { anchoredPosition: pos, sizeDelta: box }, {
    text: { enabled: true, text, font: DEFAULT_FONT, fontSize: size, autoSize: false, fontSizeMin: size, fontSizeMax: size, fontStyle: bold ? ['bold'] : [], color, alignH: 'center', alignV: 'middle', wrapping: true, margin: [0, 0, 0, 0] },
  } as NodeData['components']);
}

/** The prompt's numbers: PrivateBuyInPrompt.Build. */
export function buyInRange(coins: number): { min: number; max: number; canAfford: boolean; value: number } {
  const min = ChainTableMode.PRIVATE_MIN_BUY_IN;
  let max = coins < ChainTableMode.PRIVATE_MAX_BUY_IN ? coins : ChainTableMode.PRIVATE_MAX_BUY_IN;
  if (max < min) max = min;
  const canAfford = coins >= min;
  return { min, max, canAfford, value: canAfford ? max : min };
}

const DEFAULT_TINT = {
  normal: { r: 1, g: 1, b: 1, a: 1 },
  highlighted: { r: 0.9608, g: 0.9608, b: 0.9608, a: 1 },
  pressed: { r: 0.7843, g: 0.7843, b: 0.7843, a: 1 },
  selected: { r: 0.9608, g: 0.9608, b: 0.9608, a: 1 },
  disabled: { r: 0.7843, g: 0.7843, b: 0.7843, a: 0.502 },
  fade: 0.1,
};

export class PrivateBuyInScreen implements Screen {
  readonly overlay = true;
  private root!: HTMLElement;
  private canvas: UCanvas | null = null;
  private buttons: UButton[] = [];
  private params!: PrivateBuyInParams;
  private value = 0;
  private done = false;
  private offDrag: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  mount(root: HTMLElement, params?: unknown): void {
    this.root = root;
    this.params = (params ?? {}) as PrivateBuyInParams;
    const coins = Math.trunc(this.params.coins ?? this.ctx.services.wallet?.coins ?? 0);
    const { min, max, canAfford, value } = buyInRange(coins);
    this.value = value;
    const range = canAfford
      ? `${formatN0(min)} – ${formatN0(max)}    ·    blinds ${formatN0(ChainTableMode.PRIVATE_SMALL_BLIND)} / ${formatN0(ChainTableMode.PRIVATE_BIG_BLIND)}`
      : `You have ${formatN0(coins)} Coins. This table needs ${formatN0(min)}–${formatN0(ChainTableMode.PRIVATE_MAX_BUY_IN)}.`;
    const plate = WEB3_UI.buyInSprites['bg 4'];

    const data = n('Root', stretch(), undefined, [
      n('Dim', stretch(), { image: image(null, col(0.02, 0.03, 0.08, 0.72)) }),
      n('Panel', { sizeDelta: [640, 280] }, { image: plate ? image('bg 4') : image(null, col(0.05, 0.08, 0.18, 0.96)) }, [
        label('Title', 'Buy in', 36, true, [0, 96], [560, 48]),
        label('Range', range, 22, false, [0, 52], [560, 36]),
        n('Slider', { sizeDelta: [560, 36], anchoredPosition: [0, 4] }, { image: image('scroll bg 1', WEB3_UI.buyInSprites['scroll bg 1'] ? WHITE : col(0.08, 0.08, 0.1, 1)) }, [
          n('Fill Area', { anchorMin: [0, 0.2], anchorMax: [1, 0.8], sizeDelta: [-12, 0] }, undefined, [n('Fill', stretch(), { image: image('yellow scroll 1') })]),
          n('Handle Slide Area', stretch(), undefined, [n('Handle', { sizeDelta: [28, 28] }, { image: image(null, col(1, 1, 1, 0.01)) })]),
        ]),
        n('Join', { sizeDelta: [280, 64], anchoredPosition: [0, -78] }, { image: image('join green 1', WEB3_UI.buyInSprites['join green 1'] ? WHITE : col(0.45, 0.92, 0.35, 1)) }, [
          label('Label', '', 26, true, [0, 0], [260, 60], col(0.08, 0.1, 0.08, 1)),
        ]),
      ]),
    ]);
    const tree = buildNode(data, { sprites: WEB3_UI.sprites, fonts: HUD_DATA.fonts });
    const canvasRoot = new UNode('PrivateBuyIn');
    canvasRoot.add(tree);
    this.canvas = new UCanvas(root, canvasRoot);

    const dim = new UButton(tree.find('Dim')!, () => {});
    dim.onClick = () => this.dismiss();
    const join = tree.find('Panel/Join')!;
    const joinButton = new UButton(join, colorTint(join, DEFAULT_TINT));
    joinButton.interactable = canAfford;
    joinButton.onClick = () => this.confirm();
    const joinLabel = join.find('Label')!;
    joinLabel.setText(canAfford ? `JOIN  –  ${formatN0(value)}` : 'NOT ENOUGH BALANCE');
    this.buttons.push(dim, joinButton);

    // Slider (wholeNumbers, LeftToRight): fill anchorMax.x and the handle at the normalized value.
    const slider = tree.find('Panel/Slider')!;
    const fill = slider.find('Fill Area/Fill')!;
    const handle = slider.find('Handle Slide Area/Handle')!;
    const interactable = canAfford && max > min;
    const sliderTint = colorTint(slider, DEFAULT_TINT);
    sliderTint(interactable ? 'Normal' : 'Disabled', true);
    const paint = () => {
      const t = max > min ? (this.value - min) / (max - min) : 0;
      fill.anchorMax = [t, 1];
      handle.anchorMin = [t, 0];
      handle.anchorMax = [t, 1];
      slider.layout();
    };
    paint();
    if (interactable) {
      const area = slider.find('Handle Slide Area')!;
      let dragging = false;
      const set = (clientX: number) => {
        const r = area.el.getBoundingClientRect();
        const t = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
        const v = Math.round(min + t * (max - min));
        if (v === this.value) return;
        this.value = v;
        paint();
        joinLabel.setText(`JOIN  –  ${formatN0(v)}`); // OnSlider
      };
      slider.el.style.cursor = 'pointer';
      slider.el.addEventListener('pointerenter', () => sliderTint('Highlighted', false));
      slider.el.addEventListener('pointerleave', () => !dragging && sliderTint('Normal', false));
      slider.el.addEventListener('pointerdown', (e) => {
        dragging = true;
        sliderTint('Pressed', false);
        set(e.clientX);
        e.preventDefault();
      });
      const move = (e: PointerEvent) => dragging && set(e.clientX);
      const up = () => {
        if (!dragging) return;
        dragging = false;
        sliderTint('Normal', false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      this.offDrag = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
    }
    this.canvas.layout();
  }

  /** The dim: Close(force: false). */
  private dismiss(): void {
    if (this.done) return;
    this.done = true;
    closeScreen(this.ctx, this.root);
    this.params.onCancel?.();
  }

  /** Confirm: close, then PokerClientGame.ConfirmPrivateBuyIn(amount). */
  private confirm(): void {
    if (this.done) return;
    this.done = true;
    const amount = this.value;
    closeScreen(this.ctx, this.root);
    this.params.onConfirm?.(amount);
  }

  unmount(): void {
    for (const b of this.buttons) b.dispose();
    this.buttons = [];
    this.offDrag?.();
    this.canvas?.dispose();
    this.canvas = null;
  }
}
