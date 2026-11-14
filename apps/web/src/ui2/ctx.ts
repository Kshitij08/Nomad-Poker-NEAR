/** Shared access for v2 screens: the app context, the Nomad menu host, and small data readers. */
import type { AppContext } from '../app/app';
import { PokerSound } from '@nomad/engine';
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
  // "Get Coins" anywhere (locked room, coin balance +): free Coins in Demo, the Shop when it sells (getCoinsRoute).
  ui.globalActions['get-coins'] = () => getCoinsRoute().go();
}
export const ui = (): V2 => _ui;
export const app = (): AppContext => _ctx;
export const host = (): NomadHost => _host;
/** Any installed service by name (they are optional; check before use). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const S = (name: string): any => (_ctx?.services as unknown as Record<string, unknown>)?.[name];

export { svc, progressionOf, canSpin, canClaimLogin, accountExtras, onchainApi };

export const onchain = (): boolean => !!_host?.onchain;
/** Plays a sound effect through the game's audio (SFX volume); silent when audio isn't up. */
export const sfx = (s: PokerSound): void => void _ctx?.audio?.play(s);
export const signedIn = (): boolean => !!_ctx?.services.account.signedIn;

export function coins(): number {
  return _host?.stakes.coins ?? 10_000;
}

/** A balance the top bar shows instead of the live one (null = live), so a reveal (the Daily spin) isn't spoiled. */
let heldCoins: number | null = null;
export function holdShownCoins(n: number | null): void {
  heldCoins = n;
}

export function playerName(): string {
  return _ctx?.services.account.displayName || 'Player';
}

/** Avatar image URL for a player (current player when omitted). */
/** An uploaded picture's address (served by the Nomad API), or null. */
export function pictureUrl(key: string | null | undefined): string | null {
  const api = _ctx?.services.nomadApi as unknown as { pictureUrl?: (k: string | null | undefined) => string | null } | null | undefined;
  return key && api?.pictureUrl ? api.pictureUrl(key) : null;
}

/** Your uploaded picture's key, or null. */
export function myPicture(): string | null {
  const api = _ctx?.services.nomadApi as unknown as { me?: { player?: { picture?: string | null } } } | null | undefined;
  return api?.me?.player?.picture ?? null;
}

export function avatarUrl(avatar?: number, name?: string): string | null {
  // Yours: the uploaded picture, when there is one.
  if (avatar === undefined && name === undefined) {
    const mine = pictureUrl(myPicture());
    if (mine) return mine;
  }
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
    // Connected wallet → its game balance; a wallet the account knows but hasn't reconnected yet (after a reload) or a
    // balance not read yet → "—" (beside the SOL icon); no wallet at all → "Connect".
    const live = onchainApi.walletAddress?.() ?? (S('solana')?.address as string | null | undefined) ?? null;
    const known = live ?? ((_ctx?.services.account as unknown as { walletAddress?: string | null })?.walletAddress ?? null);
    const raw = live ? (onchainApi.balanceText?.() ?? _host.solShort ?? '').split(' (')[0].split(' · ')[0].replace(/^◎\s*/, '').replace(/\s*SOL(\s+in wallet)?$/i, '') : known ? '—' : 'Connect';
    // Before the balance is read the partial says "Tap to load balance" / "Not connected" — too long for a capsule.
    const t = !raw || /tap to load|not connected/i.test(raw) ? '—' : raw;
    return `<button class="v2-coin" data-a="profile-open" aria-label="SOL balance and wallet">${ico('sol', 1.9)}<b class="v2-num">${esc(t || '—')}</b><span class="v2-plus">${ico('plus', 0.8)}</span></button>`;
  }
  return `<button class="v2-coin" data-a="get-coins" aria-label="Coins, get more">${ico('coin', 1.9)}<b class="v2-num">${fmt(heldCoins ?? coins())}</b><span class="v2-plus">${ico('plus', 0.8)}</span></button>`;
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
  // Three columns with equal sides (Back | title | mode + coins), so the title sits on the screen's centre line. The
  // title is text only (no icons beside it).
  return `<div class="v2-top"><div class="v2-top-l"><button class="v2-back" data-a="${o.back ? 'go' : 'back'}"${o.back ? ` data-v="${o.back}"` : ''} aria-label="Back">${ico('back', 1.1)}<span class="v2-lbl">Back</span></button></div><h1 class="v2-title"><span class="v2-title-t">${title}</span></h1><div class="v2-top-r">${mode}${o.right ?? coinCap()}</div></div>`;
}

/** Runs an async action that returns an error string or null; shows the error in a v2 dialog. */
/**
 * Player-facing text for an error. Short, plain messages written for players pass through (they often say what to
 * do: "That name is taken."); anything that looks technical — network failures, HTTP status codes, exception names,
 * JSON, stack text, very long strings — becomes `fallback`. The raw text always goes to the console.
 */
export function friendlyError(err: unknown, fallback = 'Something went wrong. Check your connection and try again.'): string {
  const raw = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').trim();
  if (raw) console.warn('[ui2]', raw);
  const technical =
    !raw ||
    raw.length > 160 ||
    /failed to fetch|networkerror|load failed|fetch|xhr|http\s?\d{3}|\b[45]\d\d\b|status|exception|error:|typeerror|referenceerror|undefined|null|nan|\{|\}|\bat\s+\S+\s*\(|\.ts\b|\.js\b|rpc|0x[0-9a-f]{6,}/i.test(raw);
  return technical ? fallback : raw;
}

export async function run(op: () => Promise<string | null | undefined | void>, onOk?: () => void, title = 'Something went wrong'): Promise<void> {
  try {
    const err = await op();
    if (err) _ui.message(title, esc(friendlyError(err)));
    else onOk?.();
  } catch (e) {
    _ui.message(title, esc(friendlyError(e)));
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

/**
 * Where "Get Coins" should go right now. Demo can't sell Coins yet (every pack is "Coming soon"), so it sends players
 * to free Coins they can actually claim: the Daily spin when it's ready, else the Weekly reward when one is waiting.
 * The Shop's Coins tab only when it sells (On-chain), or as the last resort. `hint` is a sentence for dialog bodies.
 */
export function getCoinsRoute(): { label: string; go: () => void; hint: string } {
  if (!onchain() && canSpin(_ctx)) return { label: 'Spin for Coins', go: () => _ui.show('spin'), hint: "Today's Daily spin is ready: it pays up to 25,000 Coins." };
  if (!onchain() && canClaimLogin(_ctx)) return { label: 'Claim Coins', go: () => _ui.show('weekly'), hint: "Today's Weekly reward is waiting to be claimed." };
  if (!onchain()) return { label: 'Get Coins', go: () => _ui.show('weekly'), hint: 'Come back tomorrow for the Daily spin and your next Weekly reward, or play a lower stake.' };
  return { label: 'Get Coins', go: () => _ui.show('shop', 'coins'), hint: 'Get Coins in the Shop.' };
}

/** "Not enough Coins" in the v2 look, with a way to free Coins. Returns true when the player can't afford it. */
export function needCoins(min: number, what: string): boolean {
  if (onchain() || coins() >= min) return false;
  const route = getCoinsRoute();
  _ui.openDialog({
    title: 'Not enough Coins',
    body: `${esc(what)} needs ${fmt(min)} Coins. You have ${fmt(coins())}. ${esc(route.hint)}`,
    buttons: btn('Not now', 'nc-ok', { h: 'ghost' }) + btn(esc(route.label), 'nc-get', { h: 'green' }),
    actions: { 'nc-get': () => { _ui.closeDialog(); route.go(); }, 'nc-ok': () => _ui.closeDialog() },
  });
  return true;
}
