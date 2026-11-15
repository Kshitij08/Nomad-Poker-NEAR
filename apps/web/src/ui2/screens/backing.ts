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
  recentSessions, registerAgent, sessionRecord, styleWords, validAgentId,
  type AgentCard, type Holding, type Position, type SessionSummary,
} from '../../near/backing';
import { replaySettled, toAgentReplay } from '../../near/replay';
import { openCrossChain } from './backingIntents';
import { nearAccount, nearSigner } from '../../near/wallet';
import { AgentStrategyWords as W } from '@nomad/engine/agents';
import { btn, esc, fmt, seg } from '../core';
import { ico } from '../icons';
import { app, friendlyError, prompt, S, ui } from '../ctx';
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

function proCard(c: AgentCard, i: number): string {
  const a = c.agent;
  const p = c.pool;
  const h = state.holdings.get(a.id);
  const pct = p ? priceChangePct(p.price) : 0;
  const stake = h && big(h.shares) > 0n ? `${formatNear(h.value)} NEAR` : h && big(h.pending_in) > 0n ? 'Joining' : '—';
  const playing = p && big(p.at_table) > 0n;
  const stats = [
    [p ? `${formatNear(p.value, 3)}` : '0', 'NEAR in pool'],
    [p ? `<span class="${tone(pct)}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span>` : '—', 'since start'],
    [fmt(a.sessions), 'sessions'],
    [stake, 'your stake'],
  ].map(([v, l]) => `<div><b>${v}</b><div class="v2-xs v2-mut">${l}</div></div>`).join('');
  const action = btn(h && big(h.shares) > 0n ? 'Add more' : 'Back', 'bk-join', { h: 'gold', c: 'w', v: i });
  const leave = h && big(h.shares) > 0n ? btn('Leave', 'bk-leave', { h: 'ghost', c: 'sm', v: i }) : '';
  return `<div class="v2-card v2-col v2-ag-mcard"><div class="v2-row">${ico('robot', 2.4)}<div class="v2-grow"><b class="v2-ellip" style="display:block;font-size:1.1em">${esc(a.id)}</b><div class="v2-xs v2-mut v2-ellip">by ${esc(a.owner)}${playing ? ' · <span class="v2-good">playing now</span>' : ''}</div></div>${leave}</div><span class="v2-pill" style="width:max-content">${esc(styleWords(a.tight, a.aggro))}</span><div class="v2-row v2-ag-mstats">${stats}</div><div class="v2-xs v2-mut">${fmt(a.hands)} hands · ${a.net_chips >= 0 ? '+' : ''}${fmt(a.net_chips)} chips all time</div>${action}${btn('From another chain', 'bk-xchain', { h: 'ghost', c: 'sm w', v: i })}</div>`;
}

function prosView(): string {
  if (!state.cards.length) return `<div class="v2-bk-body"><div class="v2-empty">${ico('robot', 5)}No agents are listed yet. List yours from My stakes.</div></div>`;
  return `<div class="v2-ag-mgrid v2-scroll">${state.cards.map(proCard).join('')}</div>`;
}

function mineView(): string {
  const listBtn = btn(`${ico('plus', 0.9)} List your agent`, 'bk-register', { h: 'violet' });
  if (!state.account)
    return `<div class="v2-bk-body"><div class="v2-empty">${ico('robot', 5)}Connect a NEAR wallet to see your stakes and list an agent.${btn('Connect NEAR wallet', 'bk-connect', { h: 'gold' })}</div></div>`;
  const rows = state.cards
    .map(({ agent }) => {
      const h = state.holdings.get(agent.id);
      const p = state.positions.get(agent.id);
      const parts: string[] = [];
      if (h && big(h.shares) > 0n) parts.push(`${formatNear(h.value)} NEAR in the pool`);
      if (h && big(h.pending_in) > 0n) parts.push(`${formatNear(h.pending_in)} NEAR joining after this session`);
      if (h && big(h.pending_out_shares) > 0n) parts.push('leaving after this session');
      if (p && big(p.balance) + big(p.at_table) > 0n) parts.push(`${formatNear(big(p.balance) + big(p.at_table))} NEAR backed on your own, <b class="${tone(big(p.net))}">${signedNear(big(p.net))}</b>`);
      return parts.length ? `<div class="v2-card v2-row v2-wrap"><b class="v2-grow">${esc(agent.id)}</b><span class="v2-sm">${parts.join(' · ')}</span></div>` : '';
    })
    .join('');
  const mine = state.cards.filter((c) => c.agent.owner === state.account);
  const earned = big(state.earned);
  const tiles = `<div class="v2-row v2-ag-tiles"><div class="v2-card v2-grow"><b style="font-size:1.5em">${formatNear(earned)} NEAR</b><div class="v2-xs v2-mut">Earned from your agents (8% of the profit they make backers)</div>${earned > 0n ? btn('Claim', 'bk-claim', { h: 'gold', c: 'sm' }) : ''}</div><div class="v2-card v2-grow"><b style="font-size:1.5em">${mine.length}</b><div class="v2-xs v2-mut">Agents you listed${mine.length ? `: ${mine.map((c) => esc(c.agent.id)).join(', ')}` : ''}</div>${listBtn}</div></div>`;
  return `<div class="v2-col v2-scroll v2-bk-body">${tiles}${rows || `<div class="v2-empty">You haven't backed an agent yet.${btn('Browse agents', 'bk-view', { h: 'gold', v: 'pros' })}</div>`}</div>`;
}

function sessionsView(): string {
  if (!state.sessions.length) return `<div class="v2-bk-body"><div class="v2-empty">${ico('eye', 5)}No settled sessions yet. They show here once an agent session settles on NEAR.</div></div>`;
  const rows = state.sessions
    .map((s, i) => {
      const when = new Date(Number(big(s.settled_at) / 1_000_000n));
      return `<div class="v2-card v2-row v2-wrap"><b>${esc(s.session_id)}</b><span class="v2-grow v2-sm v2-mut">${esc(s.agents.join(' · '))}</span><span class="v2-sm">${s.hands} hands · ${esc(when.toLocaleString())}</span>${btn(`${ico('eye', 0.9)} Watch`, 'bk-watch', { h: 'violet', c: 'sm', v: i })}</div>`;
    })
    .join('');
  return `<div class="v2-col v2-scroll v2-bk-body">${rows}<div class="v2-xs v2-mut">Watch re-deals every hand in your browser from the dealer's randomness proof and replays each bet, then checks the final stacks against what the contract paid.</div></div>`;
}

// ------------------------------------------------------------------ actions

function join(i: number): void {
  const c = state.cards[i];
  if (!c) return;
  if (!state.account) return void connect();
  const playing = c.pool && big(c.pool.at_table) > 0n;
  const other = `<div class="v2-xs v2-mut" style="margin-top:.5em">Holding crypto on another chain? ${btn('See a live quote', 'bk-xchain', { h: 'ghost', c: 'sm', v: i })}</div>`;
  prompt(`Back ${c.agent.id}`, (playing
    ? 'The pool is playing a session now: your NEAR joins at the value it settles at.'
    : "You get pool shares at today's value. At most 25% of the pool plays in any one session. Backers get 90% of the profit; the pro 8%, Nomad 2%; never of losses.") + other,
  'Amount in NEAR, e.g. 0.5', '', 'Join pool', (v) => {
    let amount: bigint;
    try {
      amount = parseNear(v);
      if (amount <= 0n) throw new Error('Enter an amount above 0.');
    } catch (e) {
      return ui().message('Back ' + esc(c.agent.id), esc((e as Error).message));
    }
    void walletAct('Confirm in your wallet to join the pool…', `You joined ${c.agent.id}'s pool.`, () => joinPool(c.agent.id, amount));
  }, 14);
}

function leave(i: number): void {
  const c = state.cards[i];
  const h = c && state.holdings.get(c.agent.id);
  if (!c || !h) return;
  const playing = c.pool && big(c.pool.at_table) > 0n;
  ui().message(`Leave ${esc(c.agent.id)}?`, `Your stake is worth ${formatNear(h.value)} NEAR.${playing ? ' The pool is playing now: you leave at the value it settles at.' : ''} It goes back to your wallet.`, 'Leave pool', () => {
    void walletAct('Confirm in your wallet to leave the pool…', playing ? 'Leaving after this session settles.' : `You left ${c.agent.id}'s pool.`, () => leavePool(c.agent.id, h.shares));
  }, 'Cancel', undefined, 'red');
}

/** The Strategy tab's settings as the contract's profile: tight (plays few hands) and aggro, 0–100. */
function profileFromStrategy(): { tight: number; aggro: number } {
  const s = S('agentStrategy') as { values?: readonly number[]; streets?: unknown } | undefined;
  if (!s?.values) return { tight: 50, aggro: 50 };
  const hands = W.dialForHands(s.values as never);
  const pressure = W.dialForPressure(W.after(s.values as never, s.streets as never) as never);
  return { tight: Math.round((1 - hands) * 100), aggro: Math.round(pressure * 100) };
}

function register(): void {
  if (!state.account) return void connect();
  const p = profileFromStrategy();
  prompt('List your agent', `It plays your Strategy tab's style (${esc(styleWords(p.tight, p.aggro))}). Backers can then put NEAR behind it, and you earn 8% of the profit it makes them. Name it with lowercase letters, digits and dashes.`, 'my-agent', '', 'List agent', (v) => {
    const id = v.trim().toLowerCase();
    if (!validAgentId(id)) return ui().message('List your agent', 'Use 1 to 32 lowercase letters, digits or dashes.');
    void walletAct('Confirm in your wallet to list the agent…', `${id} is listed.`, () => registerAgent(id, p.tight, p.aggro));
  }, 32);
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
    const names = rec.payouts?.seats.map((p) => p.agent) ?? s.agents;
    // Cards face up for your own agent, else one you back, else the first seat; the caption says which.
    const owned = names.findIndex((n) => state.cards.some((c) => c.agent.id === n && c.agent.owner === state.account));
    const backed = names.findIndex((n) => big(state.holdings.get(n)?.shares) > 0n || big(state.holdings.get(n)?.pending_out_shares) > 0n);
    const focus = owned >= 0 ? owned : backed >= 0 ? backed : 0;
    const hands = out.hands.map((h) => toAgentReplay(h, names, rec.sb, rec.bb, focus));
    state.note = '';
    if (!verified) return ui().message('Replay does not match', `Your browser's replay of ${esc(s.session_id)} ends with different stacks than the contract recorded. Don't trust this session.`);
    await app().router.navigate('table', {
      session: replaySession(hands, {
        title: `${s.session_id} · verified`,
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
      const note = `<div class="v2-xs v2-mut">${state.note ? `<b class="v2-goldc">${esc(state.note)}</b>` : `Back a pro's agent with NEAR: backers get 90% of the profit, the pro 8%, Nomad 2%, never of losses. On NEAR testnet, contract <a href="${NEAR_EXPLORER}/address/${NEAR_CONTRACT}" target="_blank" rel="noopener">${NEAR_CONTRACT}</a>.`}</div>`;
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
      'bk-xchain': (v) => {
        const c = state.cards[Number(v)];
        if (c) openCrossChain(c.agent.id, () => join(Number(v)));
      },
      'bk-claim': () => void walletAct('Confirm in your wallet to claim…', 'Earnings sent to your wallet.', () => claimEarnings()),
      'bk-register': () => register(),
      'bk-watch': (v) => void watch(Number(v)),
    },
  };
}
