/**
 * On-chain play on NEAR, from the existing screens (no page of its own):
 *   - the top bar's NEAR capsule "+" and the profile panel: Deposit / Withdraw on the escrow game balance;
 *   - the lobby rooms: Sit Down buys in at that room's NEAR table (`nearSitAt`) and joins it;
 *   - Play with friends: host a table (open or invite-only), join one by its link, and the tables you host or joined.
 *
 * The escrow `nomad-escrow.testnet` holds every stake: a buy-in draws on the game balance first, then the wallet, and
 * the seat it locks is what the game server seats you with; leaving pays the stack back to the game balance. Moves go
 * through the player's NEAR wallet, or are signed here for an account made for you (no wallet).
 */
import { formatN0 } from '@nomad/engine';
import {
  DEFAULT_RAKE_BPS, HOUSE_TABLES, buyIn, buyInError, buyInPlan, chipsToYocto, closeTable, createHostedTable, deposit, getBalance, getConfig, getSeat,
  getTable, hostedTableLink, isHostedTableId, newHostedTableId, parseInvites, tableForId, withdraw, yoctoToChips,
  type EscrowConfig, type EscrowSeat, type EscrowTable, type HouseTable,
} from '../near/escrow';
import { formatNear, parseNear, wholeOf } from '../near/backing';
import { refreshNearBalance } from '../near/balance';
import { localAccount, nearAccount, nearSigner } from '../near/wallet';
import { btn, esc } from './core';
import { app, connectNear, friendlyError, nearAccountId, onchain, prompt, setMode, ui } from './ctx';
import type { V2 } from './core';

// ------------------------------------------------------------------ config and amounts

let config: EscrowConfig | null = null;
async function escrowConfig(): Promise<EscrowConfig | null> {
  config ??= await getConfig().catch(() => null);
  return config;
}
const rakeBps = (): number => config?.rake_bps ?? DEFAULT_RAKE_BPS;
const chipYocto = (): bigint | undefined => (config ? BigInt(config.chip_yocto) : undefined);
const nearOf = (chips: number): string => formatNear(chipsToYocto(chips, chipYocto()));

// ------------------------------------------------------------------ hosted tables this browser knows

const KNOWN_KEY = 'nomad.near.hostedTables';
const sessionHosted = new Set<string>();

function knownHosted(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isHostedTableId(x)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** Remembers a hosted table (one you made or opened a link to). False for an id that isn't one. */
export function rememberHostedTable(id: string): boolean {
  if (!isHostedTableId(id)) return false;
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify([id, ...knownHosted().filter((x) => x !== id)].slice(0, 20)));
  } catch {
    sessionHosted.add(id); // private mode: listed for this visit only
  }
  return true;
}

export function forgetHostedTable(id: string): void {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(knownHosted().filter((x) => x !== id)));
  } catch {
    /* nothing stored */
  }
  sessionHosted.delete(id);
}

/** The hosted tables you made or joined, with what NEAR says about each (for Play with friends). */
export const hostedTables = {
  list: [] as { t: HouseTable; table: EscrowTable | null; seat: EscrowSeat | null }[],
  loading: false,
  async load(): Promise<void> {
    this.loading = true;
    ui().render();
    try {
      await escrowConfig();
      const me = nearAccountId();
      const ids = [...new Set([...knownHosted(), ...sessionHosted])];
      const ts = ids.map(tableForId).filter((t): t is HouseTable => !!t);
      this.list = await Promise.all(
        ts.map(async (t) => ({ t, table: await getTable(t.id).catch(() => null), seat: me ? await getSeat(t.id, me).catch(() => null) : null })),
      );
    } finally {
      this.loading = false;
      ui().render();
    }
  },
};

// ------------------------------------------------------------------ wallet

const cancelled = (e: unknown): boolean => /cancel|reject|closed|denied/i.test(String((e as Error)?.message ?? e));

/** Ready to send from the NEAR account you're signed in with (asks for NEAR sign-in first). Null when not ready. */
async function readyAccount(): Promise<{ account: string; local: boolean } | null> {
  // From Demo: switch to On-chain first (it asks for NEAR sign-in when needed; backing out stays in Demo).
  if (!onchain()) {
    await setMode('chain');
    if (!onchain()) return null;
  }
  let account = nearAccountId();
  if (!account && (await connectNear())) account = nearAccountId();
  if (!account) return null;
  const local = await localAccount();
  if (local) return { account, local: true };
  const wallet = (await nearAccount()) ?? (await nearSigner.connect().catch(() => null));
  if (!wallet) return null;
  if (wallet !== account) {
    ui().message('Wrong NEAR wallet', `Your wallet is connected as <b>${esc(wallet)}</b>, but you play as <b>${esc(account)}</b>. Switch the wallet to ${esc(account)}, or sign in again with NEAR.`);
    return null;
  }
  return { account, local: false };
}

/** Sends one move with a short status, then refreshes the balance. True when it went through. */
async function send(local: boolean, pending: string, done: string, fn: () => Promise<void>): Promise<boolean> {
  ui().toast(local ? 'Sending to NEAR…' : pending, 4000);
  try {
    await fn();
    ui().toast(done, 2600);
    return true;
  } catch (e) {
    if (!cancelled(e)) ui().message('NEAR', esc(friendlyError(e, local ? "NEAR didn't take it. Try again." : "The wallet couldn't send it. Try again.")));
    return false;
  } finally {
    void refreshNearBalance(nearAccountId(), () => ui().render());
  }
}

// ------------------------------------------------------------------ balance

export async function nearDeposit(): Promise<void> {
  const r = await readyAccount();
  if (!r) return;
  prompt('Deposit NEAR', "Adds NEAR from your wallet to your game balance, for buying in. Withdraw what you don't use at any time.", 'Amount in NEAR, e.g. 0.5', '', 'Deposit', (v) => {
    let amount: bigint;
    try {
      amount = parseNear(v);
      if (amount <= 0n) throw new Error('Enter an amount above 0.');
    } catch (e) {
      return ui().message('Deposit NEAR', esc((e as Error).message));
    }
    void send(r.local, 'Confirm the deposit in your wallet…', `Deposited ${formatNear(amount)} NEAR.`, () => deposit(amount));
  }, 14);
}

export async function nearWithdraw(): Promise<void> {
  const r = await readyAccount();
  if (!r) return;
  const balance = await getBalance(r.account).catch(() => 0n);
  if (balance <= 0n) return ui().message('Withdraw NEAR', 'Your game balance is empty. Chips at a table come back to it when you leave the table.');
  prompt('Withdraw NEAR', `Sends NEAR from your game balance (${formatNear(balance)} NEAR) back to your wallet.`, 'Amount in NEAR', formatNear(balance), 'Withdraw', (v) => {
    let amount: bigint;
    try {
      amount = wholeOf(parseNear(v), balance);
      if (amount <= 0n) throw new Error('Enter an amount above 0.');
      if (amount > balance) throw new Error(`You have ${formatNear(balance)} NEAR to withdraw.`);
    } catch (e) {
      return ui().message('Withdraw NEAR', esc((e as Error).message));
    }
    void send(r.local, 'Confirm the withdrawal in your wallet…', `Withdrew ${formatNear(amount)} NEAR.`, () => withdraw(amount));
  }, 30);
}

// ------------------------------------------------------------------ sitting at a table

async function join(t: HouseTable, chips: number): Promise<void> {
  const net = app().services.net;
  if (!net?.joinNearTable) return ui().message('NEAR', 'This build has no game server connection.');
  ui().toast(`Joining ${t.name} with ${formatN0(chips)} chips…`, 3000);
  try {
    await net.joinNearTable(t.id, chips);
  } catch (e) {
    ui().message('NEAR', esc(friendlyError(e, "Couldn't join the table. Your NEAR stays locked at your seat: try again.")));
  }
}

/** The seat after a buy-in (the RPC may lag the transaction by a block or two). */
async function seatAfterBuyIn(tableId: string, account: string): Promise<EscrowSeat | null> {
  for (let i = 0; i < 6; i++) {
    const seat = await getSeat(tableId, account).catch(() => null);
    if (seat && BigInt(seat.locked) > 0n) return seat;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** Sit at a NEAR table: straight back in with a seat you already have, else buy in (balance first, then wallet). */
export async function nearSitAt(tableId: string): Promise<void> {
  const t = tableForId(tableId);
  if (!t) return;
  const r = await readyAccount();
  if (!r) return;
  await escrowConfig();
  const [table, seat, balance] = await Promise.all([getTable(t.id).catch(() => null), getSeat(t.id, r.account).catch(() => null), getBalance(r.account).catch(() => 0n)]);
  if (seat && BigInt(seat.locked) > 0n) return join(t, yoctoToChips(seat.locked, chipYocto()));
  const c = table?.config ?? t.config;
  if (!table) return ui().message(esc(t.name), isHostedTableId(t.id) ? "This table wasn't found on NEAR." : "This table isn't open on NEAR yet.");
  if (table.closed) return ui().message(esc(t.name), 'This table is closed.');
  const min = nearOf(c.min_buy_in);
  const max = nearOf(c.max_buy_in);
  const fromBalance = balance > 0n ? ` Paid from your game balance (${formatNear(balance)} NEAR) first.` : '';
  prompt(`Buy in: ${t.name}`, `Buy in with ${min} to ${max} NEAR. ${rakeBps() / 100}% house fee.${fromBalance}`, 'Amount in NEAR', min, 'Buy in & sit', (v) => {
    let chips: number;
    try {
      chips = yoctoToChips(parseNear(v), chipYocto());
    } catch {
      return ui().message(`Buy in: ${esc(t.name)}`, 'Enter an amount in NEAR, e.g. ' + esc(min) + '.');
    }
    if (chips < c.min_buy_in || chips > c.max_buy_in) return ui().message(`Buy in: ${esc(t.name)}`, `Buy in with ${esc(min)} to ${esc(max)} NEAR.`);
    const err = buyInError(String(chips), c, table, seat, chipYocto());
    if (err) return ui().message(`Buy in: ${esc(t.name)}`, esc(err));
    const plan = buyInPlan(chips, balance, rakeBps(), chipYocto());
    void (async () => {
      const ok = await send(r.local, plan.attach > 0n ? `Confirm the buy-in in your wallet (${formatNear(plan.attach)} NEAR from the wallet)…` : 'Confirm the buy-in in your wallet…', 'Bought in. Taking your seat…', () => buyIn(t.id, plan));
      if (!ok) return;
      const now = await seatAfterBuyIn(t.id, r.account);
      if (!now) return ui().message('NEAR', "The buy-in went through but NEAR hasn't shown your seat yet. Wait a moment, then sit again: you'll go straight in.");
      await join(t, yoctoToChips(now.locked, chipYocto()));
    })();
  }, 14);
}

// ------------------------------------------------------------------ hosted tables

/** Host a table: pick the stakes, optionally invite accounts, then the wallet creates it on the escrow. */
export async function nearHostTable(): Promise<void> {
  const r = await readyAccount();
  if (!r) return;
  await escrowConfig();
  const pick = (stake: number) => {
    ui().closeDialog();
    const t = tableForId(newHostedTableId(stake))!;
    prompt(`Host a table: ${t.name.replace('Hosted · ', '')}`,
      `Blinds ${nearOf(t.config.small_blind)} / ${nearOf(t.config.big_blind)} NEAR, buy-in ${nearOf(t.config.min_buy_in)}–${nearOf(t.config.max_buy_in)} NEAR, ${t.config.seats} seats. Invite NEAR accounts to make it invite-only (comma separated), or leave it empty for anyone with the link. Hosting costs nothing; the house takes ${rakeBps() / 100}% of each buy-in, as at house tables.`,
      'alice.testnet, bob.testnet (optional)', '', 'Create table',
      (v) => {
        let invites: string[] | null;
        try {
          invites = parseInvites(v);
        } catch (e) {
          return ui().message('Host a table', esc((e as Error).message));
        }
        void (async () => {
          if (await send(r.local, 'Confirm the new table in your wallet…', 'Your table is open.', () => createHostedTable(t, invites))) {
            rememberHostedTable(t.id);
            void hostedTables.load();
            shareHostedTable(t, invites);
          }
        })();
      }, 400);
  };
  const stakes = HOUSE_TABLES.map((h, i) => btn(`${esc(h.name)}<span class="v2-xs">blinds ${nearOf(h.config.small_blind)}/${nearOf(h.config.big_blind)} · buy-in ${nearOf(h.config.min_buy_in)}+</span>`, `host-st${i}`, { h: 'blue', c: 'v2-b-stack' })).join('');
  const actions: Record<string, () => void> = { 'host-cancel': () => ui().closeDialog() };
  HOUSE_TABLES.forEach((h, i) => (actions[`host-st${i}`] = () => pick(Number(/st(\d+)/.exec(h.id)![1]))));
  ui().openDialog({ title: 'Host a table', body: 'Pick the stakes. Players buy in from their own NEAR wallets; the escrow holds every stake.', buttons: `<div class="v2-btn-grid">${stakes}${btn('Cancel', 'host-cancel', { h: 'ghost' })}</div>`, actions });
}

/** Right after hosting: the invite link to copy, and a way to sit down. The table also stays under Your tables. */
function shareHostedTable(t: HouseTable, invites: string[] | null): void {
  const link = hostedTableLink(t.id);
  const who = invites?.length ? `Only ${invites.map(esc).join(', ')} can join (and you).` : 'Anyone with the link can join.';
  ui().openDialog({
    title: 'Your table is open',
    body: `<div class="v2-col" style="gap:.6em"><div>Send this link to your friends. ${who}</div><input class="v2-field" style="width:100%" readonly value="${esc(link)}"><div class="v2-xs v2-mut">You'll also find it under Your tables on Play with friends, with Close when you're done.</div></div>`,
    buttons: btn('Close', 'sh-close', { h: 'ghost' }) + btn('Sit down', 'sh-sit', { h: 'blue' }) + btn('Copy link', 'sh-copy', { h: 'gold' }),
    actions: {
      'sh-close': () => ui().closeDialog(),
      'sh-copy': () => void nearCopyLink(t.id),
      'sh-sit': () => {
        ui().closeDialog();
        void nearSitAt(t.id);
      },
    },
  });
}

/** A table's link or id, as typed into Join: the table id, or null. */
export function tableIdFrom(text: string): string | null {
  const t = text.trim();
  try {
    const id = new URL(t).searchParams.get('neartable');
    if (id && isHostedTableId(id)) return id;
  } catch {
    /* not a URL */
  }
  return isHostedTableId(t.toLowerCase()) ? t.toLowerCase() : null;
}

export async function nearCopyLink(id: string): Promise<void> {
  const link = hostedTableLink(id);
  try {
    await navigator.clipboard.writeText(link);
    ui().toast('Invite link copied');
  } catch {
    ui().message('Invite link', `<input class="v2-field" style="width:100%" readonly value="${esc(link)}">`);
  }
}

export async function nearCloseHosted(id: string): Promise<void> {
  const r = await readyAccount();
  if (!r) return;
  ui().message('Close your table?', 'No one can buy in after this. Players still seated keep playing and are paid out when they leave.', 'Close table', () => {
    void send(r.local, 'Confirm closing the table in your wallet…', 'Table closed.', () => closeTable(id)).then(() => hostedTables.load());
  }, 'Cancel', undefined, 'red');
}

// ------------------------------------------------------------------ boot

/** The top bar's NEAR capsule "+" and the profile panel's buttons, on every screen. */
export function installNearPlay(v2: V2): void {
  v2.globalActions['near-deposit'] = () => void nearDeposit();
  v2.globalActions['near-withdraw'] = () => void nearWithdraw();
}

/**
 * An invite link (`?neartable=<id>`): remember the table and, once the main menu is up (after any sign-in screen),
 * switch to On-chain and offer its buy-in. Called once at boot.
 */
export function openNearTableLink(params: URLSearchParams, v2: { readonly currentId: string | null }): void {
  const id = params.get('neartable');
  if (!id || !rememberHostedTable(id)) return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (v2.currentId === 'main') {
      clearInterval(timer);
      void nearSitAt(id);
    } else if (Date.now() - started > 120_000) clearInterval(timer);
  }, 400);
}
