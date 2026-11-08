/**
 * 'nomad-account' (overlay): sign in to the Nomad API and see the ledger balance. Guest, wallet and email link work
 * today; Google needs an OAuth client id first. The game's table coins still come from the local wallet until tables
 * run on the server (Phase 3): this panel shows the server ledger, which is what they will move to.
 */
import type { LedgerEntry } from '@nomad/contract';
import type { AppContext, Screen } from '../app/app';
import type { NomadSession, WalletSigner } from './session';

export interface AccountScreenDeps {
  session: NomadSession | null;
  /** Stage label shown in the header ('staging', 'local', or the host). */
  stage: string;
  wallet: () => WalletSigner | null;
}

const fmt = new Intl.NumberFormat('en-US');

export class AccountScreen implements Screen {
  readonly overlay = true;
  private root!: HTMLElement;
  private body!: HTMLElement;
  private off: (() => void) | null = null;
  private devLink: string | null = null;
  private entries: LedgerEntry[] = [];
  private loadedFor: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: AccountScreenDeps,
  ) {}

  mount(root: HTMLElement): void {
    injectStyle();
    this.root = root;
    root.classList.add('na-overlay');
    const dim = el('div', 'na-dim');
    dim.addEventListener('click', () => void this.ctx.router.back());
    const panel = el('div', 'na-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Nomad account');
    const head = el('div', 'na-head');
    head.append(el('h2', '', 'Nomad account'), el('span', 'na-stage', this.deps.stage));
    const close = el('button', 'na-close', '×') as HTMLButtonElement;
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => void this.ctx.router.back());
    head.append(close);
    this.body = el('div', 'na-body');
    panel.append(head, this.body);
    root.append(dim, panel);
    this.off = this.ctx.events.on('nomad:changed', () => this.render());
    this.render();
  }

  unmount(): void {
    this.off?.();
    this.root.replaceChildren();
    this.root.classList.remove('na-overlay');
  }

  private render(): void {
    const s = this.deps.session;
    const b = this.body;
    b.replaceChildren();
    if (!s) {
      b.append(el('p', 'na-note', 'No Nomad server is set for this build. Add ?api=staging to the address to use the staging API.'));
      return;
    }
    if (s.me) this.renderSignedIn(s);
    else this.renderSignedOut(s);
    if (s.busy) b.append(el('p', 'na-status', 'Working…'));
    if (s.error) b.append(el('p', 'na-error', s.error));
  }

  private renderSignedOut(s: NomadSession): void {
    const b = this.body;
    b.append(el('p', 'na-note', 'Sign in to keep your coins and progress on the server.'));
    b.append(this.button('Play as guest', () => s.guest(), 'na-primary'));
    b.append(this.walletButton(s, 'Sign in with wallet'));
    b.append(this.emailForm(s));
    const g = this.button('Sign in with Google', () => Promise.resolve());
    g.disabled = true;
    g.title = 'Needs a Google OAuth client id (not set up yet)';
    b.append(g, el('p', 'na-hint', 'Google sign-in is not set up yet.'));
  }

  private renderSignedIn(s: NomadSession): void {
    const me = s.me!;
    const b = this.body;
    const who = el('div', 'na-who');
    who.append(el('div', 'na-name', me.player.displayName), el('span', `na-kind na-${me.player.kind}`, me.player.kind === 'guest' ? 'Guest' : 'Signed in'));
    b.append(who);

    const bal = el('div', 'na-balances');
    bal.append(stat('Coins', me.balances.coins, true), stat('Gems', me.balances.gems), stat('XP', me.balances.xp));
    b.append(bal);

    if (me.identities.length) {
      const ids = el('ul', 'na-ids');
      for (const i of me.identities) ids.append(el('li', '', `${label(i.provider)}: ${short(i.label)}`));
      b.append(ids);
    }

    const hasWallet = me.identities.some((i) => i.provider === 'wallet');
    const hasEmail = me.identities.some((i) => i.provider === 'email');
    if (!hasWallet) b.append(this.walletButton(s, me.player.kind === 'guest' ? 'Save progress with a wallet' : 'Link a wallet'));
    if (!hasEmail) b.append(this.emailForm(s, me.player.kind === 'guest' ? 'Save progress with email' : 'Link an email'));

    b.append(el('h3', 'na-sub', 'Recent activity'));
    const list = el('ul', 'na-ledger');
    b.append(list);
    if (this.loadedFor !== me.player.id + ':' + me.balances.coins) {
      this.loadedFor = me.player.id + ':' + me.balances.coins;
      void s.ledger().then(
        (l) => {
          this.entries = l.entries.slice(0, 6);
          this.fillLedger(list);
        },
        () => list.replaceChildren(el('li', 'na-hint', 'Could not load activity.')),
      );
    } else this.fillLedger(list);

    const row = el('div', 'na-row');
    row.append(this.button('Refresh', () => s.refresh()), this.button('Sign out', () => s.signOut()));
    b.append(row);
  }

  private fillLedger(list: HTMLElement): void {
    list.replaceChildren();
    if (!this.entries.length) list.append(el('li', 'na-hint', 'No activity yet.'));
    for (const e of this.entries) {
      const li = el('li');
      li.append(el('span', '', reason(e.reason)), el('span', e.delta > 0 ? 'na-credit' : 'na-debit', `${e.delta > 0 ? '+' : ''}${fmt.format(e.delta)} ${e.currency === 'coins' ? '' : e.currency}`.trim()));
      list.append(li);
    }
  }

  private walletButton(s: NomadSession, text: string): HTMLButtonElement {
    const signer = this.deps.wallet();
    const btn = this.button(text, () => (signer ? s.wallet(signer) : Promise.resolve()));
    if (!signer) {
      btn.disabled = true;
      btn.title = 'The wallet module is not available in this build';
    }
    return btn;
  }

  private emailForm(s: NomadSession, text = 'Email me a sign-in link'): HTMLElement {
    const form = el('form', 'na-email') as HTMLFormElement;
    const input = el('input') as HTMLInputElement;
    input.type = 'email';
    input.required = true;
    input.placeholder = 'you@example.com';
    input.autocomplete = 'email';
    input.setAttribute('aria-label', 'Email address');
    const go = el('button', '', text) as HTMLButtonElement;
    go.type = 'submit';
    form.append(input, go);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void s.emailStart(input.value.trim()).then((r) => {
        this.devLink = r?.devLink ?? null;
        this.render();
      });
    });
    const wrap = el('div');
    wrap.append(form);
    if (this.devLink) {
      const link = this.devLink;
      const box = el('div', 'na-devlink');
      box.append(el('span', '', 'Staging sends no mail. Use the link here:'));
      box.append(
        this.button('Open sign-in link', async () => {
          this.devLink = null;
          const token = new URL(link).searchParams.get('emailToken');
          if (token) await s.emailVerify(token);
        }),
      );
      wrap.append(box);
    }
    return wrap;
  }

  private button(text: string, action: () => Promise<void>, cls = ''): HTMLButtonElement {
    const b = el('button', cls, text) as HTMLButtonElement;
    b.type = 'button';
    b.disabled = !!this.deps.session?.busy;
    b.addEventListener('click', () => void action());
    return b;
  }
}

function stat(name: string, value: number, big = false): HTMLElement {
  const d = el('div', big ? 'na-stat na-big' : 'na-stat');
  d.append(el('span', 'na-val', fmt.format(value)), el('span', 'na-lbl', name));
  return d;
}

const label = (p: string) => (p === 'wallet' ? 'Wallet' : p === 'google' ? 'Google' : 'Email');
const short = (s: string) => (s.length > 20 && !s.includes('@') ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const reason = (r: string) =>
  ({ starter: 'Welcome coins', 'table:buy_in': 'Table buy-in', 'table:cash_out': 'Table cash-out', 'reward:login': 'Daily reward' })[r] ?? r;

function el(tag: string, cls = '', text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
.na-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;pointer-events:auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.na-dim{position:absolute;inset:0;background:rgba(6,10,18,.62)}
.na-panel{position:relative;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;background:#141b2b;color:#eef2fa;border:1px solid #2c3958;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5)}
.na-head{display:flex;align-items:center;gap:10px;padding:16px 18px 10px;border-bottom:1px solid #222d46}
.na-head h2{margin:0;font-size:19px;font-weight:650;flex:1}
.na-stage{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#f7c75b;border:1px solid #6b5520;border-radius:999px;padding:2px 8px}
.na-close{background:none;border:0;color:#9aa6c2;font-size:24px;line-height:1;cursor:pointer;padding:2px 6px}
.na-body{padding:14px 18px 18px;display:flex;flex-direction:column;gap:10px}
.na-body button{min-height:44px;border-radius:10px;border:1px solid #34446a;background:#1d2840;color:#eef2fa;font:inherit;font-size:15px;cursor:pointer;padding:0 14px}
.na-body button:hover:not(:disabled){background:#25324f}
.na-body button:disabled{opacity:.5;cursor:default}
.na-body button.na-primary{background:#2f6df0;border-color:#2f6df0}
.na-body button.na-primary:hover:not(:disabled){background:#3d7bff}
.na-note,.na-hint,.na-status{margin:0;color:#aab4cc;font-size:14px;line-height:1.4}
.na-hint{font-size:12.5px}
.na-error{margin:0;color:#ff8f8f;font-size:14px}
.na-email{display:flex;gap:8px}
.na-email input{flex:1;min-width:0;min-height:44px;border-radius:10px;border:1px solid #34446a;background:#0e1422;color:#eef2fa;font:inherit;font-size:15px;padding:0 12px}
.na-devlink{margin-top:8px;display:flex;flex-direction:column;gap:6px;font-size:13px;color:#f7c75b}
.na-who{display:flex;align-items:center;gap:10px}
.na-name{font-size:18px;font-weight:650}
.na-kind{font-size:11px;border-radius:999px;padding:2px 8px;text-transform:uppercase;letter-spacing:.05em}
.na-guest{background:#3a2f12;color:#f7c75b}.na-registered{background:#12351f;color:#6fe39a}
.na-balances{display:flex;gap:8px}
.na-stat{flex:1;background:#0e1422;border:1px solid #222d46;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:2px}
.na-big{flex:1.6}
.na-val{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
.na-big .na-val{font-size:24px;color:#ffd770}
.na-lbl{font-size:12px;color:#8f9bb8}
.na-ids{margin:0;padding:0;list-style:none;font-size:13px;color:#aab4cc;display:flex;flex-direction:column;gap:2px}
.na-sub{margin:6px 0 0;font-size:13px;font-weight:600;color:#8f9bb8;text-transform:uppercase;letter-spacing:.05em}
.na-ledger{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:14px}
.na-ledger li{display:flex;justify-content:space-between;gap:10px}
.na-credit{color:#6fe39a;font-variant-numeric:tabular-nums}.na-debit{color:#ff8f8f;font-variant-numeric:tabular-nums}
.na-row{display:flex;gap:8px}.na-row button{flex:1}
`;
  document.head.append(s);
}
