/** Shared access for v2 screens: the app context, the Nomad menu host, and small data readers. */
import type { AppContext } from '../app/app';
import type { NomadHost } from '../menu/host';
import { svc, progressionOf, canSpin, canClaimLogin, accountExtras } from '../menu/deps';
import { onchainApi } from '../web3/nomad/onchainPartial';
import { NomadPlayMode } from '../web3/solana/identity';
import { esc, fmt, btn, type V2 } from './core';
import { ico } from './icons';

let _ui: V2;
let _ctx: AppContext;
let _host: NomadHost;

export function setUi(ui: V2, ctx: AppContext, host: NomadHost): void {
  _ui = ui;
  _ctx = ctx;
  _host = host;
}
export const ui = (): V2 => _ui;
export const app = (): AppContext => _ctx;
export const host = (): NomadHost => _host;
/** Any installed service by name (they are optional; check before use). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const S = (name: string): any => (_ctx?.services as unknown as Record<string, unknown>)?.[name];

export { svc, progressionOf, canSpin, canClaimLogin, accountExtras, onchainApi };

export const onchain = (): boolean => !!_host?.onchain;
export const signedIn = (): boolean => !!_ctx?.services.account.signedIn;

export function coins(): number {
  return _host?.stakes.coins ?? 10_000;
}

export function playerName(): string {
  return _ctx?.services.account.displayName || 'Player';
}

/** Avatar image URL for a player (current player when omitted). */
export function avatarUrl(avatar?: number, name?: string): string | null {
  const av = S('avatars');
  // With no picture chosen, show the same name-based default the table shows (not a blank placeholder).
  if (avatar === undefined && name === undefined) name = playerName();
  try {
    const n = avatar ?? (av?.current as number | undefined) ?? (_ctx?.services.account as unknown as { avatar?: number }).avatar ?? 0;
    if (n > 0 && av?.spriteUrl) return av.spriteUrl(n) as string | null;
    if (name && av?.shown) {
      const m = av.shown(name) as number;
      if (m > 0 && av.spriteUrl) return av.spriteUrl(m) as string | null;
    }
  } catch {
    /* no avatars service */
  }
  return null;
}

/** Avatar circle markup. size: '' | 's' | 'xs'. */
export function avatar(size = '', url: string | null = avatarUrl(), extra = ''): string {
  const bg = url ? ` style="background-image:url('${esc(url)}');${extra}"` : extra ? ` style="${extra}"` : '';
  return `<div class="v2-av ${size}"${bg}></div>`;
}

export function level(): { level: number; p: number; into: number; next: number } {
  const p = S('retention')?.progression;
  const prog = progressionOf(_ctx);
  const lv = prog?.level ?? 1;
  const p01 = prog?.levelProgress01 ?? 0;
  const into = Number(p?.xpIntoLevel ?? 0);
  const toNext = Number(p?.xpToNext ?? 0);
  return { level: lv, p: p01, into, next: into + toNext };
}

/** Coins or SOL capsule (with +): Coins → Shop, SOL → profile wallet. */
export function coinCap(): string {
  if (onchain()) {
    const t = onchainApi.walletAddress?.() ? (onchainApi.balanceText?.() ?? _host.solShort ?? '').split(' (')[0].split(' · ')[0] : 'Connect';
    return `<button class="v2-coin" data-a="profile-open" aria-label="SOL balance and wallet">${ico('sol', 1.9)}<b class="v2-num">${esc(t || '—')}</b><span class="v2-plus">${ico('plus', 0.8)}</span></button>`;
  }
  return `<button class="v2-coin" data-a="go" data-v="shop:coins" aria-label="Coins, open the Shop">${ico('coin', 1.9)}<b class="v2-num">${fmt(coins())}</b><span class="v2-plus">${ico('plus', 0.8)}</span></button>`;
}

/** Demo / On-chain switch. */
export function modeSeg(): string {
  const on = onchain();
  return `<div class="v2-seg" role="group" aria-label="Play mode"><button class="${on ? '' : 'on'}" data-a="mode" data-v="demo">Demo</button><button class="${on ? 'on' : ''}" data-a="mode" data-v="chain">On-chain</button></div>`;
}

/** Switches play mode (On-chain connects a wallet first). Register as the screen's `mode` action. */
export async function setMode(v: string): Promise<void> {
  const want = v === 'chain';
  if (want === onchain()) return;
  if (onchainApi.toggleMode) await onchainApi.toggleMode();
  else {
    NomadPlayMode.onchain = want;
    _host.onchain = want;
  }
  _ui.render();
}

/** The play mode as a small pill (sub-screens): the switch itself lives on the main menu and the profile popover. */
export function modePill(): string {
  return onchain() ? `<span class="v2-pill sol v2-mode-pill">On-chain</span>` : `<span class="v2-pill v2-mode-pill">Demo</span>`;
}

/**
 * The standard top bar: Back, the screen title (the same words as the dock item or button that opened it, Title Case,
 * spade ornaments on every screen), the play-mode pill, coins. `toggle: true` shows the switch instead of the pill.
 */
export function topBar(title: string, o: { toggle?: boolean; right?: string; back?: string } = {}): string {
  const mode = o.toggle === true ? modeSeg() : modePill();
  return `<div class="v2-top"><button class="v2-back" data-a="${o.back ? 'go' : 'back'}"${o.back ? ` data-v="${o.back}"` : ''} aria-label="Back">${ico('back', 1.1)}<span class="v2-lbl">Back</span></button><h1 class="v2-title">${ico('spade', 0.8)} ${title} ${ico('spade', 0.8)}</h1>${mode}${o.right ?? coinCap()}</div>`;
}

/** Runs an async action that returns an error string or null; shows the error in a v2 dialog. */
export async function run(op: () => Promise<string | null | undefined | void>, onOk?: () => void, title = 'Something went wrong'): Promise<void> {
  try {
    const err = await op();
    if (err) _ui.message(title, esc(err));
    else onOk?.();
  } catch (e) {
    _ui.message(title, esc(e instanceof Error ? e.message : String(e)));
  }
  _ui.render();
}

/** Text prompt in a v2 dialog. */
export function prompt(title: string, body: string, placeholder: string, value: string, ok: string, onOk: (v: string) => void, max = 40): void {
  let val = value;
  _ui.openDialog({
    title: esc(title),
    body: `${body ? `<div style="margin-bottom:.7em">${body}</div>` : ''}<input class="v2-field" style="width:100%" id="v2-prompt" data-dlg-in="1" maxlength="${max}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`,
    buttons: btn('Cancel', 'p-cancel', { h: 'ghost' }) + btn(esc(ok), 'p-ok', { h: 'gold' }),
    actions: {
      'p-cancel': () => _ui.closeDialog(),
      'p-ok': () => {
        const el = document.getElementById('v2-prompt') as HTMLInputElement | null;
        val = el?.value ?? val;
        _ui.closeDialog();
        onOk(val.trim());
      },
    },
  });
}

export function copy(text: string, toast = 'Copied'): void {
  try {
    void navigator.clipboard?.writeText(text).then(() => _ui.toast(toast), () => _ui.toast(text));
  } catch {
    _ui.toast(text);
  }
}

export function openUrl(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/** "Not enough Coins" in the v2 look, with a way to the Shop's Coins. Returns true when the player can't afford it. */
export function needCoins(min: number, what: string): boolean {
  if (onchain() || coins() >= min) return false;
  _ui.openDialog({
    title: 'Not enough Coins',
    body: `${esc(what)} needs ${fmt(min)} Coins. You have ${fmt(coins())}. Get Coins in the Shop, or claim today's free spin.`,
    buttons: btn('Shop', 'nc-shop', { h: 'green' }) + btn('OK', 'nc-ok', { h: 'gold' }),
    actions: { 'nc-shop': () => _ui.show('shop', 'coins'), 'nc-ok': () => _ui.closeDialog() },
  });
  return true;
}
