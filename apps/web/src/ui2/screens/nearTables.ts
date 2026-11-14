/**
 * Lobby › Play for NEAR: human money tables on NEAR testnet. Your escrow game balance (Deposit / Withdraw) and the three
 * house tables; "Buy in & sit" sends `buy_in` from your wallet (drawing on the game balance first), reads the seat the
 * escrow locked for you and joins the game server room of the same name with exactly those chips. A seat you already
 * have (coming back to a table) sits straight away with its locked chips. Leaving the table cashes the stack out to
 * your game balance (the game server does it as the escrow's operator).
 *
 * Needs NEAR sign-in (the game server seats the NEAR account you're signed in with) and a NEAR wallet for the
 * transactions; both are the same account.
 */
import { formatN0 } from '@nomad/engine';
import {
  ESCROW_CONTRACT, DEFAULT_RAKE_BPS, HOUSE_TABLES, buyIn, buyInError, buyInPlan, chipsToYocto, deposit, getBalance, getConfig, getSeat, getTable,
  withdraw, yoctoToChips, type EscrowConfig, type EscrowSeat, type EscrowTable, type HouseTable,
} from '../../near/escrow';
import { NEAR_EXPLORER, formatNear, parseNear } from '../../near/backing';
import { nearAccount, nearSigner } from '../../near/wallet';
import { btn, esc } from '../core';
import { ico } from '../icons';
import { app, friendlyError, prompt, S, topBar, ui } from '../ctx';
import type { ScreenDef } from '../install';

const state = {
  loading: false,
  error: '',
  /** The NEAR account you're signed in to Nomad with (the game server seats this one). */
  account: null as string | null,
  /** The account the NEAR wallet is connected as (transactions come from it). */
  wallet: null as string | null,
  balance: 0n,
  config: null as EscrowConfig | null,
  tables: new Map<string, EscrowTable | null>(),
  seats: new Map<string, EscrowSeat | null>(),
  note: '',
};

/** Your Nomad account's linked NEAR account, or null (not signed in with NEAR). */
function nearIdentity(): string | null {
  const me = S('nomadApi')?.me as { identities?: { provider: string; label: string }[] } | null | undefined;
  return me?.identities?.find((i) => i.provider === 'near')?.label ?? null;
}

const rakeBps = (): number => state.config?.rake_bps ?? DEFAULT_RAKE_BPS;
const chipYocto = (): bigint | undefined => (state.config ? BigInt(state.config.chip_yocto) : undefined);
const near = (chips: number): string => formatNear(chipsToYocto(chips, chipYocto()));

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  ui().render();
  try {
    state.account = nearIdentity();
    state.wallet = await nearAccount();
    const me = state.account;
    const [config, tables, balance, seats] = await Promise.all([
      getConfig().catch(() => null),
      Promise.all(HOUSE_TABLES.map((t) => getTable(t.id))),
      me ? getBalance(me) : Promise.resolve(0n),
      me ? Promise.all(HOUSE_TABLES.map((t) => getSeat(t.id, me))) : Promise.resolve(HOUSE_TABLES.map(() => null)),
    ]);
    state.config = config;
    state.balance = balance;
    HOUSE_TABLES.forEach((t, i) => {
      state.tables.set(t.id, tables[i] ?? null);
      state.seats.set(t.id, seats[i] ?? null);
    });
  } catch (e) {
    state.error = /does not exist|CodeDoesNotExist|MethodNotFound/i.test(String((e as Error)?.message))
      ? `The escrow contract ${ESCROW_CONTRACT} isn't deployed on NEAR testnet yet. Try again soon.`
      : friendlyError(e, "Couldn't reach NEAR. Check your connection and try again.");
  } finally {
    state.loading = false;
    ui().render();
  }
}

const cancelled = (e: unknown): boolean => /cancel|reject|closed|denied/i.test(String((e as Error)?.message ?? e));

/** Runs a wallet transaction with a status line, then reloads. True when it went through. */
async function walletAct(pending: string, done: string, fn: () => Promise<void>): Promise<boolean> {
  state.note = pending;
  ui().render();
  let ok = false;
  try {
    await fn();
    state.note = done;
    ok = true;
  } catch (e) {
    state.note = cancelled(e) ? '' : friendlyError(e, "The wallet couldn't send it. Try again.");
  }
  await load();
  return ok;
}

async function signIn(): Promise<void> {
  const acc = app().services.account as unknown as { signInWithNear?: () => Promise<void> };
  if (!acc.signInWithNear) return ui().message('NEAR tables', 'NEAR sign-in needs the Nomad server, which this build does not set.');
  try {
    await acc.signInWithNear();
  } catch (e) {
    ui().message('Continue with NEAR', esc(friendlyError(e, "Couldn't sign in with NEAR. Try again.")));
  }
  await load();
}

/** The wallet must be the NEAR account you're signed in with: the game server seats that one. */
async function walletReady(): Promise<boolean> {
  if (!state.account) {
    void signIn();
    return false;
  }
  state.wallet = (await nearAccount()) ?? (await nearSigner.connect().catch(() => null));
  if (!state.wallet) return false;
  if (state.wallet !== state.account) {
    ui().message('Wrong NEAR wallet', `Your wallet is connected as <b>${esc(state.wallet)}</b>, but you're signed in as <b>${esc(state.account)}</b>. Switch the wallet to ${esc(state.account)}, or sign in again with NEAR.`);
    ui().render();
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ actions

function depositNear(): void {
  void walletReady().then((ok) => {
    if (!ok) return;
    prompt('Deposit NEAR', 'Moves NEAR from your wallet to your game balance, for buying in. You can withdraw what you don\'t use at any time.', 'Amount in NEAR, e.g. 0.5', '', 'Deposit', (v) => {
      let amount: bigint;
      try {
        amount = parseNear(v);
        if (amount <= 0n) throw new Error('Enter an amount above 0.');
      } catch (e) {
        return ui().message('Deposit NEAR', esc((e as Error).message));
      }
      void walletAct('Confirm the deposit in your wallet…', `Deposited ${formatNear(amount)} NEAR.`, () => deposit(amount));
    }, 14);
  });
}

function withdrawNear(): void {
  if (state.balance <= 0n) return ui().message('Withdraw NEAR', 'Your game balance is empty. Chips at a table come back to it when you leave the table.');
  void walletReady().then((ok) => {
    if (!ok) return;
    prompt('Withdraw NEAR', `Sends NEAR from your game balance (${formatNear(state.balance)} NEAR) back to your wallet.`, 'Amount in NEAR', formatNear(state.balance, 24), 'Withdraw', (v) => {
      let amount: bigint;
      try {
        amount = parseNear(v);
        if (amount <= 0n) throw new Error('Enter an amount above 0.');
        if (amount > state.balance) throw new Error(`You have ${formatNear(state.balance)} NEAR to withdraw.`);
      } catch (e) {
        return ui().message('Withdraw NEAR', esc((e as Error).message));
      }
      void walletAct('Confirm the withdrawal in your wallet…', `Withdrew ${formatNear(amount)} NEAR.`, () => withdraw(amount));
    }, 30);
  });
}

/** Joins the table's room with the seat's locked chips. */
async function join(t: HouseTable, chips: number): Promise<void> {
  const net = app().services.net;
  if (!net?.joinNearTable) return ui().message('NEAR tables', 'This build has no game server connection.');
  state.note = `Joining ${t.name} with ${formatN0(chips)} chips…`;
  ui().render();
  try {
    await net.joinNearTable(t.id, chips);
    state.note = '';
  } catch (e) {
    state.note = '';
    ui().message('NEAR tables', esc(friendlyError(e, "Couldn't join the table. Your NEAR stays locked at your seat: try again.")));
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

async function sit(i: number): Promise<void> {
  const t = HOUSE_TABLES[i];
  if (!t) return;
  if (!state.account) return void signIn();
  const seat = state.seats.get(t.id) ?? null;
  if (seat && BigInt(seat.locked) > 0n) return void join(t, yoctoToChips(seat.locked, chipYocto()));
  if (!(await walletReady())) return;
  const table = state.tables.get(t.id) ?? null;
  const c = table?.config ?? t.config;
  const pct = rakeBps() / 100;
  prompt(`Buy in: ${t.name}`, `Blinds ${c.small_blind} / ${c.big_blind}. Buy in for ${formatN0(c.min_buy_in)} to ${formatN0(c.max_buy_in)} chips (${near(c.min_buy_in)} to ${near(c.max_buy_in)} NEAR; a chip is 0.001 NEAR). ${pct}% goes to the house; you sit with the rest. Your game balance (${formatNear(state.balance)} NEAR) is used first, then your wallet.`, 'Chips', String(c.min_buy_in), 'Buy in & sit', (v) => {
    const err = buyInError(v, c, table, seat, chipYocto());
    if (err) return ui().message(`Buy in: ${esc(t.name)}`, esc(err));
    const plan = buyInPlan(Number(v.trim()), state.balance, rakeBps(), chipYocto());
    const me = state.account!;
    void (async () => {
      const ok = await walletAct(
        plan.attach > 0n ? `Confirm the buy-in in your wallet (${formatNear(plan.attach)} NEAR from the wallet)…` : 'Confirm the buy-in in your wallet…',
        'Bought in. Taking your seat…',
        () => buyIn(t.id, plan),
      );
      if (!ok) return;
      const now = await seatAfterBuyIn(t.id, me);
      if (!now) {
        state.note = '';
        return ui().message('NEAR tables', "The buy-in went through but NEAR hasn't shown your seat yet. Wait a moment, then tap Sit.");
      }
      await join(t, yoctoToChips(now.locked, chipYocto()));
    })();
  }, 6);
}

// ------------------------------------------------------------------ views

function balanceCard(): string {
  if (!state.account) {
    return `<div class="v2-card v2-col"><b style="font-size:1.2em">Play for NEAR</b><div class="v2-sm v2-mut">Sign in with your NEAR account to buy in. The game seats the account you sign in with.</div>${btn('Continue with NEAR', 'nt-signin', { h: 'gold' })}</div>`;
  }
  const mismatch = state.wallet && state.wallet !== state.account ? `<div class="v2-xs v2-badc">Your wallet is connected as ${esc(state.wallet)}. Switch it to ${esc(state.account)} to buy in.</div>` : '';
  return `<div class="v2-card v2-row v2-wrap"><div class="v2-grow"><b style="font-size:1.5em">${formatNear(state.balance)} NEAR</b><div class="v2-xs v2-mut">Game balance on the escrow · ${esc(state.account)}</div>${mismatch}</div>${btn(`${ico('plus', 0.9)} Deposit`, 'nt-deposit', { h: 'gold', c: 'sm' })}${btn('Withdraw', 'nt-withdraw', { h: 'ghost', c: 'sm' })}</div>`;
}

function tableCard(t: HouseTable, i: number): string {
  const table = state.tables.get(t.id) ?? null;
  const c = table?.config ?? t.config;
  const seat = state.seats.get(t.id) ?? null;
  const mine = seat && BigInt(seat.locked) > 0n ? yoctoToChips(seat.locked, chipYocto()) : 0;
  const open = !!table && !table.closed;
  const full = !!table && table.seated >= c.seats;
  const stats = [
    [`${c.small_blind} / ${c.big_blind}`, 'blinds'],
    [`${formatN0(c.min_buy_in)}–${formatN0(c.max_buy_in)}`, 'chips buy-in'],
    [`${near(c.min_buy_in)}–${near(c.max_buy_in)}`, 'NEAR'],
    [table ? `${table.seated} / ${c.seats}` : '—', 'seats taken'],
  ].map(([v, l]) => `<div><b>${v}</b><div class="v2-xs v2-mut">${l}</div></div>`).join('');
  const status = mine
    ? `<span class="v2-good">You have a seat: ${formatN0(mine)} chips</span>`
    : !table ? 'Not open on NEAR yet' : table.closed ? 'Closed' : full ? 'Full' : '';
  const action = mine
    ? btn(`Sit with ${formatN0(mine)} chips ${ico('next', 0.8)}`, 'nt-sit', { h: 'gold', c: 'w', v: i })
    : btn(`Buy in & sit ${ico('next', 0.8)}`, 'nt-sit', { h: 'gold', c: 'w', v: i, dis: !open || full });
  return `<div class="v2-card v2-col v2-ag-mcard"><div class="v2-row">${ico('coin', 2.2)}<div class="v2-grow"><b style="display:block;font-size:1.1em">${esc(t.name)}</b><div class="v2-xs v2-mut">${esc(t.id)}${status ? ` · ${status}` : ''}</div></div></div><div class="v2-row v2-ag-mstats">${stats}</div>${action}</div>`;
}

export const nearTablesScreen: ScreenDef = {
  id: 'near-tables',
  back: 'main',
  open() {
    void load();
  },
  render() {
    const note = `<div class="v2-xs v2-mut">${state.note ? `<b class="v2-goldc">${esc(state.note)}</b>` : `Real stakes on NEAR testnet: your buy-in is held by the escrow contract <a href="${NEAR_EXPLORER}/address/${ESCROW_CONTRACT}" target="_blank" rel="noopener">${ESCROW_CONTRACT}</a> and paid back to your game balance when you leave. Every deal is committed before it's dealt: check it with Verify at the table.`}</div>`;
    let body: string;
    if (state.loading && !state.tables.size) body = `<div class="v2-panel v2-body"><div class="v2-empty">${ico('coin', 5)}Loading from NEAR…</div></div>`;
    else if (state.error) body = `<div class="v2-panel v2-body"><div class="v2-empty">${esc(state.error)}${btn('Try again', 'nt-reload', { h: 'gold' })}</div></div>`;
    else body = `${balanceCard()}<div class="v2-ag-mgrid v2-scroll">${HOUSE_TABLES.map(tableCard).join('')}</div>`;
    return topBar('NEAR tables') + `<div class="v2-body v2-col">${note}${body}</div>`;
  },
  actions: {
    'nt-reload': () => void load(),
    'nt-signin': () => void signIn(),
    'nt-deposit': () => depositNear(),
    'nt-withdraw': () => withdrawNear(),
    'nt-sit': (v) => void sit(Number(v)),
  },
};
