/**
 * On-chain (SOL) surfaces in v2 (docs/ui-style-guide.md):
 *  - 'wallet-picker': the wallets this browser has, as a v2 sheet (empty state with install links). Replaces the
 *    Solana SDK prefab picker; SolanaService.picker still pushes this route, and the answer contract is the same
 *    (resolve exactly once: a pick, or null for Cancel / Escape / the screen going away).
 *  - 'private-buy-in': the private-room buy-in (500–1,000 Coins, blinds 5 / 10) as a v2 dialog.
 *  - The private-tables panels ('private-tables', 'private-host', 'private-tourneys', 'private-tourney-host',
 *    'private-agent') keep their routes and logic; their view layer (src/web3/ui/perUi.ts) draws the v2 skin, and
 *    Escape / back close them (src/web3/ui/lazy.ts).
 */
import type { AppContext, Screen } from '../../app/app';
import type { NomadHost } from '../../menu/host';
import type { BrowserWallet } from '../../web3/solana/wallets';
import type { WalletPickerParams } from '../../web3/ui/walletPicker';
import { buyInRange, type PrivateBuyInParams } from '../../web3/ui/buyInPrompt';
import { ChainTableMode } from '../../web3/solana/identity';
import { formatN0 } from '@nomad/engine';
import { esc, type V2 } from '../core';
import { ico } from '../icons';
import type { ScreenDef } from '../install';
import './sol.css';

export function solScreens(): ScreenDef[] {
  return [];
}

/** Replaces the web3 module's wallet picker and private buy-in with v2 versions (same routes, same params). */
export function installSolOverlays(ctx: AppContext, _host: NomadHost, _ui: V2): void {
  ctx.router.register('wallet-picker', (c) => new WalletSheet(c));
  ctx.router.register('private-buy-in', (c) => new BuyInSheet(c));
}

/** A router overlay drawn as a v2 dialog; Escape and a tap on the dim cancel. */
abstract class SheetScreen implements Screen {
  readonly overlay = true;
  protected root!: HTMLElement;
  protected el!: HTMLElement;
  private closed = false;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || this.ctx.router.current !== this.root.dataset.screen) return;
    if (document.querySelector('.v2-global:not([hidden])')) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.cancel();
  };

  constructor(protected readonly ctx: AppContext) {}

  protected mountSheet(root: HTMLElement, title: string, body: string, wide = false): HTMLElement {
    this.root = root;
    root.style.pointerEvents = 'auto';
    this.el = document.createElement('div');
    this.el.className = 'v2 v2-sheet-host';
    this.el.innerHTML = `<div class="v2-dim"><div class="v2-dlg${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="v2-dh">${esc(title)}</div><div class="v2-db">${body}</div><div class="v2-df"></div></div></div>`;
    root.append(this.el);
    this.el.querySelector('.v2-dim')!.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.cancel();
    });
    window.addEventListener('keydown', this.onKey, true);
    return this.el;
  }

  protected button(label: string, hue: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `v2-b ${hue}`;
    b.innerHTML = label;
    b.addEventListener('click', run);
    this.el.querySelector('.v2-df')!.append(b);
    return b;
  }

  /** Closes the route once (the subclass answers its caller first). */
  protected close(): void {
    if (this.closed) return;
    this.closed = true;
    const id = this.root.dataset.screen;
    if (this.root.isConnected && (!id || this.ctx.router.current === id)) this.ctx.router.back();
  }

  protected abstract cancel(): void;

  abstract mount(root: HTMLElement, params?: unknown): void;

  unmount(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.el?.remove();
  }
}

// ------------------------------------------------------------------ wallet picker

const INSTALL = [
  ['Phantom', 'https://phantom.app/download'],
  ['Solflare', 'https://solflare.com/download'],
] as const;

class WalletSheet extends SheetScreen {
  private answer: ((w: BrowserWallet | null) => void) | null = null;

  mount(root: HTMLElement, params?: unknown): void {
    const p = (params ?? {}) as Partial<WalletPickerParams>;
    let done = false;
    this.answer = (w) => {
      if (done) return;
      done = true;
      try {
        p.resolve?.(w);
      } catch (e) {
        console.error('[wallet-picker] callback failed', e);
      }
    };
    const seen = new Set<string>();
    const wallets = (p.wallets ?? []).filter((w) => !seen.has(w.name) && (seen.add(w.name), true));
    const body = wallets.length
      ? `<p class="v2-bi-cap">Pick the wallet to play On-chain with. SOL tables run on Solana devnet.</p><div class="v2-wl" role="list">${wallets
          .map((w, i) => `<button class="v2-wl-row" role="listitem" data-w="${i}"><img src="${esc(w.icon)}" alt="" draggable="false"><b>${esc(w.name)}</b><span class="v2-pill ok">Detected</span></button>`)
          .join('')}</div>`
      : `<div class="v2-wl-empty">${ico('sol', 4)}<b>No Solana wallet found</b><p>Install Phantom or Solflare in this browser, then reload the page. On a phone, open Nomad Poker inside the wallet app's browser.</p><div class="v2-wl-links">${INSTALL.map(([n, u]) => `<a class="v2-b blue sm" href="${u}" target="_blank" rel="noopener">Get ${n}</a>`).join('')}</div></div>`;
    const el = this.mountSheet(root, wallets.length ? 'Connect a wallet' : 'Connect a wallet', body);
    el.querySelectorAll<HTMLElement>('[data-w]').forEach((b) =>
      b.addEventListener('click', () => {
        const w = wallets[Number(b.dataset.w)];
        if (!w) return;
        console.log(`[WalletAdapterPopup] picked ${w.name}`);
        this.answer?.(w);
        this.close();
      }),
    );
    this.button(wallets.length ? 'Cancel' : 'Close', 'ghost', () => this.cancel());
    (el.querySelector('[data-w]') as HTMLElement | null)?.focus();
  }

  protected cancel(): void {
    this.answer?.(null);
    this.close();
  }

  unmount(): void {
    // Closed some other way (navigation): the connect must not stay pending.
    this.answer?.(null);
    super.unmount();
  }
}

// ------------------------------------------------------------------ private buy-in

class BuyInSheet extends SheetScreen {
  private params: PrivateBuyInParams | null = null;
  private done = false;

  mount(root: HTMLElement, raw?: unknown): void {
    const p = (raw ?? {}) as PrivateBuyInParams;
    this.params = p;
    const coins = p.coins ?? Number((this.ctx.services as unknown as { wallet?: { coins?: number } }).wallet?.coins ?? 0);
    const { min, max, canAfford, value } = buyInRange(coins);
    const blinds = `Private table · blinds ${formatN0(ChainTableMode.PRIVATE_SMALL_BLIND)} / ${formatN0(ChainTableMode.PRIVATE_BIG_BLIND)}`;
    const body = canAfford
      ? `<p class="v2-bi-cap">${esc(blinds)} · buy in ${formatN0(min)}–${formatN0(max)} Coins</p>
         <div class="v2-bi-amt" aria-live="polite">${formatN0(value)}</div>
         <input class="v2-bi-range" type="range" min="${min}" max="${max}" step="10" value="${value}" aria-label="Buy-in"${max > min ? '' : ' disabled'}>
         <div class="v2-bi-ends"><button class="v2-chip" data-end="min">Min ${formatN0(min)}</button><button class="v2-chip" data-end="max">Max ${formatN0(max)}</button></div>`
      : `<p class="v2-bi-cap">${esc(blinds)}</p><p class="v2-bi-short">You have ${formatN0(coins)} Coins. This table needs ${formatN0(min)}–${formatN0(ChainTableMode.PRIVATE_MAX_BUY_IN)}.</p>`;
    const el = this.mountSheet(root, 'Buy in', body);
    let amount = value;
    const amt = el.querySelector<HTMLElement>('.v2-bi-amt');
    const range = el.querySelector<HTMLInputElement>('.v2-bi-range');
    const set = (v: number): void => {
      amount = Math.max(min, Math.min(max, Math.round(v)));
      if (range) range.value = String(amount);
      if (amt) amt.textContent = formatN0(amount);
      if (join) join.textContent = `Join · ${formatN0(amount)}`;
    };
    range?.addEventListener('input', () => set(Number(range.value)));
    el.querySelectorAll<HTMLElement>('[data-end]').forEach((b) => b.addEventListener('click', () => set(b.dataset.end === 'min' ? min : max)));
    this.button('Cancel', 'ghost', () => this.cancel());
    const join = canAfford ? this.button(`Join · ${formatN0(amount)}`, 'gold', () => this.confirm(amount)) : null;
    join?.focus();
  }

  private confirm(amount: number): void {
    if (this.done) return;
    this.done = true;
    this.close();
    this.params?.onConfirm?.(amount);
  }

  protected cancel(): void {
    if (this.done) return;
    this.done = true;
    this.close();
    this.params?.onCancel?.();
  }
}
