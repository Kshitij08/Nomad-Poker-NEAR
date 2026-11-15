/**
 * Agents (atlas: Redesign v2 › Agents). One tab row: Overview · Strategy · History (the Agent's pages, around a
 * "My Agents" list) · My twin · Marketplace · Coach. Twin, Marketplace and Coach were Unity pop-ups
 * (the old menu's Market dialogs); they are pages here with the same backend calls and copy / publish rules.
 *
 * The backend runs ONE Agent per player: the list shows it, and "New agent" says so. It plays Coins tables in both modes;
 * NEAR copy trading (backing pro agents with NEAR) is the "Back a pro" tab (backing.ts).
 */
import { AgentStrategyWords as W, STRATEGY_BLURBS, STRATEGY_NAMES, STRATEGY_PRESETS, BRAIN_SMART, readNumberField, type AgentDeploymentSummary } from '@nomad/engine/agents';
import type { AgentsService } from '../../agents/agentsService';
import { StakeCatalog } from '@nomad/engine/stakes/stakes';
import type { AgentStrategyState } from '@nomad/engine/agents';
import { stopReasonLabel } from '../../agents/nomad/agentsPartial';
import {
  applyProfileTo, marketApi, marketState, rememberCopy, solProfile,
  format0Hash, TWIN_MIN_DECISIONS, COACH_MIN_HANDS, type AgentStrategyLike,
} from '../../menu/market';
import { btn, esc, fmt, act, tabs, chips, seg, slider, input, outFormats, out, type V2Screen } from '../core';
import { ico } from '../icons';
import { ui, host, app, S, topBar, setMode, signedIn, coins, prompt, friendlyError } from '../ctx';
import type { ScreenDef } from '../install';
import { startWatch } from '../../economy/party';
import { backingScreen } from './backing';
import './agents.css';

type J = Record<string, unknown>;
const agents = (): AgentsService | undefined => S('agents');
const strat = (): AgentStrategyState | undefined => S('agentStrategy');
const num = (v: unknown): number => Number(v ?? 0);
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const signed = (v: number): string => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
const tone = (v: number): string => (v > 0 ? 'v2-good' : v < 0 ? 'v2-badc' : '');
const pctTxt = (v: unknown): string => Math.round(num(v) * 100) + '%';

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ------------------------------------------------------------------ shared chrome

/** One tab row for every Agents page (no tabs inside tabs): the Agent's own pages, then Twin, Marketplace, Coach. */
const MAIN_TABS: [string, string][] = [
  ['ag-overview', 'Overview'], ['ag-strategy', 'Strategy'], ['ag-history', 'History'],
  ['ag-twin', 'My twin'], ['ag-market', 'Marketplace'], ['ag-back', 'Back a pro'], ['ag-coach', 'Coach'],
];

function agMain(on: string): string {
  return topBar('Agents') + `<div class="v2-ag-main">${tabs(MAIN_TABS, on, 'tab')}</div>`;
}

/** Shared actions of every Agents page. */
const common: Record<string, (v: string) => void | Promise<void>> = {
  mode: (v) => setMode(v),
};

/** Polls the Agent while an Agents page is open (agentsPartial's PaintAgentStatus polling). */
let pollTimer = 0;
function startPolling(): void {
  stopPolling();
  const tick = () => {
    const svc = agents();
    if (!svc) return;
    void svc.deploy.refreshProgress();
    if (svc.agentActive) void svc.deploy.pollAndSettle();
  };
  tick();
  pollTimer = window.setInterval(tick, 5000);
}
function stopPolling(): void {
  window.clearInterval(pollTimer);
  pollTimer = 0;
}

function agentColor(pill: string): string {
  return pill === 'Playing' ? '#58b6ff' : pill === 'Stopping' ? '#ffb547' : '#8048f5';
}

/** Left "My Agents" list and the selected Agent's header with the sub-tabs. */
function agShell(sub: string, inner: string): string {
  const svc = agents();
  const s = strat();
  const st = svc?.status() ?? { active: false, pill: 'Idle', line: 'Not playing', progress: null };
  const name = s?.agentName ?? 'Agent';
  const net = st.progress ? st.progress.NetPnl : sumNet();
  const card = `<button class="v2-ag-card on"${act('tab', 'ag-overview')}><div class="v2-row" style="gap:.6em"><div class="v2-ag-badge" style="background:${agentColor(st.pill)}">${ico('robot', 2)}</div><div class="v2-grow"><b class="v2-ellip" style="display:block">${esc(name)}</b><div class="v2-xs ${st.pill === 'Playing' ? 'v2-good' : 'v2-mut'}">${st.pill === 'Playing' ? ico('dot', 0.7) + ' ' : ''}${esc(st.pill)}</div></div></div><div class="v2-row v2-xs v2-mut v2-ag-cardf"><span>${esc(s?.styleName ?? '')}</span><b class="${tone(net)}">${signed(net)}</b></div></button>`;
  const color = st.pill === 'Playing' ? 'v2-good' : 'v2-mut';
  return agMain(sub) + `<div class="v2-ag-shell">
  <div class="v2-panel v2-ag-list"><b class="v2-h">My Agents <span class="v2-sm v2-mut" style="font-family:var(--v2-ui)">1</span></b>${card}</div>
  <div class="v2-panel v2-ag-right">
    <div class="v2-row v2-ag-head"><div class="v2-ag-badge big" style="background:${agentColor(st.pill)}">${ico('robot', 2.5)}</div>
      <div class="v2-grow"><div class="v2-row"><b class="v2-ellip" style="font-size:1.4em">${esc(name)}</b>${btn('Rename', 'ag-rename', { h: 'ghost', c: 'sm' })}</div><div class="v2-sm ${color} v2-ellip">${esc(st.line)}</div></div>
</div>
    <div class="v2-ag-inner v2-scroll">${inner}</div>
  </div></div>`;
}

function sumNet(): number {
  let n = 0;
  for (const x of agents()?.history?.Sessions ?? []) n += x.NetPnl;
  return n;
}

/** Actions shared by the three Agent sub-pages. */
const shellActions: Record<string, (v: string) => void | Promise<void>> = {
  ...common,
  'ag-rename': () => {
    const svc = agents();
    if (!svc) return;
    prompt('Rename your Agent', 'Other players see this name at the table.', 'Agent name', svc.strategy.agentName, 'Save', (raw) => {
      const err = svc.rename(raw);
      if (err) ui().message('Rename your Agent', esc(friendlyError(err, "Couldn't rename your Agent. Try again.")));
      ui().render();
    }, 20);
  },
  'ag-new': () =>
    ui().message('One Agent for now', 'Each account runs one Agent for now. Change its name, playstyle and budget on Overview and Strategy; more Agents per account are coming.', 'OK'),
};

// ------------------------------------------------------------------ Overview

/** The table an Agent with this bankroll plays (the server's rule, StakeCatalog.forAgentBankroll). */
function agentTableLabel(bankroll: string): string {
  const b = Math.max(0, Math.trunc(Number(String(bankroll).replace(/[,\s]/g, '')) || 0));
  const t = StakeCatalog.forAgentBankroll(b);
  return `${fmt(b)} Coins → blinds ${t.blindsLabel}`;
}

const fields: Record<string, string> = { bankroll: '5000', maxHands: '100', maxMinutes: '60', stopLoss: '2000', profitTarget: '0' };

const overview: ScreenDef = {
  id: 'ag-overview',
  replaces: ['Agents_Overview'],
  input: fields,
  open() {
    startPolling();
    void agents()?.refreshHistory().then(() => ui().render());
  },
  close: stopPolling,
  render() {
    const svc = agents();
    const s = strat();
    if (!svc || !s) return agMain('ag-overview') + `<div class="v2-panel v2-empty">${ico('robot', 6)}Agents aren't available right now. Try again later.</div>`;
    const st = svc.status();
    const sessions = svc.history?.Sessions ?? [];
    let hands = 0;
    for (const x of sessions) hands += x.HandsPlayed;
    const net = sumNet();
    const p = st.progress;
    const copying = marketState.copiedStrategyId ? `<div class="v2-xs v2-goldc">Copying ${esc(marketState.copiedName ?? 'a strategy')} · creator 8%, Nomad 2% of profit</div>` : '';
    const live = st.active
      ? `<div class="v2-card v2-row" style="gap:.8em">${ico('eye', 2.2, 'color:#2ee38a')}<div class="v2-grow"><div class="v2-cap">Live table</div><div style="font-weight:800">${p ? `${esc(p.AssignedTable || 'Coins table')} · hand ${p.HandsPlayed} / ${p.MaxHands} · <span class="${tone(p.NetPnl)}">${signed(p.NetPnl)}</span>` : 'Looking for a table…'}</div></div>${p?.AssignedTable && p.phase === 'playing' ? btn(`${ico('eye', 0.9)} Watch live`, 'ag-watch', { h: 'violet', c: 'sm', v: p.AssignedTable }) : ''}</div>`
      : `<div class="v2-card v2-row" style="gap:.8em">${ico('robot', 2.2)}<div class="v2-grow"><div class="v2-cap">Not playing</div><div style="font-weight:800">Deploy to send it to a Coins table</div></div></div>`;
    const field = (k: string, label: string) => `<label class="v2-row v2-ag-field"><span class="v2-grow">${label}</span>${input(k, fields[k] ?? '', '0', { cls: 'v2-num', type: 'text', max: 7 })}</label>`;
    const inner = `<div class="v2-ag-ov">
  <div class="v2-col v2-ag-ovl">
    <button class="v2-card v2-ag-strat"${act('tab', 'ag-strategy')}><div class="v2-cap">Current strategy</div><div style="font-size:1.3em;font-weight:900">${esc(s.styleName)}</div><div class="v2-mut v2-sm">${esc(s.shortSummary)}</div>${copying}</button>
    <div class="v2-card"><div class="v2-cap">Recent performance</div><div class="v2-row v2-ag-stats">${[[String(svc.history?.Total ?? sessions.length), 'Sessions'], [fmt(hands), 'Hands'], [signed(net), 'Net result']].map(([v, l], i) => `<div><b class="${i === 2 ? tone(net) : ''}" style="font-size:1.5em">${v}</b><div class="v2-xs v2-mut">${l}</div></div>`).join('')}</div>${btn('View history', 'tab', { h: 'ghost', c: 'sm', v: 'ag-history' })}</div>
    ${live}
  </div>
  <div class="v2-card v2-col v2-ag-setup"><div class="v2-cap">Session setup</div>
    ${field('bankroll', 'Bankroll (Coins)')}${field('maxHands', 'Max hands')}${field('maxMinutes', 'Max minutes')}${field('stopLoss', 'Stop loss')}${field('profitTarget', 'Profit target')}
    <div class="v2-xs v2-mut">Plays Coins tables from your Coins (you have ${fmt(coins())}), at a table sized to its bankroll: ${esc(agentTableLabel(fields.bankroll))}. Stop it any time; its stack comes back to your Coins. 0 = off. Limits are checked after each hand, so one big pot can go past the stop loss or target. Up to 5,000 hands and 24 hours.</div>
    <div class="v2-grow"></div>
    ${st.active ? btn(st.pill === 'Stopping' ? 'Stopping…' : 'Stop Agent', 'ag-deploy', { h: 'red', c: 'lg w', dis: st.pill === 'Stopping' }) : btn('Review &amp; Deploy', 'ag-deploy', { h: 'gold', c: 'lg w' })}
  </div></div>`;
    return agShell('ag-overview', inner);
  },
  actions: {
    ...shellActions,
    'ag-deploy': () => deployOrStop(),
    // Spectate the table your Agent sits at (no seat, no Coins); Leave brings you back to the menu.
    'ag-watch': (v) => {
      if (v) startWatch(host(), app(), String(v));
    },
  },
};

function deployOrStop(): void {
  const svc = agents();
  if (!svc) return;
  if (!signedIn()) return host().show('Login');
  if (svc.agentActive) {
    ui().message(`Stop ${esc(svc.strategy.agentName)}`, 'It leaves after the current hand and its stack comes back to your Coins.', 'Stop', () =>
      void runAgent(() => svc.deploy.stop()), 'Keep playing', undefined, 'red');
    return;
  }
  const config = svc.buildConfig({
    bankroll: readNumberField(fields.bankroll, 5000),
    maxHands: readNumberField(fields.maxHands, 100),
    maxMinutes: readNumberField(fields.maxMinutes, 60),
    stopLoss: readNumberField(fields.stopLoss, 0),
    profitTarget: readNumberField(fields.profitTarget, 0),
  }, marketState.copiedStrategyId);
  const have = coins();
  if (config.Bankroll > have) {
    ui().message('Not enough Coins', `The bankroll is ${fmt(config.Bankroll)} Coins; you have ${fmt(have)}.`);
    return;
  }
  const name = esc(svc.strategy.agentName);
  ui().message(`Deploy ${name}`,
    `${esc(svc.strategy.styleName)} strategy, ${fmt(config.Bankroll)} Coins bankroll, up to ${config.MaxHands} hands or ${Math.trunc(config.MaxRuntimeSeconds / 60)} minutes.`,
    'Deploy', () => void runAgent(() => svc.deploy.deploy(config), () => ui().message('Agent deployed', `<b>${name}</b> is deployed.`)), 'Cancel');
}

async function runAgent(op: () => Promise<string | null>, onOk?: () => void): Promise<void> {
  try {
    const err = await op();
    if (err) ui().message('Agents', esc(friendlyError(err, "That didn't work. Try again in a moment.")));
    else onOk?.();
  } catch (e) {
    ui().message('Agents', esc(friendlyError(e, "That didn't work. Try again in a moment.")));
  }
  ui().render();
}

/** The playstyle "Reset to" returns to: the last preset the player picked (edits turn the style into Custom). */
const PRESET_KEY = 'nomad.ui2.agentPreset';
function rememberPreset(i: number): void {
  try {
    localStorage.setItem(PRESET_KEY, String(i));
  } catch {
    /* storage blocked */
  }
}
function resetPreset(style: number): number {
  if (style < STRATEGY_PRESETS.length) {
    rememberPreset(style); // a preset in use (picked here or elsewhere) is the one to come back to
    return style;
  }
  let i = 0;
  try {
    i = Number(localStorage.getItem(PRESET_KEY) ?? 0);
  } catch {
    /* storage blocked */
  }
  return Number.isInteger(i) && i >= 0 && i < STRATEGY_PRESETS.length ? i : 0;
}

// ------------------------------------------------------------------ Strategy

/** -1 = all rounds, 0 = before the flop, 1 = after. */
let round = -1;
let fine = false;

const rev = (i: number) => W.Reversed[i]!;
const toT = (i: number, v: number): number => {
  const min = W.Min[i]!, max = W.Max[i]!;
  const c = Math.min(max, Math.max(min, v));
  return ((rev(i) ? max - c : c - min) / (max - min)) * 100;
};
const fromT = (i: number, t: number): number => {
  const min = W.Min[i]!, max = W.Max[i]!;
  const f = t / 100;
  return rev(i) ? max - f * (max - min) : min + f * (max - min);
};

function shownValues(s: AgentStrategyState): readonly number[] {
  const inUse = s.roundValues(0) != null || s.roundValues(1) != null;
  return (round >= 0 ? s.roundValues(round) : inUse ? s.roundValues(0) : null) ?? s.values;
}

function riskText(s: AgentStrategyState): [string, string] {
  const pre = W.before(s.values, s.streets);
  const post = W.after(s.values, s.streets);
  const r = W.riskOf(W.swing(pre, post));
  return [r, W.riskLine(r)];
}

// Live tags next to the sliders (read the state the drag just changed).
outFormats['ag-hands'] = () => {
  const s = strat();
  return s ? 'Plays ' + W.oneIn(W.handsPlayed(W.before(s.values, s.streets))).replace('about ', '') : '';
};
outFormats['ag-press'] = () => {
  const s = strat();
  return s ? W.pressureWord(W.dialForPressure(W.after(s.values, s.streets))) : '';
};
for (let i = 0; i < 5; i++) outFormats['ag-ft' + i] = () => {
  const s = strat();
  return s ? W.tag(i, shownValues(s)) : '';
};
outFormats['ag-sum'] = () => strat()?.summary ?? '';

const strategy: ScreenDef = {
  id: 'ag-strategy',
  replaces: ['Agents_Strategy'],
  open() {
    startPolling();
  },
  close: stopPolling,
  render() {
    const s = strat();
    if (!s) return agMain('ag-strategy') + `<div class="v2-panel v2-empty">${ico('robot', 6)}Agents aren't available right now. Try again later.</div>`;
    const presets = STRATEGY_NAMES.slice(0, STRATEGY_PRESETS.length).map((n, i) =>
      `<button class="v2-card v2-row v2-ag-pre${s.style === i ? ' on' : ''}"${act('st-pick', i)}>${ico(['style-autopilot', 'style-guardian', 'style-trapper', 'style-daredevil'][i] ?? 'robot', 2)}<div class="v2-grow"><b>${esc(n)}</b><div class="v2-xs v2-mut">${esc(STRATEGY_BLURBS[i] ?? '')}</div></div></button>`).join('');
    const smart = s.brain === BRAIN_SMART;
    const main = s.values;
    const [risk, riskLine] = riskText(s);
    const dial = (n: string, lo: string, hi: string, key: string, v: number, fmtKey: string) =>
      `<div class="v2-row v2-ag-dial"><b class="v2-ag-dn">${n}</b><span class="v2-sm v2-mut">${lo}</span><div class="v2-grow">${slider(key, v * 100, n)}</div><span class="v2-sm v2-mut">${hi}</span><span class="v2-pill v2-ag-tag">${out(key, 0, fmtKey)}</span></div>`;
    let body = dial('Hands played', 'Tight', 'Loose', 'st-hands', W.dialForHands(main), 'ag-hands') +
      dial('Pressure', 'Calm', 'Pushy', 'st-press', W.dialForPressure(W.after(main, s.streets)), 'ag-press');
    const inUse = s.roundValues(0) != null || s.roundValues(1) != null;
    if (fine) {
      const names = ['All', 'Before the flop', 'After the flop'];
      const rchips = [-1, 0, 1].map((r) => `<button class="v2-chip${round === r ? ' on' : ''}"${act('st-round', r)}>${names[r + 1]}${r >= 0 && s.roundValues(r) != null ? ' *' : ''}</button>`).join('');
      const own = round >= 0 && s.roundValues(round) != null;
      const line = round < 0
        ? (inUse ? 'Editing every round: a change here applies before and after the flop. Pick one to edit it alone.' : 'Editing every round. Pick before or after the flop to give it its own settings (marked *).')
        : own ? `Editing ${names[round + 1]!.toLowerCase()} only.` : `${names[round + 1]} uses the main settings. Move a slider to give it its own.`;
      const shown = shownValues(s);
      body += `<div class="v2-row v2-wrap" style="gap:.5em;margin-top:.6em">${rchips}${own ? `<button class="v2-chip"${act('st-usemain')}>Use main</button>` : ''}</div><div class="v2-xs v2-mut" style="margin:.3em 0 .4em">${line}</div>` +
        [0, 1, 2, 3, 4].map((i) => `<div class="v2-row v2-ag-dial"><b class="v2-ag-dn">${esc(W.Names[i]!)}</b><div class="v2-grow">${slider('st-ft' + i, toT(i, shown[i]!), W.Names[i]!)}</div><span class="v2-pill v2-ag-tag wide">${out('st-ft' + i, 0, 'ag-ft' + i)}</span></div>`).join('');
    }
    const inner = `<div class="v2-ag-pres">${presets}</div>
  <div class="v2-card v2-ag-stc">
    <div class="v2-sm" style="margin-bottom:.4em">${out('ag-sum', 0, 'ag-sum')}</div>
    ${smart ? '' : '<div class="v2-xs v2-mut">Plays like you (My Twin). Pick a playstyle above to go back to the Agent\'s own play.</div>'}
    ${body}
    <div class="v2-xs v2-mut" style="margin-top:.4em"><b>Risk: ${esc(risk)}.</b> ${esc(riskLine)}</div>
  </div>
  <div class="v2-row v2-ag-stbar" style="margin-top:.8em"><button class="v2-b ghost sm"${act('st-fine')} aria-expanded="${fine}">${fine ? 'Hide fine-tuning' : 'Fine-tune'} ${ico(fine ? 'chevup' : 'chev', 0.9)}</button>${inUse && !fine ? '<span class="v2-xs v2-mut v2-ag-inuse">Different play before / after the flop: in use</span>' : ''}<div class="v2-grow"></div>${btn('Reset to ' + esc(STRATEGY_NAMES[resetPreset(s.style)] ?? ''), 'st-reset', { h: 'ghost' })}${btn('Save', 'st-save', { h: 'gold' })}</div>`;
    return agShell('ag-strategy', inner);
  },
  slide(key, v, done) {
    const s = strat();
    if (!s) return;
    const t = v / 100;
    if (key === 'st-hands') s.setHandsDial(t);
    else if (key === 'st-press') s.setPressureDial(t);
    else if (key.startsWith('st-ft')) {
      const i = Number(key.slice(5));
      const created = round >= 0 && s.roundValues(round) == null;
      s.setSlider(i, fromT(i, v), round);
      if (created || done) ui().render();
      return;
    }
    if (done) ui().render();
  },
  actions: {
    ...shellActions,
    'st-pick': (v) => {
      rememberPreset(Number(v));
      strat()?.pickStyle(Number(v));
      round = -1;
    },
    'st-round': (v) => {
      round = Number(v);
    },
    'st-usemain': () => {
      if (round >= 0) strat()?.useMain(round);
    },
    'st-fine': () => {
      fine = !fine;
      if (!fine) round = -1;
    },
    'st-reset': () => {
      const s = strat();
      if (s) s.pickStyle(resetPreset(s.style));
      round = -1;
    },
    'st-save': () => {
      const s = strat();
      ui().show('ag-overview', undefined, false);
      if (s) ui().toast(`${s.agentName} plays ${s.styleName} from its next session`);
    },
  },
};

// ------------------------------------------------------------------ Session History

let histFilter = 'all';

const history: ScreenDef = {
  id: 'ag-history',
  replaces: ['Agents_SessionHistory'],
  open() {
    startPolling();
    const svc = agents();
    void svc?.refreshHistory().then(() => {
      if (svc.reopenHands) svc.consumeReopen();
      ui().render();
    });
  },
  close: stopPolling,
  render() {
    const svc = agents();
    const sessions: AgentDeploymentSummary[] = svc?.history?.Sessions ?? [];
    const total = svc?.history?.Total ?? sessions.length;
    let hands = 0;
    let net = 0;
    for (const x of sessions) {
      hands += x.HandsPlayed;
      net += x.NetPnl;
    }
    if (!sessions.length)
      return agShell('ag-history', `<div class="v2-empty">${ico('robot', 6)}No sessions yet. Deploy your Agent from Overview.${btn('Go to Overview', 'go', { h: 'gold', v: 'ag-overview' })}</div>`);
    const rows = sessions
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => histFilter === 'all' || (histFilter === 'p' ? x.NetPnl >= 0 : x.NetPnl < 0))
      .map(({ x, i }) => {
        const { label } = stopReasonLabel(x.StopReason);
        const cls = label === 'Completed' || label === 'Hand limit' || label === 'Time limit' ? 'ok' : label === 'Target hit' ? 'gold' : 'bad';
        return `<button class="v2-ag-gt v2-ag-row"${act('hist-open', i)}><b><span class="v2-ag-k">Session </span>#${total - i}</b><span class="v2-num"><span class="v2-ag-k">Start </span>${fmt(x.StartingBankroll)}</span><span class="v2-num"><span class="v2-ag-k">End </span>${fmt(x.EndingStack)}</span><span class="v2-num"><span class="v2-ag-k">Hands </span>${x.HandsPlayed}</span><span><span class="v2-ag-k">Time </span>${duration(x.RuntimeSeconds)}</span><b class="v2-num ${tone(x.NetPnl)}">${signed(x.NetPnl)}</b><span><span class="v2-pill ${cls}">${esc(label)}</span></span></button>`;
      })
      .join('');
    const inner = `<div class="v2-row v2-ag-tiles">${[[String(total), 'Sessions'], [fmt(hands), 'Total hands'], [signed(net), 'Net result']].map(([v, l], i) => `<div class="v2-card v2-grow"><b style="font-size:1.6em" class="${i === 2 ? tone(net) : ''}">${v}</b><div class="v2-sm v2-mut">${l}</div></div>`).join('')}</div>
  <div class="v2-row" style="margin-top:.7em;gap:.5em"><b class="v2-grow" style="font-size:1.1em">Sessions</b>${chips([['all', 'All'], ['p', 'Profits'], ['l', 'Losses']], histFilter, 'hist-filter')}</div>
  <div class="v2-ag-gt v2-ag-hdr"><span>Session</span><span>Start</span><span>End</span><span>Hands</span><span>Duration</span><span>Net</span><span>Status</span></div>
  ${rows || '<div class="v2-empty">No sessions match this filter.</div>'}
  <div class="v2-xs v2-mut" style="margin-top:.5em">Tap a session to see its hands and replay them.</div>`;
    return agShell('ag-history', inner);
  },
  actions: {
    ...shellActions,
    'hist-filter': (v) => {
      histFilter = v;
    },
    'hist-open': (v) => agents()?.openSessionHands(Number(v)),
  },
};

// ------------------------------------------------------------------ backend pages (Twin, Marketplace, Coach)

interface Load {
  /** 'off': this build has no Nomad API to ask (retrying cannot help). */
  state: 'idle' | 'loading' | 'ok' | 'error' | 'off';
  data: J | null;
  error: string;
}
const newLoad = (): Load => ({ state: 'idle', data: null, error: '' });

/**
 * What My twin, the Marketplace and the Coach say when no Nomad API is configured (no `?api=` and no VITE_API_URL):
 * they are server features (the API keeps the recorded decisions, hands and published strategies), with no local
 * stand-in. A dev build says how to start one; the Agent's own pages (Overview, Strategy, History) still work.
 */
export function agentApiMissing(dev = !!import.meta.env?.DEV): string {
  return dev
    ? 'My twin, the Marketplace and the Coach need the Nomad API, and this page has none. In apps/api run "npm run db:migrate:local" once, then "npm run dev", and open the game with ?api=local (or ?api=staging).'
    : "My twin, the Marketplace and the Coach need the Nomad server, and this version of the game isn't connected to it. Your Agent's Overview, Strategy and History still work.";
}

/** GET (or POST) on the Agent backend into `l`, then repaint. No API configured: say what is missing. */
async function fetchInto(l: Load, method: string, path: string, json: string | null = null, auth = true): Promise<void> {
  const api = marketApi(app());
  if (!api) {
    l.state = 'off';
    l.error = agentApiMissing();
    ui().render();
    return;
  }
  l.state = 'loading';
  ui().render();
  try {
    const r = await api.call(method, path, json, auth);
    if (!r.ok) {
      l.state = 'error';
      l.error = r.error;
    } else {
      l.data = JSON.parse(r.body) as J;
      l.state = 'ok';
    }
  } catch (e) {
    l.state = 'error';
    l.error = friendlyError(e, "Agents aren't available right now. Try again in a moment.");
  }
  ui().render();
}

function loadBody(l: Load, icon: string): string | null {
  if (l.state === 'loading' || l.state === 'idle') return `<div class="v2-empty">${ico(icon, 5)}Loading…</div>`;
  if (l.state === 'off') return `<div class="v2-empty">${ico(icon, 5)}<span class="v2-ag-off">${esc(l.error)}</span></div>`;
  if (l.state === 'error') return `<div class="v2-empty">${ico(icon, 5)}${esc(l.error)}${btn('Try again', 'reload', { h: 'ghost' })}</div>`;
  return null;
}

// ---- My Twin

const twinLoad = newLoad();
const twin: ScreenDef = {
  id: 'ag-twin',
  back: 'main',
  open() {
    void fetchInto(twinLoad, 'GET', '/api/style/twin');
  },
  render() {
    const wait = loadBody(twinLoad, 'twin');
    if (wait) return agMain('ag-twin') + `<div class="v2-panel v2-body">${wait}</div>`;
    const t = twinLoad.data!;
    const n = num(t.decisions);
    const s = strat();
    const ready = n >= TWIN_MIN_DECISIONS;
    const p = (t.profile ?? {}) as J;
    const v = [num(p.foldBelow), num(p.raiseAbove), num(p.aggression), num(p.bluffChance), num(p.raiseFractionOfPot)];
    const left = ready
      ? `<div class="v2-row" style="gap:1.6em;justify-content:center"><div><b style="font-size:1.8em">${pctTxt(t.confidence)}</b><div class="v2-xs v2-mut">sure</div></div><div><b style="font-size:1.8em">${t.matchRate == null ? '…' : pctTxt(t.matchRate)}</b><div class="v2-xs v2-mut">plays like you</div></div></div>
        <span class="v2-mut">Learned from ${fmt(n)} of your decisions</span>
        <div class="v2-row v2-wrap" style="justify-content:center">${((t.tags as string[] | undefined) ?? []).map((x) => `<span class="v2-pill">${esc(x)}</span>`).join('')}</div>
        <div class="v2-grow"></div>${btn('Use My Twin', 'twin-use', { h: 'gold', c: 'lg w' })}${btn('Publish to Marketplace', 'twin-publish', { h: 'violet', c: 'w' })}`
      : `<span class="v2-mut">Your twin learns how you play from your Coins hands.</span><div class="v2-bar" style="width:100%;flex:none;height:.8em"><i style="width:${Math.min(100, (n / TWIN_MIN_DECISIONS) * 100)}%;background:linear-gradient(90deg,#8a5cff,#14f1c5)"></i></div><b>${n} of ${TWIN_MIN_DECISIONS} decisions</b><div class="v2-grow"></div>${btn('Play a Coins table', 'twin-play', { h: 'gold', c: 'w' })}`;
    const traits = [0, 1, 2, 3, 4].map((i) => `<div class="v2-row v2-ag-trait"><b class="v2-ag-dn">${esc(W.Names[i]!)}</b><div class="v2-bar" style="height:.7em"><i style="width:${ready ? toT(i, v[i]!) : 15}%;background:linear-gradient(90deg,#8a5cff,#14f1c5)"></i></div><span class="v2-pill v2-ag-tag wide">${ready ? esc(s?.tag(i, v) ?? Math.round(v[i]! * 100) + '%') : 'learning…'}</span></div>`).join('');
    return agMain('ag-twin') + `<div class="v2-ag-two">
  <div class="v2-panel v2-col v2-ag-twinl">${ico('twin', 8)}<b class="v2-h" style="font-size:1.6em">Your Twin</b>${left}</div>
  <div class="v2-panel v2-col v2-scroll v2-ag-twinr"><b class="v2-h">What it learned</b>${traits}<div class="v2-card v2-sm v2-mut">Your twin plays your style at Coins tables while you are away. It never sees other players' hidden cards.</div></div></div>`;
  },
  actions: {
    ...common,
    reload: () => void fetchInto(twinLoad, 'GET', '/api/style/twin'),
    'twin-use': () => {
      const s = strat();
      const p = (twinLoad.data?.profile ?? {}) as J;
      if (!s) return;
      marketState.copiedStrategyId = null;
      marketState.copiedName = null;
      applyProfileTo(s as unknown as AgentStrategyLike, p);
      ui().message('My Twin', 'Your Agent now plays like you (Custom on the Strategy tab). Deploy it from Overview.', 'Go to Overview', () => ui().show('ag-overview'));
    },
    'twin-publish': () => publish(true),
    'twin-play': () => host().show('TableSelect_TownLobby'),
  },
};

// ---- Publish (Twin or the Strategy tab)

function publish(fromTwin: boolean): void {
  prompt('Publish a strategy', fromTwin ? "Name your twin's strategy. Copiers pay you 8% of the profit they make with it." : 'Name the strategy on your Strategy tab. Copiers pay you 8% of the profit they make with it.',
    'Strategy name', '', 'Publish', (name) => {
      if (!name) return;
      const body = fromTwin ? { name, fromTwin: true } : { name, profile: solProfile(strat() as unknown as AgentStrategyLike) };
      const l = newLoad();
      void fetchInto(l, 'POST', '/api/strategies', JSON.stringify(body)).then(() => {
        if (l.state === 'ok') {
          const r = l.data!;
          ui().message('Published', `"${esc(r.name)}" (v${esc(r.version)}) is in the marketplace. You get 8% of copiers' profit; Nomad 2%.`);
          reloadMarket();
        } else ui().message('Publish', esc(l.error));
      });
    }, 40);
}

// ---- Marketplace

let mktTab: 'browse' | 'mine' = 'browse';
let mktSort = '';
const mktLoad = newLoad();
const mineLoad = newLoad();

function reloadMarket(): void {
  if (!['styles', 'new', 'top', 'popular'].includes(mktSort)) mktSort = 'styles';
  if (mktTab === 'browse') void fetchInto(mktLoad, 'GET', '/api/strategies?sort=' + mktSort, null, false);
  else void fetchInto(mineLoad, 'GET', '/api/strategies/mine');
}

function copyStrategy(s: J): void {
  const st = strat();
  if (!st) return;
  marketState.copiedStrategyId = null;
  applyProfileTo(st as unknown as AgentStrategyLike, (s.profile ?? {}) as J);
  marketState.copiedStrategyId = String(s.strategyId);
  marketState.copiedName = String(s.name);
  rememberCopy(host());
  ui().message('Copying ' + esc(marketState.copiedName), `Your next Coins Agent plays "${esc(marketState.copiedName)}" by ${esc(s.creatorName)}. Deploy it from Overview. When it wins, 8% of the new profit goes to the creator and 2% to Nomad; changing the sliders stops copying.`);
}

function notYet(s: J): void {
  const rec = (s.record ?? {}) as J;
  const need = (s.listing ?? {}) as J;
  const bb = num(rec.bb100);
  ui().message(esc(s.name), `Not copyable yet. A strategy needs ${fmt(num(need.minHands))} hands over ${num(need.minDays)} days, and a result that beats Autopilot (+${num(need.house)} bb/100) by more than its margin. It has ${fmt(num(rec.hands))} hands at ${bb >= 0 ? '+' : ''}${bb} bb/100.`);
}

let mktItems: J[] = [];

function marketCard(s: J, i: number): string {
  const rec = (s.record ?? {}) as J;
  const copying = marketState.copiedStrategyId === (s.strategyId ?? null);
  const tags = [typeof s.style === 'string' ? s.style : '', ...(((s.tags as string[] | undefined) ?? []))].filter(Boolean).join(' · ');
  let stats: string;
  let action: string;
  if (typeof rec.bb100 === 'number') {
    const bb = num(rec.bb100), vs = num(rec.vsHouse);
    stats = `<div><b class="${tone(bb)}">${bb >= 0 ? '+' : ''}${format0Hash(bb)}</b><div class="v2-xs v2-mut">bb/100</div></div><div><b>${vs >= 0 ? '+' : ''}${format0Hash(vs)}</b><div class="v2-xs v2-mut">vs Autopilot</div></div><div><b>${Math.round(num(rec.swing))} bb</b><div class="v2-xs v2-mut">swing</div></div><div><b>${fmt(num(rec.hands))}</b><div class="v2-xs v2-mut">hands</div></div>`;
    action = copying ? btn('Copying', 'mkt-copy', { h: 'ghost', c: 'w', v: i }) : s.qualified ? btn('Copy', 'mkt-copy', { h: 'gold', c: 'w', v: i }) : btn('Not yet', 'mkt-notyet', { h: 'ghost', c: 'w dis', v: i });
  } else {
    const per = num(rec.per100Hands);
    stats = `<div><b class="${tone(per)}">${signed(per)}</b><div class="v2-xs v2-mut">per 100 hands</div></div><div><b>${num(rec.copiers)}</b><div class="v2-xs v2-mut">copiers</div></div><div><b>${fmt(num(rec.hands))}</b><div class="v2-xs v2-mut">hands</div></div>`;
    action = btn(copying ? 'Copying' : 'Copy', 'mkt-copy', { h: copying ? 'ghost' : 'gold', c: 'w', v: i });
  }
  return `<div class="v2-card v2-col v2-ag-mcard"><div class="v2-row">${ico('robot', 2.4)}<div class="v2-grow"><b class="v2-ellip" style="display:block;font-size:1.1em">${esc(s.name)}</b><div class="v2-xs v2-mut v2-ellip">v${esc(s.version)} · by ${esc(s.creatorName)}${s.verified ? ' · verified' : ''}</div></div></div>${tags ? `<span class="v2-pill" style="width:max-content;max-width:100%;overflow:hidden;text-overflow:ellipsis">${esc(tags)}</span>` : ''}<div class="v2-row v2-ag-mstats">${stats}</div>${action}</div>`;
}

const market: ScreenDef = {
  id: 'ag-market',
  back: 'main',
  open() {
    mktSort = '';
    reloadMarket();
  },
  render() {
    const sorts: [string, string][] = [['styles', 'By style'], ['new', 'Promising'], ['top', 'Top'], ['popular', 'Popular']];
    const downState = (mktTab === 'browse' ? mktLoad : mineLoad).state;
    const down = downState === 'error' || downState === 'off';
    const bar = `<div class="v2-row v2-wrap v2-ag-mbar${down ? ' v2-ag-down' : ''}"${down ? ' aria-disabled="true"' : ''}>${mktTab === 'browse' ? chips(sorts, mktSort, 'mkt-sort') : ''}<div class="v2-grow"></div>${seg([['browse', 'Browse'], ['mine', 'My strategies']], mktTab, 'mkt-tab')}${btn(`${ico('plus', 0.9)} Publish`, 'mkt-publish', { h: 'violet' })}</div>`;
    const note = `<div class="v2-xs v2-mut">Copy a strategy for your Coins Agent. Its creator gets 8% and Nomad 2% of the profit it makes you, never of losses. To back a pro's agent with NEAR, see Back a pro.</div>`;
    const l = mktTab === 'browse' ? mktLoad : mineLoad;
    const wait = loadBody(l, 'store');
    let body: string;
    if (wait) body = `<div class="v2-panel v2-body">${wait}</div>`;
    else if (mktTab === 'browse') {
      mktItems = arr(l.data!.strategies);
      body = mktItems.length ? `<div class="v2-ag-mgrid v2-scroll">${mktItems.map(marketCard).join('')}</div>` : `<div class="v2-panel v2-body"><div class="v2-empty">${ico('store', 5)}No strategies yet. Publish yours: from My Twin, or your Strategy tab.</div></div>`;
    } else body = mineBody(l.data!);
    return agMain('ag-market') + bar + note + body;
  },
  actions: {
    ...common,
    reload: () => reloadMarket(),
    'mkt-sort': (v) => {
      mktSort = v;
      reloadMarket();
    },
    'mkt-tab': (v) => {
      mktTab = v === 'mine' ? 'mine' : 'browse';
      reloadMarket();
    },
    'mkt-publish': () => publish(false),
    'mkt-copy': (v) => {
      const s = mktItems[Number(v)];
      if (s) copyStrategy(s);
    },
    'mkt-notyet': (v) => {
      const s = mktItems[Number(v)];
      if (s) notYet(s);
    },
    'mine-run': (v) => {
      const s = mineItems[Number(v)];
      if (s) copyStrategy(s);
    },
  },
};

let mineItems: J[] = [];
function mineBody(j: J): string {
  mineItems = arr(j.strategies);
  if (!mineItems.length)
    return `<div class="v2-panel v2-body"><div class="v2-empty">${ico('store', 5)}You haven't published a strategy yet. Publish your Strategy tab's settings (or your twin) and copiers pay you 8% of the profit it makes them.${btn('Publish', 'mkt-publish', { h: 'gold' })}</div></div>`;
  const tiles = `<div class="v2-card v2-grow"><b style="font-size:1.5em">${fmt(num(j.earned))}</b><div class="v2-xs v2-mut">Coins earned from copiers</div></div><div class="v2-card v2-grow"><b style="font-size:1.5em">${fmt(num(j.paid))}</b><div class="v2-xs v2-mut">Paid out</div></div>`;
  const rows = mineItems.map((s) => {
    const rec = (s.record ?? {}) as J;
    const need = (s.listing ?? {}) as J;
    const state = !s.listed ? ['Old version', ''] : s.qualified ? ['Copyable', 'ok'] : need.minDays !== undefined ? [`Not copyable yet · ${fmt(num(rec.hands))}/${fmt(num(need.minHands))} hands`, ''] : [`Not listed yet · ${fmt(num(rec.hands))}/${fmt(num(need.minHands))} hands`, ''];
    return `<div class="v2-card v2-row v2-wrap"><b class="v2-grow">${esc(s.name)} <span class="v2-xs v2-mut">v${esc(s.version)}</span></b><span class="v2-pill ${state[1]}">${esc(state[0])}</span><span class="v2-sm">${num(rec.copiers)} copiers · ${fmt(num(rec.hands))} hands · <b class="${tone(num(rec.net))}">${signed(num(rec.net))}</b> for copiers</span></div>`;
  }).join('');
  return `<div class="v2-panel v2-col v2-scroll v2-body"><div class="v2-row v2-ag-tiles">${tiles}</div>${rows}</div>`;
}

// ---- Coach

const coachLoad = newLoad();
const coach: ScreenDef = {
  id: 'ag-coach',
  back: 'main',
  open() {
    void fetchInto(coachLoad, 'GET', '/api/style/coach');
  },
  render() {
    const wait = loadBody(coachLoad, 'coach');
    if (wait) return agMain('ag-coach') + `<div class="v2-panel v2-body">${wait}</div>`;
    const r = coachLoad.data!;
    const hands = num(r.hands);
    if (hands < COACH_MIN_HANDS)
      return agMain('ag-coach') + `<div class="v2-panel v2-body"><div class="v2-empty">${ico('coach', 7)}<b class="v2-h" style="font-size:1.5em;color:var(--v2-ink)">The coach learns from your Coins hands</b>Play ${COACH_MIN_HANDS - hands} more hands, then come back for what's working and what to try.${btn('Play now', 'coach-play', { h: 'gold' })}</div></div>`;
    const st = (r.stats ?? {}) as J;
    const stats = [[fmt(hands), 'Hands'], [num(st.bbPer100).toFixed(1), 'bb / 100'], [pctTxt(st.vpip), 'Plays'], [pctTxt(st.pfr), 'Raises'], [pctTxt(st.wonAtShowdown), 'Showdowns won']]
      .map(([v, l]) => `<div class="v2-panel v2-ag-cstat"><b style="font-size:1.8em">${v}</b><div class="v2-sm v2-mut">${l}</div></div>`).join('');
    const working = ((r.working as string[] | undefined) ?? []).map((t) => `<div class="v2-card">${esc(t)}</div>`).join('') || '<div class="v2-card v2-mut">Nothing stands out yet.</div>';
    const leaks = arr(r.notWorking).map((l) => `<div class="v2-card"><b>${esc(l.title)}</b><div class="v2-sm v2-mut">${esc(l.detail)}</div><div class="v2-sm" style="color:#9fe3ff">Try: ${esc(l.advice)}</div></div>`).join('') || '<div class="v2-card v2-mut">No leaks found.</div>';
    const col = (h: string, c: string, icon: string, n: number, inner: string) => `<div class="v2-panel v2-col v2-scroll"><div class="v2-row">${ico(icon, 2.2)}<b class="v2-h v2-grow">${h}</b><span class="v2-pill ${c}">${n}</span></div>${inner}</div>`;
    return agMain('ag-coach') + `${typeof r.note === 'string' && r.note ? `<div class="v2-card">${esc(r.note)}</div>` : ''}<div class="v2-ag-cstats">${stats}</div>
  <div class="v2-ag-ccols">${col('Working well', 'ok', 'check', ((r.working as unknown[]) ?? []).length, working)}${col('Leak to fix', 'bad', 'eye', arr(r.notWorking).length, leaks)}${col('Try next', 'gold', 'bolt', r.tryNext ? 1 : 0, `<div class="v2-card">${esc(r.tryNext ?? 'Keep playing: the coach updates as you go.')}</div>`)}</div>`;
  },
  actions: {
    ...common,
    reload: () => void fetchInto(coachLoad, 'GET', '/api/style/coach'),
    'coach-play': () => host().show('TableSelect_TownLobby'),
  },
};

export function agentScreens(): ScreenDef[] {
  const all: V2Screen[] = [overview, strategy, history, twin, market, backingScreen(agMain), coach];
  for (const s of all) s.back ??= 'main';
  return all as ScreenDef[];
}
