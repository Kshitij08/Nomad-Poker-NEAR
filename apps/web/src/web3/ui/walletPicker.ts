/**
 * 'wallet-picker': the Solana Unity SDK's wallet picker (Assets/Resources/SolanaUnitySDK/WalletAdapterUI.prefab, a
 * WalletAdapterButton.prefab row per wallet), as Auth/WalletAdapterPopup.cs drives it: the list the browser really
 * has, a pick connects through that wallet, and the Exit button is a cancel (the SDK only hid the popup and left the
 * login pending; the wrapper turns it into "null"). Built from data/web3-ui.json (tools/extract-web3-ui.mjs).
 *
 * Params: { wallets: BrowserWallet[]; resolve: (w: BrowserWallet | null) => void }. `resolve` is called exactly once
 * (a pick, Exit, or the screen going away for any other reason = null), then the screen closes itself.
 * screens.ts installs it as SolanaService.picker.
 */
import type { AppContext, Screen } from '../../app/app';
import { assetUrl, buildNode, registerTmpFont, type FontData, type NodeData, type SpriteData, type UNode } from '../../hud/unityUi';
import web3Ui from '../../data/web3-ui.json';
import type { BrowserWallet } from '../solana/wallets';
import { closeScreen } from './lazy';
import { applyLayoutGroups, colorTint, pairNodes, rgbaOf, scalePunch, UButton, UCanvas } from './ugui';

export interface WalletPickerParams {
  wallets: BrowserWallet[];
  resolve: (wallet: BrowserWallet | null) => void;
}

interface Web3UiData {
  trees: Record<'walletAdapterUI' | 'walletAdapterButton', { prefab: string; root: NodeData }>;
  buyInSprites: Record<string, string>;
  sprites: Record<string, SpriteData & { missing?: boolean }>;
  fonts: Record<string, FontData & { file?: string }>;
}
export const WEB3_UI = web3Ui as unknown as Web3UiData;

/** Wraps a resolver so only the first answer counts (a pick racing the Exit button, or unmount after a pick). */
export function resolveOnce<T>(fn: (v: T | null) => void): (v: T | null) => boolean {
  let done = false;
  return (v) => {
    if (done) return false;
    done = true;
    try {
      fn(v);
    } catch (e) {
      console.error('[WalletAdapterPopup] picker callback failed', e);
    }
    return true;
  };
}

let fontsRegistered = false;
/** TMP font assets of the picker → CSS families (Roboto-Regular SDF ships with the extracted .ttf). */
export function registerWeb3Fonts(): void {
  if (fontsRegistered || typeof document === 'undefined') return;
  fontsRegistered = true;
  const faces: string[] = [];
  for (const f of Object.values(WEB3_UI.fonts)) {
    if (!f.name || !f.file) continue;
    const family = 'Web3' + f.name.replace(/[^A-Za-z0-9]/g, '');
    registerTmpFont(f.name, `'${family}'`);
    faces.push(`@font-face{font-family:'${family}';src:url('${assetUrl(f.file)}') format('truetype');font-weight:400;font-display:block}`);
  }
  const s = document.createElement('style');
  s.textContent = faces.join('\n');
  document.head.append(s);
}

/** The SDK's Button-Action.controller "Pressed" clip (Exit Button): localScale keys. */
const BUTTON_ACTION_PRESSED = [
  { t: 0, x: 1, y: 1 },
  { t: 0.0333, x: 0.9, y: 0.9 },
  { t: 0.1333, x: 1.2, y: 1.5 },
  { t: 0.25, x: 1, y: 1 },
];

const buttonColors = (d: NodeData) => {
  const b = (d.components as { button?: { colors: Record<string, { rgba: [number, number, number, number] } | number> } } | undefined)?.button;
  const c = b?.colors ?? {};
  const col = (k: string) => rgbaOf(c[k] as { rgba: [number, number, number, number] } | undefined);
  return { normal: col('normal'), highlighted: col('highlighted'), pressed: col('pressed'), selected: col('selected'), disabled: col('disabled'), fade: Number(c.fadeDuration ?? 0.1), multiplier: Number(c.colorMultiplier ?? 1) };
};

export class WalletPickerScreen implements Screen {
  readonly overlay = true;
  private canvas: UCanvas | null = null;
  private buttons: UButton[] = [];
  private resolve: ((w: BrowserWallet | null) => boolean) | null = null;
  private root!: HTMLElement;
  private scrollOff: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  mount(root: HTMLElement, params?: unknown): void {
    this.root = root;
    const p = (params ?? {}) as Partial<WalletPickerParams>;
    this.resolve = resolveOnce<BrowserWallet>((w) => p.resolve?.(w));
    registerWeb3Fonts();
    const opts = { sprites: WEB3_UI.sprites, fonts: WEB3_UI.fonts };
    const uiData = WEB3_UI.trees.walletAdapterUI.root;
    const ui = buildNode(uiData, opts);
    const pairs = pairNodes(ui, uiData);
    // The prefab root is the canvas (inactive until the SDK shows it; Canvas roots carry scale 0 in prefabs).
    (ui as unknown as { activeSelfFlag: boolean }).activeSelfFlag = true;
    ui.el.style.display = '';

    const screen = ui.find('WalletAdapterScreen')!;
    const viewport = screen.find('Scroll View/Viewport')!;
    const content = viewport.find('Content')!;
    // Mask (showMaskGraphic off, the full-rect UIMask sprite): clip to the viewport, draw nothing of its own.
    viewport.image = null;
    viewport.maskWithGraphic = false;
    this.canvas = new UCanvas(root, ui);
    viewport.el.style.overflow = 'hidden';
    viewport.el.classList.add('w3-hit'); // the ScrollRect takes wheel / drag

    // WalletAdapterScreen.UpdateWalletAdapterButtons: one row per wallet (by name, once).
    const added = new Set<string>();
    const rowData = WEB3_UI.trees.walletAdapterButton.root;
    for (const wallet of p.wallets ?? []) {
      if (added.has(wallet.name)) continue;
      added.add(wallet.name);
      const row = buildNode(rowData, opts);
      pairNodes(row, rowData, pairs);
      row.find('WalletName')?.setText(wallet.name);
      // DetectedLabel's TMP is enabled for wallets the browser reports as installed: every wallet listed here is.
      const icon = row.find('Icon');
      if (icon) {
        icon.image = null; // the sprite is made from the wallet's icon at runtime
        const img = document.createElement('img');
        img.src = wallet.icon;
        img.alt = '';
        img.draggable = false;
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none';
        icon.el.append(img);
      }
      content.add(row);
      const b = new UButton(row, colorTint(row, buttonColors(rowData)));
      b.onClick = () => this.pick(wallet);
      this.buttons.push(b);
    }

    const exitNode = screen.find('Exit Button')!;
    const exit = new UButton(exitNode, scalePunch(exitNode, BUTTON_ACTION_PRESSED, () => exitNode.layout()));
    exit.onClick = () => this.pick(null);
    this.buttons.push(exit);

    const scrollView = screen.find('Scroll View')!;
    const vbar = scrollView.find('Scrollbar Vertical');
    const handle = vbar?.find('Sliding Area/Handle') ?? null;
    scrollView.find('Scrollbar Horizontal')?.setActive(false);
    viewport.el.addEventListener('wheel', (e) => {
      if (content.h <= viewport.h) return;
      e.preventDefault();
      this.scrollTo(content, viewport, vbar, handle, this.scrollY + e.deltaY);
    }, { passive: false });
    this.dragScroll(viewport, content, vbar, handle);

    this.canvas.afterLayout = () => {
      applyLayoutGroups(ui, pairs);
      // ScrollRect, vertical, Clamped, scrollbar AutoHideAndExpandViewport: no scrollbar and a full-size viewport
      // while the list fits (and the content centred: its pivot is 0.5); otherwise a 20-unit scrollbar.
      const overflow = content.h > scrollView.h + 0.5;
      vbar?.setActive(overflow);
      viewport.sizeDelta = overflow ? [-17, 0] : [0, 0];
      scrollView.layout();
      applyLayoutGroups(scrollView, pairs);
      if (!overflow) this.scrollY = 0;
      this.scrollTo(content, viewport, vbar, handle, overflow ? this.scrollY || (content.h - viewport.h) / 2 : 0);
    };
    this.canvas.layout();
  }

  private scrollY = 0;

  /** Content offset from the top of the viewport (0 = top), clamped; mirrored on the scrollbar handle. */
  private scrollTo(content: UNode, viewport: UNode, vbar: UNode | null | undefined, handle: UNode | null, y: number): void {
    const range = Math.max(0, content.h - viewport.h);
    if (range <= 0) {
      content.el.style.transform = '';
      return;
    }
    this.scrollY = Math.min(range, Math.max(0, y));
    // Content sits centred in the viewport by its own layout; shift it so its top is at -scrollY.
    const top = parseFloat(content.el.style.top || '0');
    content.el.style.transform = `translateY(${-this.scrollY - top}px)`;
    if (handle && vbar?.activeSelf) {
      const size = viewport.h / content.h;
      const value = 1 - this.scrollY / range; // Scrollbar BottomToTop: 1 = top
      handle.anchorMin = [0, value * (1 - size)];
      handle.anchorMax = [1, value * (1 - size) + size];
      vbar.layout();
    }
  }

  private dragScroll(viewport: UNode, content: UNode, vbar: UNode | null | undefined, handle: UNode | null): void {
    let startY = 0;
    let startScroll = 0;
    let dragging = false;
    viewport.el.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startScroll = this.scrollY;
    });
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const s = this.canvas?.scale ?? 1;
      this.scrollTo(content, viewport, vbar, handle, startScroll - (e.clientY - startY) / s);
    };
    const up = () => (dragging = false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.scrollOff = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }

  /** A wallet button (WalletAdapterScreen.OnSelectedAction) or Exit (null): answer once, then close. */
  private pick(wallet: BrowserWallet | null): void {
    if (!this.resolve?.(wallet)) return;
    if (wallet) console.log(`[WalletAdapterPopup] picked ${wallet.name}`);
    else console.log('[WalletAdapterPopup] Wallet picker closed by the player.');
    closeScreen(this.ctx, this.root);
  }

  unmount(): void {
    // Closed some other way (navigation): the login must not stay pending (the SDK's bug this wrapper fixes).
    this.resolve?.(null);
    for (const b of this.buttons) b.dispose();
    this.buttons = [];
    this.scrollOff?.();
    this.canvas?.dispose();
    this.canvas = null;
  }
}
