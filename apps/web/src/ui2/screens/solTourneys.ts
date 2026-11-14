/**
 * SOL tournaments (On-chain): 'sol-tourneys' (the list, Register / Leave / Cancel, a private tournament's code, "Go to
 * your table") and 'sol-tourney-host' (Host a SOL tournament). Opened from Tournaments' SOL note. The chain actions go
 * through the chain seam (src/chain), which loads the chain's code on first open.
 */
import { chain, chainMoney, ordinal, type ChainService, type Tourney } from '../../chain';
import { btn, chips, esc, input } from '../core';
import { ico } from '../icons';
import { ui, host, onchain, topBar, signedIn, copy, prompt } from '../ctx';
import type { ScreenDef } from '../install';
import { solAmt, solError, solTask } from './solKit';
import './sol.css';

const ST = {
  c: null as ChainService | null,
  loadErr: '',
  list: null as Tourney[] | null,
  listErr: '',
  timer: 0,
  // host form
  name: 'Nomad freezeout',
  speed: -1,
  players: 0,
  fee: 2,
  prize: 0,
  start: 0,
  isPrivate: false,
};

/** Loads the runtime and the tournament module (once). */
async function ready(): Promise<boolean> {
  if (ST.c) return true;
  try {
    ST.c = await chain();
    if (ST.speed < 0) ST.speed = ST.c.tourneys.choices.TURBO;
    ST.loadErr = '';
    return true;
  } catch (e) {
    console.error('[ui2] SOL tournaments', e);
    ST.loadErr = solError(e, "Couldn't open SOL tournaments. Check your connection and try again.");
    return false;
  } finally {
    ui().render();
  }
}

async function loadList(): Promise<void> {
  if (!(await ready())) return;
  try {
    ST.list = await ST.c!.tourneys.read();
    ST.listErr = '';
  } catch (e) {
    console.error('[ui2] SOL tournaments list', e);
    ST.listErr = solError(e, "Couldn't load the SOL tournaments. Check your connection and try again.");
  }
  ui().render();
}

const chainOnly = (): string =>
  `<div class="v2-panel v2-empty">${ico('sol', 5)}<span>SOL tournaments are played in On-chain mode.<br>Switch to On-chain on the main menu to see them.</span>${btn('Back to Tournaments', 'back', { h: 'blue' })}</div>`;

const loadingBox = (what: string): string => `<div class="v2-empty"><i class="v2-spin" aria-hidden="true"></i><span>${esc(what)}</span></div>`;

// ------------------------------------------------------------------ list

function row(t: Tourney): string {
  const phasePill = t.phase === 'running' ? '<span class="v2-pill ok">Playing now</span>' : t.phase === 'cancelled' ? '<span class="v2-pill">Cancelled</span>' : t.phase === 'finished' ? '<span class="v2-pill">Finished</span>' : '';
  const you = t.you === 'out' && t.place > 0 ? `<span class="v2-pill gold">You finished ${ordinal(t.place)}</span>` : t.you === 'in' && t.phase !== 'cancelled' && t.phase !== 'finished' ? '<span class="v2-pill ok">Registered</span>' : '';
  let actions = '';
  if (t.table >= 0) actions += btn('Go to your table', 'st-go', { h: 'gold', v: t.address });
  if (t.canRegister) actions += btn(`Register ${t.fee === 0n ? '· Free' : `${ico('sol', 0.9)} ${esc(chainMoney().format(t.fee))}`}`, 'st-reg', { h: 'gold', v: t.address });
  if (t.phase === 'registering' && t.you === 'in') actions += btn('Leave', 'st-leave', { h: 'red', v: t.address });
  if (t.phase === 'registering' && t.host) actions += btn('Cancel', 'st-cancel', { h: 'red', v: t.address });
  const fill = t.max > 0 ? Math.round((t.count / t.max) * 100) : 0;
  return `<div class="v2-card v2-col v2-stt${t.ready ? ' ready' : ''}">
  <div class="v2-row v2-wrap v2-stt1"><b class="v2-stt-n v2-ellip">${esc(t.name || 'SOL tournament')}</b>${t.isPrivate ? '<span class="v2-pill">Private</span>' : ''}${t.host ? '<span class="v2-pill gold">Hosting</span>' : ''}${phasePill}${you}<span class="v2-grow"></span><span class="v2-sm v2-mut">${esc(t.when)}</span></div>
  <div class="v2-row v2-wrap v2-stt2">
    <div class="v2-tc"><small>ENTRY</small>${t.fee === 0n ? '<b class="v2-good">Free</b>' : solAmt(t.fee)}</div>
    <div class="v2-tc"><small>1ST PRIZE</small>${solAmt(t.first)}</div>
    <div class="v2-tc"><small>2ND PRIZE</small>${solAmt(t.second)}</div>
    <div class="v2-tc"><small>PLAYERS</small><b>${t.count} / ${t.max}</b><div class="v2-bar v2-tbar"><i style="width:${fill}%"></i></div></div>
    <div class="v2-row v2-stt-act">${actions}</div>
  </div>
</div>`;
}

const list: ScreenDef = {
  id: 'sol-tourneys',
  back: 't-browse',
  input: { code: '' },
  open() {
    ST.listErr = '';
    void loadList();
    window.clearInterval(ST.timer);
    // The list refreshes every 5 s while it's open (registrations, rounds starting).
    ST.timer = window.setInterval(() => {
      if (onchain() && !ui().hasDialog) void loadList();
    }, 5000);
  },
  close() {
    window.clearInterval(ST.timer);
    ST.timer = 0;
  },
  render() {
    const top = topBar('SOL Tournaments');
    if (!onchain()) return top + chainOnly();
    const l = ST.list;
    const body = ST.loadErr && !ST.c ? `<div class="v2-empty">${ico('sol', 4)}<span>${esc(ST.loadErr)}</span>${btn('Try again', 'st-reload', { h: 'blue' })}</div>`
      : ST.listErr && !l ? `<div class="v2-empty">${ico('sol', 4)}<span>${esc(ST.listErr)}</span>${btn('Try again', 'st-reload', { h: 'blue' })}</div>`
        : !l ? loadingBox('Loading SOL tournaments…')
          : l.length === 0 ? `<div class="v2-empty">${ico('trophy', 6)}<span>No SOL tournaments are open right now.<br>Host one, or enter a private tournament's code.</span></div>`
            : l.map(row).join('');
    const ready = l?.find((t) => t.ready);
    return top + `<div class="v2-body v2-stl">
  <div class="v2-row v2-wrap v2-stl-top"><span class="v2-grow"></span>${input('code', list.input?.code ?? '', 'Private code', { max: 6, cls: 'v2-stl-code' })}<button class="v2-b blue" data-a="st-code" data-enter="code">Find</button>${btn(`${ico('plus', 1)} Host a tournament`, 'go', { h: 'gold', v: 'sol-tourney-host' })}</div>
  ${ready ? `<div class="v2-card v2-row v2-stl-ready">${ico('check', 1.8)}<span class="v2-grow"><b>${esc(ready.name)}</b>: your table is ready.</span>${btn('Go to your table', 'st-go', { h: 'gold', v: ready.address })}</div>` : ''}
  <div class="v2-panel v2-col v2-stl-panel">
    <div class="v2-xs v2-mut">2 to 30 players at 8-seat tables, 5,000 chips every round, blinds rise every level. 1st gets 60% and 2nd 40% (after a 5% fee on entries). Entry fees and prizes use your game balance. Solana test network.</div>
    <div class="v2-tlist v2-scroll">${body}</div>
  </div>
</div>`;
  },
  actions: {
    'st-reload': () => {
      ST.loadErr = ST.listErr = '';
      ST.list = null;
      void loadList();
    },
    'st-reg': (v) => {
      const t = ST.list?.find((x) => x.address === v);
      if (!t) return;
      if (!signedIn()) return host().show('Login');
      const fee = t.fee === 0n ? "It's free to enter." : `The ${esc(chainMoney().format(t.fee))} entry fee comes from your game balance.`;
      const go = (code: string | null) => register(t.address, code, t.name);
      if (t.isPrivate) return prompt(`Register for ${t.name}`, `This tournament is private. ${fee}`, 'Tournament code', '', 'Register', (c) => (c ? go(c) : undefined), 6);
      ui().message(`Register for ${esc(t.name)}?`, `${fee} You can leave before it starts and get it back.`, 'Register', () => go(null), 'Cancel');
    },
    'st-leave': (v) =>
      ui().message('Leave this tournament?', 'Your entry fee comes back to your game balance.', 'Leave', () => leaveOrCancel(v, false), 'Stay', undefined, 'red'),
    'st-cancel': (v) =>
      ui().message('Cancel this tournament?', 'Everyone who registered gets their entry fee back.', 'Cancel it', () => leaveOrCancel(v, true), 'Keep it', undefined, 'red'),
    'st-go': (v) => {
      const t = ST.list?.find((x) => x.address === v);
      if (!t || t.table < 0) return;
      void solTask('Go to your table', "Couldn't open your table. Try again in a moment.", async (st) => {
        await ST.c!.tourneys.goToTable(t.address, t.table, st);
      });
    },
    'st-code': () => {
      const code = (list.input?.code ?? '').replace(/\s+/g, '').toUpperCase();
      if (code.length === 0) return ui().message('Private tournament', 'Enter the 6-character code the host shared.');
      if (!signedIn()) return host().show('Login');
      void solTask('Private tournament', "Couldn't look up that code. Try again in a moment.", async (st) => {
        if (!(await ready())) throw new Error(ST.loadErr);
        st('Looking for the tournament…');
        const address = await ST.c!.tourneys.findByCode(code);
        if (!address) return 'No open tournament has that code. Check it with the host.';
        await ST.c!.tourneys.register(address, code, st);
        list.input = { code: '' };
        return "You're registered. Come back at the start time and the game takes you to your table.";
      }, () => void loadList());
    },
  },
};

function register(address: string, code: string | null, name: string): void {
  void solTask(`Register for ${name}`, "Couldn't register. Check your game balance and try again.", async (st) => {
    await ST.c!.tourneys.register(address, code, st);
    return "You're registered. Come back at the start time and the game takes you to your table.";
  }, () => void loadList());
}

function leaveOrCancel(address: string, cancel: boolean): void {
  void solTask(cancel ? 'Cancel tournament' : 'Leave tournament', cancel ? "Couldn't cancel it. Try again in a moment." : "Couldn't leave. Try again in a moment.", async (st) => {
    await ST.c!.tourneys.leaveOrCancel(address, cancel, st);
    return cancel ? 'Cancelled. Everyone who registered gets their entry fee back.' : 'You left. Your entry fee is back in your game balance.';
  }, () => void loadList());
}

// ------------------------------------------------------------------ host

const optRow = (label: string, items: string[], on: number, a: string): string =>
  `<div class="v2-hrow"><span class="v2-hl">${label}</span><div class="v2-row v2-wrap v2-hopts">${chips(items.map((x, i) => [String(i), x] as [string, string]), String(on), a)}</div></div>`;

const startText = (m: number): string => (m < 60 ? `${m} min` : `${m / 60} h`);

const hostPage: ScreenDef = {
  id: 'sol-tourney-host',
  back: 'sol-tourneys',
  input: { stname: '' },
  open() {
    hostPage.input = { stname: ST.name };
    void ready();
  },
  render() {
    const top = topBar('Host a SOL Tournament');
    if (!onchain()) return top + chainOnly();
    if (!ST.c)
      return top + `<div class="v2-panel v2-col" style="flex:1">${ST.loadErr ? `<div class="v2-empty">${ico('sol', 4)}<span>${esc(ST.loadErr)}</span>${btn('Try again', 'sth-retry', { h: 'blue' })}</div>` : loadingBox('Getting ready…')}</div>`;
    const { PLAYERS, FEES, PRIZES, START_MINUTES } = ST.c.tourneys.choices;
    const sol = (units: bigint): string => chainMoney().format(units);
    const speeds = [...ST.c.tourneys.choices.SPEED_LABELS];
    const fee = FEES[ST.fee]!;
    const prize = PRIZES[ST.prize]!;
    const name = (hostPage.input?.stname ?? ST.name).trim();
    return top + `<div class="v2-thost v2-scroll v2-sth">
  <div class="v2-panel v2-col v2-hform v2-scroll"><b class="v2-h">Host a SOL tournament</b>
    <div class="v2-hrow"><span class="v2-hl">Name</span>${input('stname', hostPage.input?.stname ?? ST.name, 'Name your tournament', { cls: 'v2-grow', max: 40 })}</div>
    ${optRow('Speed', speeds, ST.speed, 'sth-speed')}
    ${optRow('Most players', PLAYERS.map(String), ST.players, 'sth-players')}
    ${optRow('Entry fee', FEES.map((f) => (f === 0n ? 'Free' : sol(f))), ST.fee, 'sth-fee')}
    ${optRow('Your prize', PRIZES.map((p) => (p === 0n ? 'None' : `+${sol(p)}`)), ST.prize, 'sth-prize')}
    ${optRow('Starts in', START_MINUTES.map(startText), ST.start, 'sth-start')}
    ${optRow('Visibility', ['Public', 'Private (code)'], ST.isPrivate ? 1 : 0, 'sth-vis')}
    <div class="v2-xs v2-mut">${ST.isPrivate ? "Private tournaments aren't listed: players join with a 6-character code you share." : 'Anyone can find and register for it.'}</div>
  </div>
  <div class="v2-panel v2-col v2-hsum"><b class="v2-h">Summary</b>
    <div class="v2-kv"><span>Name</span><b class="v2-ellip">${esc(name || 'Your tournament')}</b></div>
    <div class="v2-kv"><span>Speed</span><b>${esc(speeds[ST.speed] ?? '')}</b></div>
    <div class="v2-kv"><span>Players</span><b>2 to ${PLAYERS[ST.players]}</b></div>
    <div class="v2-kv"><span>Entry</span>${fee === 0n ? '<b>Free</b>' : solAmt(fee)}</div>
    <div class="v2-kv"><span>Your prize</span>${prize === 0n ? '<b>None</b>' : solAmt(prize)}</div>
    <div class="v2-kv"><span>Starts in</span><b>${startText(START_MINUTES[ST.start]!)}</b></div>
    <div class="v2-kv"><span>Payout</span><b>1st 60% · 2nd 40%</b></div>
    <div class="v2-kv"><span>Open cost</span><b>${ico('sol', 1)} about 0.03 SOL</b></div>
    <div class="v2-grow"></div>
    <div class="v2-xs v2-mut">You approve once in your wallet.${prize > 0n ? ' Your prize comes from your game balance.' : ''} If fewer than 2 players register, everyone is refunded.</div>
    ${btn('Create Tournament', 'sth-create', { h: 'gold', c: 'lg w' })}
  </div>
</div>`;
  },
  actions: {
    'sth-retry': () => void ready(),
    'sth-speed': (v) => void (ST.speed = Number(v)),
    'sth-players': (v) => void (ST.players = Number(v)),
    'sth-fee': (v) => void (ST.fee = Number(v)),
    'sth-prize': (v) => void (ST.prize = Number(v)),
    'sth-start': (v) => void (ST.start = Number(v)),
    'sth-vis': (v) => void (ST.isPrivate = v === '1'),
    'sth-create': () => {
      if (!signedIn()) return host().show('Login');
      const name = (hostPage.input?.stname ?? ST.name).trim();
      if (!name) return ui().message('Host a SOL tournament', 'Give your tournament a name.');
      ST.name = name.slice(0, 40);
      let code: string | null = null;
      void solTask('Host a SOL tournament', "Couldn't create the tournament. Nothing was charged. Try again in a moment.", async (st) => {
        code = await ST.c!.tourneys.create({ name: ST.name, speed: ST.speed, players: ST.players, fee: ST.fee, prize: ST.prize, start: ST.start, isPrivate: ST.isPrivate }, st);
        return null;
      }).then((ok) => {
        if (!ok || ui().currentId !== 'sol-tourney-host') return;
        ST.list = null;
        ui().back();
        const c = code as string | null;
        if (c) {
          copy(c, 'Code copied');
          ui().message('Tournament created', `Its code is <b class="v2-goldc">${esc(c)}</b> (copied). Send it to the players you want.`);
        } else ui().message('Tournament created', 'It shows in the list within a few seconds.');
      });
    },
  },
};

export function solTourneyScreens(): ScreenDef[] {
  return [list, hostPage];
}

/** For the Tournaments note: opens the SOL tournaments list. */
export const openSolTourneys = (): void => ui().show('sol-tourneys');
