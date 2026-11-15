/**
 * Agents › Back a pro: copy trading on NEAR. Pros list agents on the table contract; backers put NEAR into an agent's
 * pool and share its results (90% of the profit to backers, 8% to the pro, 2% to Nomad, never of losses). Settled
 * sessions are re-dealt from the dealer's randomness proof in the browser and watched on the 3D table.
 *
 * Works in Demo and On-chain alike: it is NEAR only, through the player's NEAR wallet.
 */
import { replaySession } from '../../agents/replaySession';
import {
  NEAR_CONTRACT, NEAR_EXPLORER, claimEarnings, earnings, formatNear, holding, joinPool, leavePool, listAgents, parseNear, position, priceChangePct,
  recentSessions, sessionRecord, styleWords, wholeOf,
  type AgentCard, type Holding, type Position, type SessionRecord, type SessionSummary, withdrawPosition,
} from '../../near/backing';
import { replaySettled, toAgentReplay } from '../../near/replay';
import { openCrossChain } from './backingIntents';
import { getNearAiSigners, verifyNearAiProof } from '../../near/nearAi';
import { nearAiLabel } from '../agentListing';
import { nearAccount, nearSigner } from '../../near/wallet';
import { btn, esc, fmt, seg } from '../core';
import { ico } from '../icons';
import { app, friendlyError, prompt, ui } from '../ctx';
import type { ScreenDef } from '../install';

type View = 'pros' | 'mine' | 'sessions';

const state = {
  view: 'pros' as View,
  loading: false,
  error: '',
  account: null as string | null,
  cards: [] as AgentCard[],
  holdings: new Map<string, Holding>(),
  positions: new Map<string, Position>(),
  earned: '0',
  sessions: [] as SessionSummary[],
  records: new Map<string, SessionRecord>(),
  /** Attested NEAR AI signing addresses (lowercase), for checking each session's model proofs here. */
  aiSigners: null as string[] | null,
  /** Session id → its NEAR AI proofs all check out (absent: the session has none). */
  aiOk: new Map<string, boolean>(),
  /** A wallet action in progress ("Confirm in your wallet…"), or its result. */
  note: '',
};

const big = (s: string | undefined | null): bigint => BigInt(s ?? '0');
const signedNear = (y: bigint): string => (y > 0n ? '+' : y < 0n ? '−' : '') + formatNear(y < 0n ? -y : y);
const tone = (v: number | bigint): string => (v > 0 ? 'v2-good' : v < 0 ? 'v2-badc' : '');

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  ui().render();
  try {
    state.account = await nearAccount();
    const [cards, sessions] = await Promise.all([listAgents(), recentSessions(12)]);
    state.cards = cards;
    state.sessions = sessions;
    // Each listed session's record, for its results (cached: settled records don't change).
    const missing = sessions.filter((s) => !state.records.has(s.session_id));
    const recs = await Promise.all(missing.map((s) => sessionRecord(s.session_id).catch(() => null)));
    missing.forEach((s, i) => recs[i] && state.records.set(s.session_id, recs[i]));
    state.aiSigners ??= await getNearAiSigners().then((l) => l.flatMap((m) => m.signing_addresses.map((a) => a.toLowerCase()))).catch(() => null);
    for (const [id, rec] of state.records) if (rec.near_ai?.length && !state.aiOk.has(id)) state.aiOk.set(id, aiProofsOk(rec));
    state.holdings.clear();
    state.positions.clear();
    state.earned = '0';
    const me = state.account;
    if (me) {
      const rows = await Promise.all(cards.map(async ({ agent }) => [agent.id, await holding(me, agent.id), await position(me, agent.id).catch(() => null)] as const));
      for (const [id, h, p] of rows) {
        state.holdings.set(id, h);
        if (p) state.positions.set(id, p);
      }
      state.earned = await earnings(me).catch(() => '0');
    }
  } catch (e) {
    state.error = friendlyError(e, "Couldn't reach NEAR. Check your connection and try again.");
  } finally {
    state.loading = false;
    ui().render();
  }
}

/** Runs a wallet transaction with a status line, then reloads. */
async function walletAct(pending: string, done: string, fn: () => Promise<void>): Promise<void> {
  state.note = pending;
  ui().render();
  try {
    await fn();
    state.note = done;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    state.note = /cancel|reject|closed|denied/i.test(msg) ? '' : friendlyError(e, "The wallet couldn't send it. Try again.");
  }
  await load();
}

async function connect(): Promise<void> {
  try {
    if (await nearSigner.connect()) await load();
  } catch (e) {
    ui().message('NEAR wallet', esc(friendlyError(e, "Couldn't connect your NEAR wallet. Try again.")));
  }
}

// ------------------------------------------------------------------ views

/**
 * Your profit or loss on a pool stake: value + taken out − put in. A join queued during a session (`pending_in`) is in
 * neither `value` nor `deposited` until it becomes shares, so it doesn't count. Null when the contract has no cost basis.
 */
function holdingPnl(h: Holding | undefined): bigint | null {
  if (!h || h.deposited == null) return null;
  return big(h.value) + big(h.withdrawn) - big(h.deposited);
}

/** Your P&L on an agent: the pool stake plus your own (vault) position. Null when neither is known. */
function agentPnl(id: string): bigint | null {
  const hp = holdingPnl(state.holdings.get(id));
  const p = state.positions.get(id);
  const vp = p && (big(p.deposited) > 0n || big(p.net) !== 0n) ? big(p.net) : null;
  return hp === null && vp === null ? null : (hp ?? 0n) + (vp ?? 0n);
}

const pnlText = (v: bigint | null): string => (v === null ? '—' : `<span class="${tone(v)}">${signedNear(v)}</span>`);
const staked = (h: Holding | undefined): boolean => !!h && big(h.shares) > 0n;

function proCard(c: AgentCard, i: number): string {
  const a = c.agent;
  const p = c.pool;
  const h = state.holdings.get(a.id);
  const pct = p ? priceChangePct(p.price) : 0;
  const mine = staked(h);
  const stake = mine ? `${formatNear(h!.value)}` : h && big(h.pending_in) > 0n ? 'Joining' : '—';
  const playing = p && big(p.at_table) > 0n;
  const stats = [
    [p ? `${formatNear(p.value, 3)}` : '0', 'NEAR in pool'],
    [p ? `<span class="${tone(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span>` : '—', 'pool since start'],
    [stake, 'your stake'],
    [mine || state.positions.has(a.id) ? pnlText(agentPnl(a.id)) : '—', 'your P&amp;L'],
  ].map(([v, l]) => `<div><b>${v}</b><div class="v2-xs v2-mut">${l}</div></div>`).join('');
  const leaving = h && big(h.pending_out_shares) > 0n;
  const action = btn(mine ? 'Add stake' : 'Stake', 'bk-join', { h: 'gold', c: 'v2-grow', v: i })
    + (mine ? btn(leaving ? 'Withdrawing…' : 'Withdraw', 'bk-leave', { h: 'violet', c: 'v2-grow', v: i, dis: !!leaving }) : '');
  return `<div class="v2-card v2-col v2-ag-mcard"><div class="v2-row">${ico('robot', 2.4)}<div class="v2-grow"><b class="v2-ellip" style="display:block;font-size:1.1em">${esc(a.id)}</b><div class="v2-xs v2-mut v2-ellip">by ${esc(a.owner)}${playing ? ' · <span class="v2-good">playing now</span>' : ''}</div></div></div><div class="v2-row v2-wrap" style="gap:.35em"><span class="v2-pill" style="width:max-content">${esc(a.private_strategy ? 'Private strategy' : styleWords(a.tight, a.aggro))}</span>${a.private_strategy ? `<span class="v2-pill v2-ai-pill" title="${AI_CARD_TIP}">${nearAiLabel(a.private_strategy.model)}</span>` : ''}</div><div class="v2-row v2-ag-mstats">${stats}</div><div class="v2-xs v2-mut">${fmt(a.sessions)} sessions · ${fmt(a.hands)} hands · ${a.net_chips >= 0 ? '+' : ''}${fmt(a.net_chips)} chips all time</div><div class="v2-row" style="gap:.4em">${action}</div>${btn('Stake from another chain', 'bk-xchain', { h: 'ghost', c: 'sm w', v: i })}</div>`;
}

function prosView(): string {
  if (!state.cards.length) return `<div class="v2-bk-body"><div class="v2-empty">${ico('robot', 5)}No agents are listed yet. List yours from My stakes.</div></div>`;
  return `<div class="v2-ag-mgrid v2-scroll">${state.cards.map(proCard).join('')}</div>`;
}

function mineView(): string {
  const listBtn = btn(`${ico('plus', 0.9)} List your agent`, 'bk-register', { h: 'violet' });
  if (!state.account)
    return `<div class="v2-bk-body"><div class="v2-empty">${ico('robot', 5)}Connect a NEAR wallet to see your stakes and list an agent.${btn('Connect NEAR wallet', 'bk-connect', { h: 'gold' })}</div></div>`;
  let total = 0n;
  let pnlSum: bigint | null = null;
  const rows = state.cards
    .map(({ agent }, i) => {
      const h = state.holdings.get(agent.id);
      const p = state.positions.get(agent.id);
      const inPool = staked(h) ? big(h!.value) : 0n;
      const own = p ? big(p.balance) + big(p.at_table) : 0n;
      const joining = h ? big(h.pending_in) : 0n;
      if (inPool + own + joining === 0n && !(h && big(h.pending_out_shares) > 0n)) return '';
      total += inPool + own + joining;
      const pnl = agentPnl(agent.id);
      if (pnl !== null) pnlSum = (pnlSum ?? 0n) + pnl;
      const notes: string[] = [];
      if (joining > 0n) notes.push(`${formatNear(joining)} NEAR joins after this session`);
      if (h && big(h.pending_out_shares) > 0n) notes.push('withdrawing after this session');
      if (own > 0n) notes.push(`${formatNear(own)} NEAR backed on your own${p && big(p.at_table) > 0n ? ' (part at a table)' : ''}`);
      const actions = (staked(h) && !(big(h!.pending_out_shares) > 0n) ? btn('Withdraw', 'bk-leave', { h: 'violet', c: 'sm', v: i }) : '')
        + (p && big(p.balance) > 0n ? btn('Withdraw own', 'bk-vwithdraw', { h: 'ghost', c: 'sm', v: i }) : '')
        + btn('Add stake', 'bk-join', { h: 'gold', c: 'sm', v: i });
      return `<div class="v2-bk-st v2-ag-row"><div><b>${esc(agent.id)}</b>${notes.length ? `<div class="v2-xs v2-mut">${notes.join(' · ')}</div>` : ''}</div><span class="v2-num"><span class="v2-ag-k">Stake </span>${formatNear(inPool + own + joining)} NEAR</span><b class="v2-num"><span class="v2-ag-k">P&amp;L </span>${pnlText(pnl)}</b><span class="v2-row" style="gap:.35em;justify-content:flex-end">${actions}</span></div>`;
    })
    .join('');
  const mine = state.cards.filter((c) => c.agent.owner === state.account);
  const earned = big(state.earned);
  const tile = (v: string, l: string, extra = '') => `<div class="v2-card v2-grow"><b style="font-size:1.5em">${v}</b><div class="v2-xs v2-mut">${l}</div>${extra}</div>`;
  const tiles = `<div class="v2-row v2-wrap v2-ag-tiles">${tile(`${formatNear(total)} NEAR`, 'Staked on agents')}${tile(pnlText(pnlSum), 'Your P&amp;L')}${tile(`${formatNear(earned)} NEAR`, 'Earned from your agents (8% of the profit they make backers)', earned > 0n ? btn('Claim', 'bk-claim', { h: 'gold', c: 'sm' }) : '')}${tile(String(mine.length), `Agents you listed${mine.length ? `: ${mine.map((c) => esc(c.agent.id)).join(', ')}` : ''}`, listBtn)}</div>`;
  const table = rows
    ? `<div class="v2-bk-st v2-ag-hdr"><span>Agent</span><span>Stake</span><span>P&amp;L</span><span></span></div>${rows}<div class="v2-xs v2-mut">P&amp;L is what your stake is worth now plus what you took out, minus what you put in.</div>`
    : `<div class="v2-empty">You haven't staked on an agent yet.${btn('Browse agents', 'bk-view', { h: 'gold', v: 'pros' })}</div>`;
  return `<div class="v2-col v2-scroll v2-bk-body">${tiles}${table}</div>`;
}

/** Each seat's result in a session, in NEAR (cash-out − buy-in), from its settled payouts. */
function seatNets(rec: SessionRecord | null | undefined): { agent: string; net: bigint }[] | null {
  return rec?.payouts?.seats.map((p) => ({ agent: p.agent, net: big(p.cash_out) - big(p.buy_in) })) ?? null;
}

/** Agents you own or stake on. */
const yours = (id: string): boolean =>
  state.cards.some((c) => c.agent.id === id && c.agent.owner === state.account) || staked(state.holdings.get(id)) || state.positions.has(id);

const AI_CARD_TIP = "Its pro's plain-words strategy is sealed to the dealer. Each session a private model on NEAR AI picks its settings, and the contract checks the model's signature.";
const AI_OK_TIP = "The private model's signed choices checked out in your browser";
const AI_BAD_TIP = 'A NEAR AI proof did not check out';

/** Every NEAR AI proof in a record checks out here (signature, attested signer, the profile played). */
function aiProofsOk(rec: SessionRecord): boolean {
  return (rec.near_ai ?? []).every((p) => verifyNearAiProof(p, state.aiSigners));
}

function sessionsView(): string {
  if (!state.sessions.length) return `<div class="v2-bk-body"><div class="v2-empty">${ico('eye', 5)}No settled sessions yet. They show here once an agent session settles on NEAR.</div></div>`;
  let hands = 0;
  let moved = 0n;
  let yourNet: bigint | null = null;
  const rows = state.sessions
    .map((s, i) => {
      hands += s.hands;
      const when = new Date(Number(big(s.settled_at) / 1_000_000n));
      const nets = seatNets(state.records.get(s.session_id));
      let result = '<span class="v2-mut">—</span>';
      if (nets) {
        const top = [...nets].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))[0];
        moved += nets.reduce((t, n) => t + (n.net > 0n ? n.net : 0n), 0n);
        for (const n of nets) if (yours(n.agent)) yourNet = (yourNet ?? 0n) + n.net;
        result = top && top.net !== 0n
          ? `${esc(top.agent)} <b class="${tone(top.net)}">${signedNear(top.net)}</b>`
          : '<span class="v2-mut">Even</span>';
      }
      const ai = state.aiOk.get(s.session_id);
      const aiMark = ai === undefined ? '' : ` <span class="v2-pill ${ai ? 'v2-ai-pill' : 'bad'}" title="${ai ? AI_OK_TIP : AI_BAD_TIP}">NEAR AI ${ai ? '✓' : '✗'}</span>`;
      const agents = s.agents.map((a) => (yours(a) ? `<b class="v2-goldc">${esc(a)}</b>` : esc(a))).join(' vs ') + aiMark;
      return `<div class="v2-bk-ss v2-ag-row"><b><span class="v2-ag-k">Session </span>${esc(s.session_id)}</b><span class="v2-ellip">${agents}</span><span class="v2-num"><span class="v2-ag-k">Hands </span>${s.hands}</span><span class="v2-sm">${esc(when.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))}</span><span><span class="v2-ag-k">Top </span>${result}</span><span style="justify-self:end">${btn(`${ico('eye', 0.9)} Watch`, 'bk-watch', { h: 'violet', c: 'sm', v: i })}</span></div>`;
    })
    .join('');
  const tile = (v: string, l: string) => `<div class="v2-card v2-grow"><b style="font-size:1.5em">${v}</b><div class="v2-sm v2-mut">${l}</div></div>`;
  const tiles = `<div class="v2-row v2-wrap v2-ag-tiles">${tile(String(state.sessions.length), 'Sessions')}${tile(fmt(hands), 'Total hands')}${tile(`${formatNear(moved)} NEAR`, 'Won across seats')}${tile(pnlText(yourNet), 'Agents you stake on, at the table')}</div>`;
  return `<div class="v2-col v2-scroll v2-bk-body">${tiles}<div class="v2-bk-ss v2-ag-hdr"><span>Session</span><span>Agents</span><span>Hands</span><span>Settled</span><span>Top result</span><span></span></div>${rows}<div class="v2-xs v2-mut">Results are each seat's cash-out minus buy-in, before fees: the whole table, not your share. Your own P&amp;L is under My stakes. Watch re-deals every hand in your browser from the dealer's randomness proof and replays each bet, then checks the final stacks against what the contract paid.</div></div>`;
}

// ------------------------------------------------------------------ actions

function join(i: number): void {
  const c = state.cards[i];
  if (!c) return;
  if (!state.account) return void connect();
  const playing = c.pool && big(c.pool.at_table) > 0n;
  const other = `<div class="v2-xs v2-mut" style="margin-top:.5em">Holding crypto on another chain? ${btn('See a live quote', 'bk-xchain', { h: 'ghost', c: 'sm', v: i })}</div>`;
  prompt(`Stake on ${c.agent.id}`, (playing
    ? 'The pool is playing a session now: your NEAR joins at the value it settles at.'
    : "You get pool shares at today's value. At most 25% of the pool plays in any one session. Backers get 90% of the profit; the pro 8%, Nomad 2%; never of losses.") + other,
  'Amount in NEAR, e.g. 0.5', '', 'Stake', (v) => {
    let amount: bigint;
    try {
      amount = parseNear(v);
      if (amount <= 0n) throw new Error('Enter an amount above 0.');
    } catch (e) {
      return ui().message('Stake on ' + esc(c.agent.id), esc((e as Error).message));
    }
    void walletAct('Confirm in your wallet to stake…', `You staked ${formatNear(amount)} NEAR on ${c.agent.id}.`, () => joinPool(c.agent.id, amount));
  }, 14);
}

/** Withdraw some or all of a pool stake: the NEAR amount becomes pool shares at today's price. */
function leave(i: number): void {
  const c = state.cards[i];
  const h = c && state.holdings.get(c.agent.id);
  if (!c || !h || !staked(h)) return;
  const value = big(h.value);
  const playing = c.pool && big(c.pool.at_table) > 0n;
  const title = `Withdraw from ${esc(c.agent.id)}`;
  prompt(title, `Your stake is worth ${formatNear(value)} NEAR. It goes back to your wallet${playing ? ' once the session playing now settles, at the value it settles at' : ''}.`, 'Amount in NEAR', formatNear(value), 'Withdraw', (v) => {
    let amount: bigint;
    try {
      amount = wholeOf(parseNear(v), value);
      if (amount <= 0n) throw new Error('Enter an amount above 0.');
      if (amount > value) throw new Error(`Your stake is worth ${formatNear(value)} NEAR.`);
    } catch (e) {
      return ui().message(title, esc((e as Error).message));
    }
    // All of it, or the matching share of it (rounded down, so it never asks for more than you hold).
    const shares = amount >= value || value === 0n ? big(h.shares) : (big(h.shares) * amount) / value;
    if (shares <= 0n) return ui().message(title, 'That amount is too small to withdraw.');
    void walletAct('Confirm in your wallet to withdraw…', playing ? 'Withdrawing after this session settles.' : `Withdrew about ${formatNear(amount)} NEAR to your wallet.`, () => leavePool(c.agent.id, shares.toString()));
  }, 30);
}

/** Withdraw your own (vault) position's idle balance. */
function withdrawOwn(i: number): void {
  const c = state.cards[i];
  const p = c && state.positions.get(c.agent.id);
  if (!c || !p) return;
  const idle = big(p.balance);
  const title = `Withdraw from ${esc(c.agent.id)}`;
  if (idle <= 0n) return ui().message(title, 'Nothing idle to withdraw: it is at a table. It comes back when the session settles.');
  prompt(title, `${formatNear(idle)} NEAR is idle in your own position and can go back to your wallet.`, 'Amount in NEAR', formatNear(idle), 'Withdraw', (v) => {
    let amount: bigint;
    try {
      amount = wholeOf(parseNear(v), idle);
      if (amount <= 0n || amount > idle) throw new Error(`Enter up to ${formatNear(idle)} NEAR.`);
    } catch (e) {
      return ui().message(title, esc((e as Error).message));
    }
    void walletAct('Confirm in your wallet to withdraw…', `Withdrew ${formatNear(amount)} NEAR to your wallet.`, () => withdrawPosition(c.agent.id, amount));
  }, 30);
}

async function watch(i: number): Promise<void> {
  const s = state.sessions[i];
  if (!s) return;
  state.note = `Re-dealing ${s.session_id} from its randomness proof…`;
  ui().render();
  try {
    const rec = await sessionRecord(s.session_id);
    if (!rec) throw new Error('That session is no longer on the contract.');
    const out = await replaySettled(rec);
    const verified = out.stacks.join() === rec.end_stacks.join();
    const ai = rec.near_ai?.length ? aiProofsOk(rec) : null;
    const names = rec.payouts?.seats.map((p) => p.agent) ?? s.agents;
    // Cards face up for your own agent, else one you back, else the first seat; the caption says which.
    const owned = names.findIndex((n) => state.cards.some((c) => c.agent.id === n && c.agent.owner === state.account));
    const backed = names.findIndex((n) => big(state.holdings.get(n)?.shares) > 0n || big(state.holdings.get(n)?.pending_out_shares) > 0n);
    const focus = owned >= 0 ? owned : backed >= 0 ? backed : 0;
    const hands = out.hands.map((h) => toAgentReplay(h, names, rec.sb, rec.bb, focus));
    state.note = '';
    if (ai === false) return ui().message('NEAR AI proof does not check out', `A private model's signed choice in ${esc(s.session_id)} doesn't match what was played, or isn't from an attested NEAR AI signer. Don't trust this session.`);
    if (!verified) return ui().message('Replay does not match', `Your browser's replay of ${esc(s.session_id)} ends with different stacks than the contract recorded. Don't trust this session.`);
    await app().router.navigate('table', {
      session: replaySession(hands, {
        title: `${s.session_id} · verified${ai ? ' · NEAR AI choice verified' : ''}`,
        backLabel: 'Back to sessions',
        focusLabel: owned >= 0 ? 'your agent' : backed >= 0 ? 'you back it' : '',
        returnTo: app().router.has('menu') ? 'menu' : undefined,
        onBack: () => setTimeout(() => ui().show('ag-back', 'sessions'), 0),
      }),
    });
  } catch (e) {
    state.note = '';
    ui().message('Watch', esc(friendlyError(e, "Couldn't replay that session. Try again.")));
  }
}

// ------------------------------------------------------------------ screen

export function backingScreen(header: (on: string) => string): ScreenDef {
  return {
    id: 'ag-back',
    back: 'main',
    open(arg) {
      if (arg === 'pros' || arg === 'mine' || arg === 'sessions') state.view = arg;
      void load();
    },
    render() {
      const bar = `<div class="v2-row v2-wrap v2-ag-mbar">${seg([['pros', 'Agents'], ['mine', 'My stakes'], ['sessions', 'Sessions']], state.view, 'bk-view')}<div class="v2-grow"></div>${state.account ? `<span class="v2-pill" title="Your NEAR account">${esc(state.account)}</span>` : btn('Connect NEAR wallet', 'bk-connect', { h: 'gold', c: 'sm' })}</div>`;
      const note = `<div class="v2-xs v2-mut">${state.note ? `<b class="v2-goldc">${esc(state.note)}</b>` : `Back a pro's agent with NEAR: backers get 90% of the profit, the pro 8%, Nomad 2%, never of losses. On NEAR testnet, contract <a href="${NEAR_EXPLORER}/address/${NEAR_CONTRACT}" target="_blank" rel="noopener" class="v2-goldc">${NEAR_CONTRACT}</a>.`}</div>`;
      let body: string;
      if (state.loading && !state.cards.length) body = `<div class="v2-bk-body"><div class="v2-empty">${ico('robot', 5)}Loading from NEAR…</div></div>`;
      else if (state.error) body = `<div class="v2-bk-body"><div class="v2-empty">${esc(state.error)}${btn('Try again', 'bk-reload', { h: 'gold' })}</div></div>`;
      else body = state.view === 'pros' ? prosView() : state.view === 'mine' ? mineView() : sessionsView();
      // One purple panel around the page, as on Overview.
      return header('ag-back') + `<div class="v2-panel v2-bk">${bar}${note}${body}</div>`;
    },
    actions: {
      'bk-view': (v) => {
        state.view = v === 'mine' || v === 'sessions' ? v : 'pros';
      },
      'bk-reload': () => void load(),
      'bk-connect': () => void connect(),
      'bk-join': (v) => join(Number(v)),
      'bk-leave': (v) => leave(Number(v)),
      'bk-vwithdraw': (v) => withdrawOwn(Number(v)),
      'bk-xchain': (v) => {
        const c = state.cards[Number(v)];
        if (c) openCrossChain(c.agent.id, () => join(Number(v)));
      },
      'bk-claim': () => void walletAct('Confirm in your wallet to claim…', 'Earnings sent to your wallet.', () => claimEarnings()),
      'bk-register': () => ui().show('ag-overview'),
      'bk-watch': (v) => void watch(Number(v)),
    },
  };
}
