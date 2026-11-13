/**
 * The SOL Agent (On-chain) on the v2 Agents pages: Overview shows what it's doing, its limits and Deploy / Stop;
 * History lists its sessions. It plays the Strategy tab's profile, or a strategy copied from the SOL marketplace.
 * The chain actions are src/web3/ui/lobbyAgent.ts (Per/Unity/PerAgentPanel.cs); they load with @solana/web3.js the
 * first time an Agents page opens On-chain. While a page is open the Agent is read every 10 s.
 */
import type { PerRuntime } from '../../web3/per/service';
import type { SolAgentLimits, SolAgentRead } from '../../web3/ui/lobbyAgent';
import { deployedText } from '../../web3/nomad/solAgentCopy';
import { marketState, solProfile, type AgentStrategyLike } from '../../menu/screens/market';
import { sol } from '../../web3/per/money';
import { btn, chips, esc, type Action } from '../core';
import { ico } from '../icons';
import { ui, host, app, S, onchain, onchainApi, signedIn } from '../ctx';
import { perRt, shortAddr, solAmt, solBusy, solError, solTask } from './solKit';

type Mod = typeof import('../../web3/ui/lobbyAgent');

const SA = {
  per: null as PerRuntime | null,
  mod: null as Mod | null,
  loadErr: '',
  read: null as SolAgentRead | null,
  readErr: '',
  readAt: 0,
  timer: 0,
  limits: { stake: 1, buyIn: 1, hands: 1, minutes: 1, loss: 0, profit: 0 } as SolAgentLimits,
};

const strategy = (): (AgentStrategyLike & { styleName?: string; shortSummary?: string }) | undefined => S('agentStrategy');

async function ready(): Promise<boolean> {
  if (SA.per && SA.mod) return true;
  try {
    const [per, mod] = await Promise.all([perRt(), import('../../web3/ui/lobbyAgent')]);
    SA.per = per;
    SA.mod = mod;
    SA.loadErr = '';
    return true;
  } catch (e) {
    console.error('[ui2] SOL Agent', e);
    SA.loadErr = solError(e, "Couldn't open your SOL Agent. Check your connection and try again.");
    return false;
  }
}

async function refresh(): Promise<void> {
  SA.readAt = performance.now();
  if (!(await ready())) return void ui().render();
  try {
    SA.read = await SA.mod!.readSolAgent(SA.per!);
    SA.readErr = '';
  } catch (e) {
    console.warn('[ui2] SOL Agent read', e);
    SA.readErr = solError(e, "Couldn't reach the Agent service. It may still be playing; try again in a moment.");
  }
  ui().render();
}

/** Starts reading the Agent (an Agents page opened On-chain); every 10 s while open and idle. */
export function solAgentOpen(): void {
  if (!onchain()) return;
  void refresh();
  window.clearInterval(SA.timer);
  SA.timer = window.setInterval(() => {
    if (onchain() && !solBusy() && performance.now() - SA.readAt > 10_000) void refresh();
  }, 1000);
}

/** The page was opened in Demo mode and switched to On-chain: start reading now. */
function ensureOpen(): void {
  if (!SA.timer && onchain()) queueMicrotask(solAgentOpen);
}

export function solAgentClose(): void {
  window.clearInterval(SA.timer);
  SA.timer = 0;
}

const running = (): boolean => SA.read?.status === 'running' || SA.read?.status === 'stopping';

/** The Agent's pill and status line for the Agents header (On-chain). */
export function solAgentStatus(): { pill: string; line: string } {
  const r = SA.read;
  if (!onchainApi.walletAddress?.()) return { pill: 'Idle', line: 'SOL Agent · connect your wallet to see it' };
  if (!r) return { pill: 'Idle', line: SA.readErr ? 'SOL Agent · status unavailable' : 'SOL Agent · checking…' };
  const pill = r.status === 'running' ? 'Playing' : r.status === 'stopping' ? 'Stopping' : 'Idle';
  // The service's detail line only while it plays (after a stop it's a developer note such as "the Agent key was replaced").
  const line = r.state !== 'ok' || !r.status ? 'SOL Agent · not deployed' : `SOL Agent · ${SA.mod!.agentLabel(r.status)}${running() && r.detail ? ` · ${r.detail}` : ''}`;
  return { pill, line };
}

function sessionsNet(): { hands: number; net: bigint } {
  let hands = 0;
  let net = 0n;
  for (const s of SA.read?.sessions ?? []) {
    hands += s.hands;
    net += s.net;
  }
  return { hands, net };
}

const signedSol = (v: bigint): string => `${v > 0n ? '+' : v < 0n ? '−' : ''}${sol(v < 0n ? -v : v)}`;
const tone = (v: bigint): string => (v > 0n ? 'v2-good' : v < 0n ? 'v2-badc' : '');

function stateCard(): string {
  if (!onchainApi.walletAddress?.())
    return `<div class="v2-card v2-row" style="gap:.8em">${ico('sol', 2.2)}<div class="v2-grow"><div class="v2-cap">Not connected</div><div style="font-weight:800">Connect your wallet to see your SOL Agent</div></div>${btn('Connect wallet', 'sa-connect', { h: 'gold', c: 'sm' })}</div>`;
  const r = SA.read;
  if (!r && SA.readErr) return `<div class="v2-card v2-row" style="gap:.8em">${ico('robot', 2.2)}<div class="v2-grow"><div class="v2-cap">Status unavailable</div><div class="v2-sm">${esc(SA.readErr)}</div></div>${btn('Try again', 'sa-refresh', { h: 'blue', c: 'sm' })}</div>`;
  if (!r) return `<div class="v2-card v2-row" style="gap:.8em"><i class="v2-spin" aria-hidden="true"></i><div class="v2-grow">Checking your SOL Agent…</div></div>`;
  if (r.state !== 'ok' || !r.status || !running())
    return `<div class="v2-card v2-row" style="gap:.8em">${ico('robot', 2.2)}<div class="v2-grow"><div class="v2-cap">Not playing</div><div style="font-weight:800">Deploy it to send it to a SOL table</div></div></div>`;
  return `<div class="v2-card v2-row" style="gap:.8em">${ico('eye', 2.2, 'color:#2ee38a')}<div class="v2-grow"><div class="v2-cap">${r.status === 'stopping' ? 'Leaving' : 'Playing'}</div><div style="font-weight:800">${esc(r.detail || 'Looking for a table…')}</div></div>${btn('Refresh', 'sa-refresh', { h: 'ghost', c: 'sm' })}</div>`;
}

function group(label: string, items: string[], on: number, a: string): string {
  return `<div class="v2-col v2-sa-grp"><span class="v2-sm v2-mut">${label}</span><div class="v2-row v2-wrap" style="gap:.35em">${chips(items.map((x, i) => [String(i), x] as [string, string]), String(on), a)}</div></div>`;
}

/** Overview, On-chain: the inner markup of the Agents shell. */
export function solAgentOverview(): string {
  ensureOpen();
  if (!SA.mod) {
    if (SA.loadErr) return `<div class="v2-empty">${ico('sol', 5)}<span>${esc(SA.loadErr)}</span>${btn('Try again', 'sa-refresh', { h: 'blue' })}</div>`;
    return `<div class="v2-empty"><i class="v2-spin" aria-hidden="true"></i><span>Getting your SOL Agent…</span></div>`;
  }
  const M = SA.mod;
  const l = SA.limits;
  const s = strategy();
  const copy = marketState.copiedSol;
  const { hands, net } = sessionsNet();
  const n = SA.read?.sessions.length ?? 0;
  const live = running();
  const stopping = SA.read?.status === 'stopping';
  return `<div class="v2-ag-ov">
  <div class="v2-col v2-ag-ovl">
    <button class="v2-card v2-ag-strat" data-a="tab" data-v="ag-strategy"><div class="v2-cap">Plays</div><div style="font-size:1.3em;font-weight:900">${esc(copy ? copy.name : s?.styleName ?? 'Your strategy')}</div><div class="v2-mut v2-sm">${copy ? 'Copied from the SOL marketplace: its creator gets 8% and Nomad 2% of new profit, paid on chain.' : esc(s?.shortSummary ?? 'Set how it plays on the Strategy tab.')}</div></button>
    <div class="v2-card"><div class="v2-cap">Recent performance</div><div class="v2-row v2-ag-stats">${[[String(n), 'Sessions', '', ''], [String(hands), 'Hands', '', ''], [signedSol(net), 'Net result', tone(net), ico('sol', 0.9)]].map(([v, lb, c, i]) => `<div><b class="${c}" style="font-size:1.5em">${i}${esc(v)}</b><div class="v2-xs v2-mut">${lb}</div></div>`).join('')}</div>${btn('View history', 'tab', { h: 'ghost', c: 'sm', v: 'ag-history' })}</div>
    ${stateCard()}
  </div>
  <div class="v2-card v2-col v2-ag-setup v2-sa-setup"><div class="v2-cap">Session setup</div>
    ${group('Most at risk', M.STAKES.map((x) => sol(x)), l.stake, 'sa-stake')}
    ${group('Buy-in', M.BUY_IN_BB.map((b) => `${b} big blinds`), l.buyIn, 'sa-buyin')}
    ${group('Stop after', M.HANDS.map((h) => `${h} hands`), l.hands, 'sa-hands')}
    ${group('Or after', M.MINUTES.map((m) => (m < 60 ? `${m} min` : `${m / 60} h`)), l.minutes, 'sa-minutes')}
    ${group('Stop-loss, per table', M.LOSS_PCT.map((p) => (p === 0 ? 'Off' : `−${p}% of stake`)), l.loss, 'sa-loss')}
    ${group('Profit target, per table', M.PROFIT_PCT.map((p) => (p === 0 ? 'Off' : `+${p}% of stake`)), l.profit, 'sa-profit')}
    <div class="v2-xs v2-mut">It plays from your game balance and its winnings go back there. On chain it can only buy in (up to the amount at risk), play its seat and leave: it can't withdraw. Solana test network.</div>
    <div class="v2-grow"></div>
    ${live ? btn(stopping ? 'Stopping…' : 'Stop Agent', 'sa-stop', { h: 'red', c: 'lg w', dis: stopping }) : btn('Deploy SOL Agent', 'sa-deploy', { h: 'gold', c: 'lg w' })}
  </div></div>`;
}

/** History, On-chain: the inner markup of the Agents shell. */
export function solAgentHistory(): string {
  ensureOpen();
  const r = SA.read;
  if (!onchainApi.walletAddress?.()) return `<div class="v2-empty">${ico('sol', 5)}<span>Connect your wallet to see your SOL Agent's sessions.</span>${btn('Connect wallet', 'sa-connect', { h: 'gold' })}</div>`;
  if (!r && (SA.readErr || SA.loadErr)) return `<div class="v2-empty">${ico('robot', 5)}<span>${esc(SA.readErr || SA.loadErr)}</span>${btn('Try again', 'sa-refresh', { h: 'blue' })}</div>`;
  if (!r) return `<div class="v2-empty"><i class="v2-spin" aria-hidden="true"></i><span>Loading sessions…</span></div>`;
  if (!r.sessions.length) return `<div class="v2-empty">${ico('robot', 6)}<span>No SOL sessions yet. Deploy your SOL Agent from Overview.</span>${btn('Go to Overview', 'tab', { h: 'gold', v: 'ag-overview' })}</div>`;
  const { hands, net } = sessionsNet();
  const rows = r.sessions
    .map((x) => `<div class="v2-ag-gt v2-ag-row"><b>${esc(x.when)}</b>${solAmt(x.buyIn)}${solAmt(x.buyIn + x.net > 0n ? x.buyIn + x.net : 0n)}<span class="v2-num"><span class="v2-ag-k">Hands </span>${x.hands}</span><span class="v2-num"><span class="v2-ag-k">Table </span>${esc(shortAddr(x.table))}</span><b class="v2-num ${tone(x.net)}">${esc(signedSol(x.net))}</b><span><span class="v2-pill ${x.result === 'playing' ? 'ok' : ''}">${esc(x.result[0]!.toUpperCase() + x.result.slice(1))}</span></span></div>`)
    .join('');
  return `<div class="v2-row v2-ag-tiles">${[[String(r.sessions.length), 'Sessions', '', ''], [String(hands), 'Total hands', '', ''], [signedSol(net), 'Net result', tone(net), ico('sol', 0.9)]].map(([v, lb, c, i]) => `<div class="v2-card v2-grow"><b style="font-size:1.6em" class="${c}">${i}${esc(v)}</b><div class="v2-sm v2-mut">${lb}</div></div>`).join('')}</div>
  <div class="v2-ag-gt v2-ag-hdr"><span>Started</span><span>Buy-in</span><span>End</span><span>Hands</span><span>Table</span><span>Net</span><span>Status</span></div>
  ${rows}`;
}

function confirmDeploy(): void {
  if (!signedIn()) return host().show('Login');
  const M = SA.mod;
  if (!M) return;
  const l = SA.limits;
  const stake = M.STAKES[l.stake]!;
  const copy = marketState.copiedSol;
  const s = strategy();
  const minutes = M.MINUTES[l.minutes]!;
  ui().message('Deploy your SOL Agent?',
    `It plays <b>${esc(copy ? copy.name : s?.styleName ?? 'your strategy')}</b> with up to ${ico('sol', 1)} <b>${esc(sol(stake))}</b> of your game balance at risk, and stops after ${M.HANDS[l.hands]} hands or ${minutes < 60 ? `${minutes} minutes` : minutes === 60 ? 'an hour' : `${minutes / 60} hours`}.`,
    'Deploy', () =>
      void solTask('Deploy your SOL Agent', "Couldn't deploy your Agent. Nothing was staked. Try again in a moment.", async (st) => {
        if (!(await ready())) throw new Error(SA.loadErr);
        await SA.mod!.deploySolAgent(app(), SA.per!, l, solProfile(strategy()), copy, st);
        return deployedText(sol(stake), copy);
      }, () => void refresh()), 'Cancel');
}

export const solAgentActions: Record<string, Action> = {
  'sa-refresh': () => {
    SA.loadErr = '';
    void refresh();
  },
  'sa-connect': async () => {
    try {
      await onchainApi.connectWallet?.();
    } catch (e) {
      ui().message('Connect a wallet', esc(solError(e, "Couldn't connect your wallet. Try again.")));
    }
    void refresh();
  },
  'sa-stake': (v) => void (SA.limits.stake = Number(v)),
  'sa-buyin': (v) => void (SA.limits.buyIn = Number(v)),
  'sa-hands': (v) => void (SA.limits.hands = Number(v)),
  'sa-minutes': (v) => void (SA.limits.minutes = Number(v)),
  'sa-loss': (v) => void (SA.limits.loss = Number(v)),
  'sa-profit': (v) => void (SA.limits.profit = Number(v)),
  'sa-deploy': () => confirmDeploy(),
  'sa-stop': () =>
    ui().message('Stop your SOL Agent?', 'It leaves after the hand being played, and its seat cashes out into your game balance.', 'Stop', () =>
      void solTask('Stop your SOL Agent', "Couldn't stop your Agent. Try again in a moment.", async (st) => {
        if (!(await ready())) throw new Error(SA.loadErr);
        return SA.mod!.stopSolAgent(app(), SA.per!, st);
      }, () => void refresh()), 'Keep playing', undefined, 'red'),
};
