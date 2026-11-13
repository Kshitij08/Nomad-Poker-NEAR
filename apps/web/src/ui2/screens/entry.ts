/**
 * Entry surfaces in v2 (docs/ui-style-guide.md): Login / Account ('login', replaces Unity 'Login'), email sign-in,
 * Daily Spin ('spin', replaces 'LuckySlot_Win' / 'LuckySlot_Lost'), the level-up celebration (router 'level-up'),
 * the connecting cover (host.showConnecting), the friend-invite toast and the tournament-ready banner.
 */
import type { AppContext, Screen } from '../../app/app';
import { RewardKind, type RewardGrant } from '../../app/services';
import type { NomadHost } from '../../menu/host';
import { LevelRewardCatalog } from '@nomad/engine/retention';
import { inviteToastView } from '../../economy/ui/friendsHud';
import { btn, esc, fmt, act, type V2 } from '../core';
import { ico, coinStack } from '../icons';
import { ui, host, app, S, accountExtras, signedIn, topBar, playerName } from '../ctx';
import type { ScreenDef } from '../install';
import './entry.css';

// ------------------------------------------------------------------ Login / Account

/** Google's multicolour "G" mark (SVG, on a white disc). */
const GOOGLE_G = `<span class="v2-g" aria-hidden="true"><svg viewBox="0 0 48 48" width="1em" height="1em"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg></span>`;

const login: ScreenDef & { sending: boolean } = {
  id: 'login',
  replaces: ['Login'],
  bare: true,
  sending: false,
  // Nothing to go back to before signing in.
  backFirst: () => true,
  render() {
    const a = accountExtras(app());
    const inn = signedIn();
    const busy = !!a.busy || this.sending;
    const err = !busy && a.lastError ? a.lastError : '';
    const status = busy ? 'Signing in…' : err ? err : inn ? `Signed in as ${playerName()}` : 'Save your progress and play on any device.';
    const keep = a.keepSignedIn ?? true;
    return `<div class="v2-login" role="main">
  <div class="v2-login-logo" aria-label="Nomad Poker">NOMAD<span>POKER</span></div>
  <div class="v2-login-card">
    <div class="v2-login-status${err ? ' err' : ''}" role="status">${esc(status)}</div>
    ${inn
      ? btn('Continue', 'lg-continue', { h: 'gold', c: 'lg' })
      : btn('Play as Guest', 'lg-guest', { h: 'gold', c: 'lg', dis: busy })}
    ${!inn ? `<div class="v2-login-or">or sign in</div>
    ${a.signInWithGoogle ? btn(`${GOOGLE_G} Continue with Google`, 'lg-google', { h: 'blue', dis: busy }) : ''}
    ${btn('Sign in with email', 'lg-email', { h: 'ghost', dis: busy })}` : ''}
    <button class="v2-switch${keep ? ' on' : ''}" role="switch" aria-checked="${keep}"${act('lg-keep')}><i></i>Keep me signed in on this device</button>
  </div>
</div>`;
  },
  actions: {
    'lg-continue': () => host().show('MainMenu'),
    'lg-guest': () => {
      const a = accountExtras(app());
      if (signedIn()) return host().show('MainMenu');
      void a.signInAsGuest?.();
    },
    'lg-google': () => {
      const a = accountExtras(app());
      if (a.signInWithGoogle) void a.signInWithGoogle();
      else ui().message('Google sign-in', "Google sign-in isn't available in this version. Play as Guest instead.");
    },
    'lg-email': () => emailSignIn(),
    'lg-keep': () => {
      const a = accountExtras(app());
      a.setKeepSignedIn?.(!(a.keepSignedIn ?? true));
    },
  },
};

function emailSignIn(value = ''): void {
  ui().openDialog({
    title: 'Sign in with email',
    body: `<div style="margin-bottom:.7em">We email you a one-time sign-in link. No password needed.</div><input class="v2-field" style="width:100%" id="v2-email" data-dlg-in="1" type="email" inputmode="email" autocomplete="email" maxlength="120" value="${esc(value)}" placeholder="name@example.com" spellcheck="false">`,
    buttons: btn('Cancel', 'p-cancel', { h: 'ghost' }) + btn('Send link', 'p-ok', { h: 'gold' }),
    actions: {
      'p-cancel': () => ui().closeDialog(),
      'p-ok': () => {
        const email = ((document.getElementById('v2-email') as HTMLInputElement | null)?.value ?? '').trim();
        ui().closeDialog();
        sendLink(email);
      },
    },
  });
}

function sendLink(email: string): void {
  const a = accountExtras(app());
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ui().message('Sign in with email', 'That email address doesn’t look right. Check it and try again.', 'Try again', () => emailSignIn(email));
    return;
  }
  if (!a.signInWithEmail) {
    ui().message('Sign in with email', "Email sign-in isn't available in this version. Play as Guest instead.");
    return;
  }
  login.sending = true;
  ui().render();
  void a.signInWithEmail(email, '').then(
    (error) => {
      login.sending = false;
      if (error) ui().message('Sign in with email', esc(error));
      else if (!signedIn()) ui().message('Check your email', `We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device to continue.`);
      ui().render();
    },
    (e: unknown) => {
      login.sending = false;
      ui().message('Sign in with email', esc(e instanceof Error ? e.message : String(e)));
      ui().render();
    },
  );
}

// ------------------------------------------------------------------ Daily Spin

const SYMBOLS = ['coin', 'xp', 'cards', 'bolt'];
const symbol = (n: string, s = 4.6) => (n === 'coin' ? coinStack(2, s * 0.8) : ico(n, s));

/** Time until the next UTC day (when the daily spin resets), minute precision. */
function untilNextUtcDay(): string {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const mins = Math.max(1, Math.ceil((next - now.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const spin: ScreenDef & { state: 'idle' | 'spinning' | 'won' | 'miss'; prize: number; faces: string[]; message: string } = {
  id: 'spin',
  replaces: ['LuckySlot_Win', 'LuckySlot_Lost'],
  state: 'idle',
  prize: 0,
  faces: ['coin', 'xp', 'cards'],
  message: '',
  open() {
    if (this.state === 'spinning') return;
    this.state = 'idle';
    this.message = '';
  },
  render() {
    const r = S('retention');
    const can = !!r?.engagement?.canSpin?.();
    const reels = this.faces
      .map((f, i) => `<div class="v2-reel">${this.state === 'spinning'
        ? `<div class="v2-reel-strip">${[...SYMBOLS, ...SYMBOLS].map((s) => `<span>${symbol(s)}</span>`).join('')}</div>`
        : `<div class="v2-reel-face${this.state === 'won' || this.state === 'miss' ? ' land' : ''}" style="animation-delay:${i * 0.12}s">${symbol(f)}</div>`}</div>`)
      .join('');
    const result = this.state === 'won'
      ? `<div class="v2-spin-result" role="status">You won ${fmt(this.prize)} Coins</div>`
      : this.state === 'miss'
        ? `<div class="v2-spin-result miss" role="status">${esc(this.message || 'No prize this time.')}</div>`
        : `<div class="v2-spin-result miss">${this.state === 'spinning' ? 'Spinning…' : can ? 'Your free spin is ready' : `Next free spin in ${untilNextUtcDay()}`}</div>`;
    const cta = this.state === 'spinning'
      ? btn('Spinning…', 'sp-none', { h: 'gold', c: 'lg', dis: true })
      : can
        ? btn('Spin', 'sp-spin', { h: 'gold', c: 'lg' })
        : btn('Back to menu', 'go', { h: 'ghost', v: 'main' });
    return topBar('Daily Spin', { toggle: false }) + `<div class="v2-body v2-spin-body">
  <div class="v2-spin-card">
    <div class="v2-spin-machine">
      <div class="v2-spin-reels" aria-hidden="true">${reels}</div>
      ${result}
    </div>
    ${cta}
    <div class="v2-spin-note v2-sm">${esc(r?.spinNote?.() ?? 'One free spin a day.')}</div>
  </div>
</div>`;
  },
  actions: {
    'sp-spin': () => doSpin(),
  },
};

async function doSpin(): Promise<void> {
  const r = S('retention');
  if (!signedIn()) return host().show('Login');
  if (!r || spin.state === 'spinning') return;
  if (!r.engagement.canSpin()) {
    ui().message('Daily Spin', "You've had today's spin. Come back tomorrow for another.");
    return;
  }
  spin.state = 'spinning';
  ui().render(true);
  const started = performance.now();
  let result: { awarded: boolean; prize: { coins: number }; error?: string | null } | null = null;
  try {
    result = await r.engagement.spin();
  } catch (e) {
    result = { awarded: false, prize: { coins: 0 }, error: e instanceof Error ? e.message : String(e) };
  }
  // Let the reels run for a moment before they land.
  const wait = Math.max(0, 1400 - (performance.now() - started));
  await new Promise((res) => setTimeout(res, wait));
  if (result?.awarded) {
    spin.state = 'won';
    spin.prize = result.prize.coins;
    spin.faces = ['coin', 'coin', 'coin'];
  } else {
    spin.state = 'miss';
    spin.message = result?.error || 'No spin left today. Come back tomorrow.';
    spin.faces = ['xp', 'coin', 'cards'];
  }
  if (ui().currentId === 'spin') ui().render(true);
  host().refreshSoon();
}

// ------------------------------------------------------------------ level-up (router overlay)

const kindIcon = (k: RewardKind): string =>
  k === RewardKind.Coins ? coinStack(2, 2.4) : k === RewardKind.Xp ? ico('xp', 2.6) : k === RewardKind.StreakToken ? ico('shield', 2.6) : k === RewardKind.Gems ? ico('hex', 2.6) : ico('crown', 2.4, 'color:var(--v2-gold)');

function rewardText(g: RewardGrant): string {
  switch (g.kind) {
    case RewardKind.Coins: return `${fmt(g.amount)} Coins`;
    case RewardKind.Gems: return `${fmt(g.amount)} Gems`;
    case RewardKind.Xp: return `${fmt(g.amount)} XP`;
    case RewardKind.Cosmetic: return 'New frame';
    case RewardKind.StreakToken: return `${g.amount} Streak Shield${g.amount === 1 ? '' : 's'}`;
    default: return `×${g.amount}`;
  }
}

class LevelUpOverlay implements Screen {
  readonly overlay = true;
  private el: HTMLElement | null = null;
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      this.next();
    }
  };
  constructor(private readonly ctx: AppContext) {}

  mount(root: HTMLElement, params?: unknown): void {
    const svc = this.ctx.services.retention;
    if (svc) svc.levelUps.showing = true;
    this.el = document.createElement('div');
    this.el.className = 'v2 v2-lvup';
    root.append(this.el);
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-a="lv-next"]')) this.next();
    });
    document.addEventListener('keydown', this.onKey);
    const p = (params ?? {}) as { level?: number };
    this.play(Number(p.level ?? svc?.progression.level ?? 2) || 2);
  }

  private play(level: number): void {
    if (!this.el) return;
    let rewards: RewardGrant[] = [];
    try {
      rewards = LevelRewardCatalog.rewardsForLevel(level) as RewardGrant[];
    } catch {
      rewards = [];
    }
    this.el.innerHTML = `<div class="v2-lvup-card" role="dialog" aria-modal="true" aria-label="Level up">
  <div class="v2-lvup-badge">${ico('hex', 8)}<b>${level}</b></div>
  <div class="v2-lvup-title">Level up!</div>
  <div class="v2-mut">You reached level ${level}.${rewards.length ? ' Your rewards are in your balance.' : ''}</div>
  ${rewards.length ? `<div class="v2-lvup-rewards">${rewards.map((g) => `<div class="v2-lvup-tile">${kindIcon(g.kind)}<b>${esc(rewardText(g))}</b></div>`).join('')}</div>` : ''}
  <button class="v2-b gold lg" data-a="lv-next">Continue</button>
</div>`;
    (this.el.querySelector('[data-a="lv-next"]') as HTMLElement | null)?.focus();
  }

  private next(): void {
    const n = this.ctx.services.retention?.levelUps.next() ?? null;
    if (n !== null) return this.play(n);
    if (this.ctx.router.current === 'level-up') this.ctx.router.back();
  }

  unmount(): void {
    const svc = this.ctx.services.retention;
    if (svc) svc.levelUps.showing = false;
    document.removeEventListener('keydown', this.onKey);
    this.el?.remove();
    this.el = null;
  }
}

// ------------------------------------------------------------------ connecting cover

function installConnecting(h: NomadHost): void {
  let cover: HTMLElement | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  const close = (): void => {
    cover?.remove();
    cover = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
  };
  h.showConnecting = (onDisconnect: () => void) => {
    close();
    const el = document.createElement('div');
    el.className = 'v2 v2-cover';
    el.innerHTML = `<div class="v2-bg"></div><div class="v2-cover-card" role="status" aria-live="polite"><i class="v2-spin" aria-hidden="true"></i><div class="v2-dh">Finding a table…</div><div class="v2-mut">Looking for an open seat. This can take a moment.</div><button class="v2-b ghost">Cancel</button></div>`;
    const cancel = (): void => {
      close();
      onDisconnect();
    };
    el.querySelector('button')!.addEventListener('click', cancel);
    // Escape acts like Cancel (captured so the menu's own Escape handling doesn't also run).
    onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(el);
    cover = el;
    (el.querySelector('button') as HTMLElement).focus();
  };
  h.closeConnecting = close;
}

// ------------------------------------------------------------------ toasts / banners

function notesLayer(): HTMLElement {
  let el = document.querySelector<HTMLElement>('.v2-notes');
  if (!el) {
    el = document.createElement('div');
    el.className = 'v2 v2-notes';
    document.body.append(el);
  }
  return el;
}

function setNote(id: string, html: string | null, wire?: (el: HTMLElement) => void): void {
  const layer = notesLayer();
  let el = layer.querySelector<HTMLElement>(`[data-note="${id}"]`);
  if (!html) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.dataset.note = id;
    layer.append(el);
  }
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
  wire?.(el);
}

function installInviteToast(): void {
  inviteToastView.render = (inv, join, decline) => {
    setNote('invite', inv ? `<div class="v2-note" role="alert">${ico('friends', 2.2)}<div class="v2-note-txt"><b>${esc(inv.title)}</b><small>${esc(inv.detail)}</small></div>${btn('Join', 'n-join', { h: 'gold', c: 'sm' })}${btn('Decline', 'n-decline', { h: 'ghost', c: 'sm' })}</div>` : null, (el) => {
      el.querySelector('[data-a="n-join"]')?.addEventListener('click', join);
      el.querySelector('[data-a="n-decline"]')?.addEventListener('click', decline);
    });
  };
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function installTournamentBanner(ctx: AppContext): void {
  const paint = (): void => {
    const svc = S('tournaments');
    const ready = svc?.ready as { id: string; name: string; startsAtUnix: number } | null | undefined;
    const show = !!ready && ready.id !== svc.bannerDismissedId && !svc.isJoining && ctx.router.current !== 'table';
    if (!show || !ready) return setNote('tourney', null);
    const left = ready.startsAtUnix - Number(svc.api?.serverNowUnix ?? Date.now() / 1000);
    const text = left > 0 ? `Starts in ${clock(left)}. Your table is ready.` : "It's started. Join now so you don't get blinded off.";
    setNote('tourney', `<div class="v2-note gold" role="alert">${ico('trophy', 2.2)}<div class="v2-note-txt"><b>${esc(ready.name)}</b><small>${esc(text)}</small></div>${btn('Join', 'n-tjoin', { h: 'gold', c: 'sm' })}${btn('Later', 'n-tlater', { h: 'ghost', c: 'sm' })}</div>`, (el) => {
      el.querySelector('[data-a="n-tjoin"]')?.addEventListener('click', () => {
        setNote('tourney', null);
        void Promise.resolve(svc.join(ready)).then((err: unknown) => {
          if (typeof err === 'string' && err) ui().message('Tournament', esc(err));
        });
      });
      el.querySelector('[data-a="n-tlater"]')?.addEventListener('click', () => {
        svc.bannerDismissedId = ready.id;
        setNote('tourney', null);
      });
    });
  };
  ctx.events.on('tournaments:ready', paint);
  ctx.events.on('router:changed', paint);
  window.setInterval(paint, 1000);
}

// ------------------------------------------------------------------ exports

export function entryScreens(): ScreenDef[] {
  return [login, spin];
}

/** Hooks that need the app (connecting cover, level-up, invite toasts, tournament banner). */
export function installEntryOverlays(ctx: AppContext, h: NomadHost, _ui: V2): void {
  // The Daily Spin opens the v2 screen (retention's partial pointed it at the Unity slot machine).
  h.actions.openDailySpin = () => {
    if (!h.signedIn) return h.show('Login');
    h.show('LuckySlot_Win');
  };
  ctx.router.register('level-up', (c) => new LevelUpOverlay(c));
  installConnecting(h);
  installInviteToast();
  installTournamentBanner(ctx);
}
