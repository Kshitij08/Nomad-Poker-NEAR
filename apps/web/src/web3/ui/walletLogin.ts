/**
 * 'wallet-login': Auth/WalletLoginUI.cs — the runtime-built login + voluntary email panel (BuildRuntimeUI: a 480×280
 * panel "Poker Login" with status / wallet lines and Login with Wallet / Logout; a 480×300 "Get tournament updates"
 * email panel with input, marketing toggle, Save / Skip). Colours and sizes are the C#'s, on the 1920×1080 reference.
 * The menu's own Wallet_Connect chrome is the Nomad menu's (second wave: NomadUiHost.Onchain); this is the panel the
 * Unity build shows where no login button is wired. Restores a saved session only when the player opens it.
 */
import type { AppContext, Screen } from '../../app/app';
import { shortKey } from '../lib/bytes';
import { PokerClientIdentity } from '../solana/identity';
import { w3 } from '../services';

const css = (r: number, g: number, b: number, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
let restoreAttempted = false;

export class WalletLoginScreen implements Screen {
  readonly overlay = true;
  private root!: HTMLElement;
  private busy = false;
  private status!: HTMLElement;
  private walletLine!: HTMLElement;
  private loginBtn!: HTMLButtonElement;
  private logoutBtn!: HTMLButtonElement;
  private emailPanel!: HTMLElement;
  private emailInput!: HTMLInputElement;
  private toggle!: HTMLInputElement;
  private saveBtn!: HTMLButtonElement;
  private skipBtn!: HTMLButtonElement;
  private off: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  mount(root: HTMLElement): void {
    this.root = root;
    root.classList.add('w3-overlay');
    injectStyle();
    const dim = el('div', 'w3-dim');
    dim.addEventListener('click', () => this.ctx.router.back());
    const login = panel(480, 280);
    login.append(text('Poker Login', 30, true));
    this.status = text('', 20);
    this.walletLine = text('Wallet: —', 18);
    this.loginBtn = btn('Login with Wallet', css(0.2, 0.45, 0.85), () => void this.login());
    this.logoutBtn = btn('Logout', css(0.2, 0.45, 0.85), () => void this.logout());
    login.append(this.status, this.walletLine, this.loginBtn, this.logoutBtn);

    this.emailPanel = panel(480, 300);
    this.emailPanel.append(text('Get tournament updates', 26, true), text('Optional — add your email so we can reach you.', 18));
    this.emailInput = el('input', 'w3-input') as HTMLInputElement;
    this.emailInput.type = 'email';
    this.emailInput.placeholder = 'you@example.com';
    const toggleRow = el('label', 'w3-toggle');
    this.toggle = el('input') as HTMLInputElement;
    this.toggle.type = 'checkbox';
    this.toggle.checked = true;
    toggleRow.append(this.toggle, document.createTextNode('Email me about games & tournaments'));
    const row = el('div', 'w3-row');
    this.saveBtn = btn('Save', css(0.2, 0.45, 0.85), () => void this.saveEmail());
    this.skipBtn = btn('Skip', css(0.35, 0.35, 0.4), () => this.skipEmail());
    row.append(this.saveBtn, this.skipBtn);
    this.emailPanel.append(this.emailInput, toggleRow, row);
    this.emailPanel.hidden = true;

    root.append(dim, login, this.emailPanel);
    this.off = this.ctx.events.on('web3:wallet-changed', () => this.refresh());
    this.refresh();
    void this.restore();
  }

  unmount(): void {
    this.off?.();
    this.root.replaceChildren();
  }

  private get solana() {
    return w3(this.ctx).solana;
  }

  private setStatus(s: string): void {
    this.status.textContent = s;
  }

  private setButtons(on: boolean): void {
    for (const b of [this.loginBtn, this.logoutBtn, this.saveBtn, this.skipBtn]) b.disabled = !on;
  }

  private async login(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setButtons(false);
    this.setStatus('Connecting wallet...');
    try {
      const r = await this.solana.auth.login(PokerClientIdentity.playerName);
      if (!r.ok) return this.setStatus(r.error ?? 'Login failed.');
      this.setStatus('Signed in.');
      if (!r.email && !PokerClientIdentity.emailPromptDismissed) this.emailPanel.hidden = false;
    } finally {
      this.busy = false;
      this.setButtons(true);
      this.refresh();
    }
  }

  /** Once per page: brings back a saved session (silent wallet reconnect + /api/me). */
  private async restore(): Promise<void> {
    const cap = this.solana.capability;
    if (!cap.menuWeb3Enabled || restoreAttempted || this.busy) return;
    if (!PokerClientIdentity.isLoggedIn || this.solana.isConnected || !w3(this.ctx).web3Config.gameBackendUrl) return;
    restoreAttempted = true;
    this.busy = true;
    this.setButtons(false);
    this.setStatus('Restoring session...');
    try {
      const r = await this.solana.auth.restoreSession();
      if (!r.ok) return this.setStatus(PokerClientIdentity.isLoggedIn ? 'Session found — reconnect your wallet.' : 'Not signed in.');
      this.setStatus('Signed in.');
    } finally {
      this.busy = false;
      this.setButtons(true);
      this.refresh();
    }
  }

  private async logout(): Promise<void> {
    await this.solana.auth.logout();
    PokerClientIdentity.emailPromptDismissed = false;
    this.setStatus('Logged out.');
    this.refresh();
  }

  private async saveEmail(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setButtons(false);
    const email = this.emailInput.value.trim();
    try {
      const r = await this.solana.auth.saveEmail(email, this.toggle.checked);
      if (!r.ok) return this.setStatus(r.error ?? 'Could not save email.');
      PokerClientIdentity.emailPromptDismissed = true;
      this.emailPanel.hidden = true;
      this.setStatus(email ? 'Email saved. Thanks!' : 'Email cleared.');
      this.refresh();
    } finally {
      this.busy = false;
      this.setButtons(true);
    }
  }

  private skipEmail(): void {
    PokerClientIdentity.emailPromptDismissed = true;
    this.emailPanel.hidden = true;
    this.setStatus('Email skipped. You can add it later.');
    this.refresh();
  }

  /** WalletLoginUI.Refresh for the runtime panel (the button doesn't hold the wallet label). */
  private refresh(): void {
    const session = PokerClientIdentity.isLoggedIn;
    const loggedIn = session && this.solana.isConnected;
    const web3Live = this.solana.capability.menuWeb3Enabled;
    this.loginBtn.hidden = !(web3Live && !loggedIn);
    this.logoutBtn.hidden = !loggedIn;
    this.walletLine.textContent = loggedIn ? `Wallet: ${truncate(PokerClientIdentity.walletPubkey)}` : 'Wallet: —';
    if (!this.emailPanel.hidden && !session) this.emailPanel.hidden = true;
    if (!this.busy && !this.status.textContent)
      this.setStatus(loggedIn ? 'Signed in.' : session ? 'Session found — reconnect your wallet.' : 'Not signed in.');
  }
}

/** WalletLoginUI.Truncate: "AbCd...WxYz". */
export const truncate = (a: string): string => (!a || a.length <= 12 ? a || '—' : shortKey(a, 4, 4, '...'));

function el(tag: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function panel(w: number, h: number): HTMLElement {
  const p = el('div', 'w3-panel');
  p.style.setProperty('--w', String(w));
  p.style.setProperty('--h', String(h));
  return p;
}
function text(s: string, size: number, bold = false): HTMLElement {
  const t = el('div', 'w3-text');
  t.textContent = s;
  t.style.setProperty('--fs', String(size));
  if (bold) t.style.fontWeight = '700';
  return t;
}
function btn(label: string, bg: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'w3-btn') as HTMLButtonElement;
  b.textContent = label;
  b.style.background = bg;
  b.addEventListener('click', onClick);
  return b;
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  // 1920×1080 reference scaled to the viewport (CanvasScaler ScaleWithScreenSize, match 0).
  s.textContent = `
.w3-overlay{position:absolute;inset:0;display:grid;place-items:center;--u:min(calc(100vw/1920),calc(100vh/1080));font-family:inherit}
.w3-dim{position:absolute;inset:0;background:rgba(0,0,0,.35)}
.w3-panel{position:absolute;box-sizing:border-box;width:calc(var(--w)*var(--u));min-height:calc(var(--h)*var(--u));padding:calc(28*var(--u));display:flex;flex-direction:column;justify-content:center;gap:calc(12*var(--u));background:${css(0.12, 0.14, 0.18, 0.92)};color:#fff}
.w3-panel[hidden]{display:none}
.w3-text{font-size:calc(var(--fs)*var(--u));text-align:center;min-height:calc((var(--fs) + 18)*var(--u));display:flex;align-items:center;justify-content:center}
.w3-btn{height:calc(52*var(--u));border:0;color:#fff;font:inherit;font-size:calc(20*var(--u));cursor:pointer;flex:1}
.w3-btn:disabled{opacity:.6;cursor:default}.w3-btn[hidden]{display:none}
.w3-input{height:calc(48*var(--u));background:${css(0.08, 0.09, 0.12)};border:0;color:#fff;padding:0 calc(12*var(--u));font:inherit;font-size:calc(20*var(--u))}
.w3-toggle{display:flex;align-items:center;gap:calc(10*var(--u));font-size:calc(16*var(--u))}
.w3-toggle input{width:calc(28*var(--u));height:calc(28*var(--u));accent-color:${css(0.3, 0.85, 0.45)}}
.w3-row{display:flex;gap:calc(12*var(--u));height:calc(56*var(--u))}
`;
  document.head.append(s);
}
