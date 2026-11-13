/**
 * The SOL Agent (Per/Unity/PerAgentPanel.cs, M12c) as actions for the Redesign v2 Agents pages in On-chain mode
 * (src/ui2/screens/solAgent.ts): limits, Deploy (the play key sets the Agent key on chain, no wallet prompt), what
 * it's doing, Stop, its sessions. The runner is the private-tables backend (agents.ts); every request is signed by
 * the play key. It plays the Strategy tab's profile, or a copied marketplace strategy under that strategy's fee terms
 * (as NomadUiHost.Onchain OnchainDeployOrStop).
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import type { PerRuntime } from '../per/service';
import type { Status } from '../per/gameWallet';
import type { SolCopy } from '../../menu/screens/market';
import { copyTerms, deployBusyText, withCopiedStrategy } from '../nomad/solAgentCopy';
import { errMsg } from './perUi';
import { w3 } from '../services';

/** Most at risk per Deploy (lamports). */
export const STAKES = [10_000_000n, 25_000_000n, 50_000_000n, 100_000_000n];
export const BUY_IN_BB = [25, 50, 100];
export const HANDS = [25, 100, 500];
export const MINUTES = [15, 60, 240, 1440];
export const LOSS_PCT = [0, 25, 50];
export const PROFIT_PCT = [0, 50, 100];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "dd MMM HH:mm" (invariant culture), local time. */
export function sessionWhen(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** PerAgentPanel.Label. */
export const agentLabel = (status: string): string => ({ running: 'playing', stopping: 'leaving', prepared: 'not started' } as Record<string, string>)[status] ?? 'stopped';

/** The SOL Agent's limits (indices into the lists above). */
export interface SolAgentLimits {
  stake: number;
  buyIn: number;
  hands: number;
  minutes: number;
  loss: number;
  profit: number;
}

/** The settings /agents/prepare takes: the Strategy tab's profile (`custom`) or the copy's id, and the limits. */
export function solAgentSettings(l: SolAgentLimits, profile: Record<string, unknown>, copy: SolCopy | null): Record<string, unknown> {
  const stake = STAKES[l.stake]!;
  return withCopiedStrategy({
    strategy: 'custom', custom: profile, stake: Number(stake), buyInBB: BUY_IN_BB[l.buyIn], maxHands: HANDS[l.hands], maxMinutes: MINUTES[l.minutes],
    stopLoss: Number((stake * BigInt(LOSS_PCT[l.loss]!)) / 100n), profitTarget: Number((stake * BigInt(PROFIT_PCT[l.profit]!)) / 100n),
  }, copy);
}

/** Deploys the SOL Agent. Throws a player-readable Error when it can't (connect, balance, service). */
export async function deploySolAgent(ctx: AppContext, per: PerRuntime, l: SolAgentLimits, profile: Record<string, unknown>, copy: SolCopy | null, st: Status): Promise<void> {
  if (!(await w3(ctx).solana.connect())) throw new Error('Connect a wallet first.');
  await per.gameWallet.ensureVault(st, 'no Agent was deployed');
  const key = await per.gameWallet.playKey(st);
  const stake = STAKES[l.stake]!;
  const balance = (await per.balance(st)) ?? 0n;
  if (balance < stake) throw new Error(`Your game balance is ${per.format.sol(balance)} and the stake is ${per.format.sol(stake)}. Deposit first, or pick a smaller stake.`);
  st('Getting an Agent key from the Agent service…');
  const prep = await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/prepare', { settings: solAgentSettings(l, profile, copy) });
  // M12 review M2: the stake and end time set on chain are the ones chosen here, never what the service answers.
  const until = Math.floor(Date.now() / 1000) + Math.min(MINUTES[l.minutes]! * 60 + 15 * 60, per.agent.MAX_SECONDS - 60);
  let answered: bigint;
  try {
    answered = BigInt(String(prep.stake));
  } catch {
    answered = -1n;
  }
  if (answered !== stake) throw new Error('the Agent service answered with a different stake');
  // Sign only the terms the player was shown (none for their own strategy).
  const terms = copyTerms(copy, per.gameWallet.address?.toBase58() ?? null, prep.terms, (creator, c, p) => per.agent.terms(new PublicKey(creator), c, p));
  st(deployBusyText(copy));
  await per.gameWallet.sendAsKey(key, per.agent.set(key, new PublicKey(String(prep.agent)), until, stake, terms)[1]!);
  let last: unknown = null;
  for (let i = 0; i < 6; i++) {
    await per.http.delay(2000);
    try {
      await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/start');
      last = null;
      break;
    } catch (e) {
      last = e;
    }
  }
  if (last) throw last;
}

/** Stops the SOL Agent: on chain first (M12 review M3), then the service. Returns what happened, for the player. */
export async function stopSolAgent(ctx: AppContext, per: PerRuntime, st: Status): Promise<string> {
  if (!(await w3(ctx).solana.connect())) throw new Error('Connect a wallet first.');
  const key = await per.gameWallet.playKey(st);
  st('Stopping: it leaves after the hand being played…');
  let onChain: string | null = null;
  let service: string | null = null;
  try {
    await per.gameWallet.sendAsKey(key, per.agent.stop(key)[1]!);
  } catch (e) {
    onChain = errMsg(e);
    console.warn('[PerAgent] on-chain stop: ' + onChain);
  }
  try {
    await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/stop');
  } catch (e) {
    service = errMsg(e);
    console.warn('[PerAgent] service stop: ' + service);
  }
  return onChain === null && service === null ? 'Stopped. Its seat cashes out into your game balance after this hand.'
    : onChain === null ? "Stopped on chain, so it can't buy in again. The Agent service didn't answer; it leaves its table within a few minutes."
    : "The Agent service is stopping it, but the on-chain stop didn't go through. Try Stop again in a minute.";
}

/** One played session, for the history list. */
export interface SolAgentSession {
  when: string;
  table: string;
  hands: number;
  buyIn: bigint;
  /** Result so far (cash-out or current stack minus buy-in). */
  net: bigint;
  /** 'playing', or why it ended. */
  result: string;
}

export interface SolAgentRead {
  /** none: no wallet · setup: this device has no play key yet (Deploy sets it up) · ok: read. */
  state: 'none' | 'setup' | 'ok';
  status: string;
  detail: string;
  sessions: SolAgentSession[];
}

/** What the Agent is doing and its last sessions. Never asks the wallet (no play key on this device: 'setup'). */
export async function readSolAgent(per: PerRuntime): Promise<SolAgentRead> {
  const empty = { status: '', detail: '', sessions: [] };
  const w = per.gameWallet.address;
  if (!w) return { state: 'none', ...empty };
  if (!per.gameWallet.hasPlayKey(w)) return { state: 'setup', ...empty };
  const key = await per.gameWallet.playKey(() => {});
  const me = await per.agent.call(per.http, per.config.perBackendUrl, key, '/agents/me');
  const a = me.agent && typeof me.agent === 'object' ? (me.agent as Record<string, unknown>) : null;
  const sessions: SolAgentSession[] = [];
  for (const s of (Array.isArray(me.sessions) ? me.sessions : []) as Record<string, unknown>[]) {
    const buyIn = BigInt(String(s.buy_in ?? '0'));
    const end = BigInt(String(s.cash_out === null || s.cash_out === undefined ? (s.stack ?? '0') : s.cash_out));
    const ended = !(s.ended_at === null || s.ended_at === undefined);
    sessions.push({
      when: sessionWhen(new Date(String(s.started_at))), table: String(s.table_address ?? ''), hands: Number(s.hands) | 0, buyIn, net: end - buyIn,
      result: ended ? String(s.end_reason ?? 'ended').replace(/_/g, ' ') : 'playing',
    });
    if (sessions.length >= 20) break;
  }
  return { state: 'ok', status: a ? String(a.status ?? '') : '', detail: a ? String(a.detail ?? '') : '', sessions };
}
