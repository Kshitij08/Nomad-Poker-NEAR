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
  ESCROW_CONTRACT, DEFAULT_RAKE_BPS, HOUSE_TABLES, buyIn, buyInError, buyInPlan, chipsToYocto, closeTable, createHostedTable, deposit, getBalance, getConfig, getSeat,
  getTable, hostedTableLink, isHostedTableId, newHostedTableId, parseInvites, tableForId, withdraw, yoctoToChips,
  type EscrowConfig, type EscrowSeat, type EscrowTable, type HouseTable,
} from '../../near/escrow';
import { NEAR_EXPLORER, formatNear, parseNear } from '../../near/backing';
import { nearAccount, nearSigner } from '../../near/wallet';
import { btn, esc } from '../core';
import { ico } from '../icons';
import { app, friendlyError, onchain, prompt, S, setMode, topBar, ui } from '../ctx';
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

// ------------------------------------------------------------------ hosted tables this browser knows

const KNOWN_KEY = 'nomad.near.hostedTables';

/** Hosted tables you made or opened a link to (newest first), remembered in this browser. */
function knownHosted(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isHostedTableId(x)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** Remembers a hosted table (a link you opened, or one you made). False for an id that isn't one. */
export function rememberHostedTable(id: string): boolean {
  if (!isHostedTableId(id)) return false;
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify([id, ...knownHosted().filter((x) => x !== id)].slice(0, 20)));
  } catch {
    /* private mode: listed for this visit only */
    sessionHosted.add(id);
  }
  return true;
}
const sessionHosted = new Set<string>();

function forgetHostedTable(id: string): void {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(knownHosted().filter((x) => x !== id)));
  } catch {
    /* nothing stored */
  }
  sessionHosted.delete(id);
}

/** The house tables, then the hosted ones this browser knows. */
function allTables(): HouseTable[] {
  const hosted = [...new Set([...knownHosted(), ...sessionHosted])].map(tableForId).filter((t): t is HouseTable => !!t);
  return [...HOUSE_TABLES, ...hosted];
}

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
    const list = allTables();
    const [config, tables, balance, seats] = await Promise.all([
      getConfig().catch(() => null),
      Promise.all(list.map((t) => getTable(t.id))),
      me ? getBalance(me) : Promise.resolve(0n),
      me ? Promise.all(list.map((t) => getSeat(t.id, me))) : Promise.resolve(list.map(() => null)),
    ]);
    state.config = config;
    state.balance = balance;
    list.forEach((t, i) => {
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

/** Host a table: pick a stake, optionally invite accounts, then the wallet creates it on the escrow. */
async function hostTable(): Promise<void> {
  if (!(await walletReady())) return;
  const pick = (stake: number) => {
    ui().closeDialog();
    const t = tableForId(newHostedTableId(stake))!;
    prompt(
      `Host a table: ${t.name.replace('Hosted · ', '')}`,
      `Blinds ${t.config.small_blind} / ${t.config.big_blind}, buy-in ${formatN0(t.config.min_buy_in)}–${formatN0(t.config.max_buy_in)} chips, ${t.config.seats} seats. Invite NEAR accounts to make it invite-only (comma separated), or leave it empty for anyone with the link. Hosting costs nothing; the house takes ${rakeBps() / 100}% of each buy-in, as at house tables.`,
      'alice.testnet, bob.testnet (optional)', '', 'Create table',
      (v) => {
        let invites: string[] | null;
        try {
          invites = parseInvites(v);
        } catch (e) {
          return ui().message('Host a table', esc((e as Error).message));
        }
        void (async () => {
          const ok = await walletAct('Confirm the new table in your wallet…', 'Your table is open. Copy its link to invite players.', () => createHostedTable(t, invites));
          if (ok) {
            rememberHostedTable(t.id);
            await load();
          }
        })();
      },
      400,
    );
  };
  const stakes = HOUSE_TABLES.map((h, i) => btn(`${esc(h.name)}<br><span class="v2-xs">${h.config.small_blind}/${h.config.big_blind} · ${near(h.config.min_buy_in)}+ NEAR</span>`, `host-st${i}`, { h: 'blue' })).join('');
  const actions: Record<string, () => void> = { 'host-cancel': () => ui().closeDialog() };
  HOUSE_TABLES.forEach((h, i) => (actions[`host-st${i}`] = () => pick(Number(/st(\d+)/.exec(h.id)![1]))));
  ui().openDialog({ title: 'Host a table', body: 'Pick the stakes. Players buy in from their own NEAR wallets; the escrow holds every stake.', buttons: `<div class="v2-btn-grid">${stakes}${btn('Cancel', 'host-cancel', { h: 'ghost' })}</div>`, actions });
}

async function copyLink(id: string): Promise<void> {
  const link = hostedTableLink(id);
  try {
    await navigator.clipboard.writeText(link);
    state.note = 'Invite link copied.';
  } catch {
    return ui().message('Invite link', `<input class="v2-field" style="width:100%" readonly value="${esc(link)}">`);
  }
  ui().render();
}

function closeHosted(id: string): void {
  void walletReady().then((ok) => {
    if (!ok) return;
    ui().message('Close your table?', 'No one can buy in after this. Players still seated keep playing and are paid out when they leave.', 'Close table', () => {
      void walletAct('Confirm closing the table in your wallet…', 'Table closed.', () => closeTable(id));
    }, 'Cancel', undefined, 'red');
  });
}

async function sit(i: number): Promise<void> {
  const t = allTables()[i];
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
  const hosted = isHostedTableId(t.id);
  const iHost = hosted && !!table?.host && table.host === state.account;
  const status = mine
    ? `<span class="v2-good">You have a seat: ${formatN0(mine)} chips</span>`
    : !table ? (hosted ? 'Not found on NEAR' : 'Not open on NEAR yet') : table.closed ? 'Closed' : full ? 'Full' : '';
  const who = hosted && table ? ` · ${iHost ? 'hosted by you' : `hosted by ${esc(table.host ?? '?')}`}${table.invite_only ? ' · invite-only' : ''}` : '';
  const action = mine
    ? btn(`Sit with ${formatN0(mine)} chips ${ico('next', 0.8)}`, 'nt-sit', { h: 'gold', c: 'w', v: i })
    : btn(`Buy in & sit ${ico('next', 0.8)}`, 'nt-sit', { h: 'gold', c: 'w', v: i, dis: !open || full });
  const tools = hosted
    ? `<div class="v2-row v2-wrap" style="gap:.4em">${open ? btn('Copy invite link', 'nt-link', { h: 'violet', c: 'sm', v: t.id }) : ''}${iHost && open ? btn('Close', 'nt-close', { h: 'ghost', c: 'sm', v: t.id }) : ''}${!open && !mine ? btn('Remove', 'nt-forget', { h: 'ghost', c: 'sm', v: t.id }) : ''}</div>`
    : '';
  return `<div class="v2-card v2-col v2-ag-mcard"><div class="v2-row">${ico('coin', 2.2)}<div class="v2-grow"><b style="display:block;font-size:1.1em">${esc(t.name)}</b><div class="v2-xs v2-mut">${esc(t.id)}${who}${status ? ` · ${status}` : ''}</div></div></div><div class="v2-row v2-ag-mstats">${stats}</div>${tools}${action}</div>`;
}

export const nearTablesScreen: ScreenDef = {
  id: 'near-tables',
  back: 'main',
  /** `arg`: a table id to sit at once loaded (the lobby's Sit Down in On-chain). */
  open(arg) {
    // NEAR tables are On-chain play: arriving from Demo (an invite link, the coin capsule) switches the mode.
    if (!onchain()) void setMode('chain');
    void load().then(() => {
      const i = typeof arg === 'string' ? allTables().findIndex((t) => t.id === arg) : -1;
      if (i >= 0 && state.account) void sit(i);
    });
  },
  render() {
    const note = `<div class="v2-xs v2-mut">${state.note ? `<b class="v2-goldc">${esc(state.note)}</b>` : `Real stakes on NEAR testnet: your buy-in is held by the escrow contract <a href="${NEAR_EXPLORER}/address/${ESCROW_CONTRACT}" target="_blank" rel="noopener">${ESCROW_CONTRACT}</a> and paid back to your game balance when you leave. Every deal is committed before it's dealt: check it with Verify at the table.`}</div>`;
    let body: string;
    if (state.loading && !state.tables.size) body = `<div class="v2-panel v2-body"><div class="v2-empty">${ico('coin', 5)}Loading from NEAR…</div></div>`;
    else if (state.error) body = `<div class="v2-panel v2-body"><div class="v2-empty">${esc(state.error)}${btn('Try again', 'nt-reload', { h: 'gold' })}</div></div>`;
    else {
      const host = state.account ? `<div class="v2-row">${btn(`${ico('plus', 0.9)} Host a table`, 'nt-host', { h: 'violet', c: 'sm' })}<span class="v2-xs v2-mut">Your own table at these stakes, open or invite-only, with a link to share.</span></div>` : '';
      body = `${balanceCard()}${host}<div class="v2-ag-mgrid v2-scroll">${allTables().map(tableCard).join('')}</div>`;
    }
    return topBar('NEAR tables') + `<div class="v2-body v2-col">${note}${body}</div>`;
  },
  actions: {
    'nt-reload': () => void load(),
    'nt-signin': () => void signIn(),
    'nt-deposit': () => depositNear(),
    'nt-withdraw': () => withdrawNear(),
    'nt-sit': (v) => void sit(Number(v)),
    'nt-host': () => void hostTable(),
    'nt-link': (v) => void copyLink(String(v)),
    'nt-close': (v) => closeHosted(String(v)),
    'nt-forget': (v) => {
      forgetHostedTable(String(v));
      void load();
    },
  },
};

/**
 * An invite link (`?neartable=<id>`): remember the table and open Play for NEAR once the main menu is up (after any
 * sign-in screen). Called once at boot.
 */
export function openNearTableLink(params: URLSearchParams, v2: { readonly currentId: string | null; show(id: string): void }): void {
  const id = params.get('neartable');
  if (!id || !rememberHostedTable(id)) return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (v2.currentId === 'main') {
      clearInterval(timer);
      v2.show('near-tables');
    } else if (Date.now() - started > 120_000) clearInterval(timer);
  }, 400);
}
