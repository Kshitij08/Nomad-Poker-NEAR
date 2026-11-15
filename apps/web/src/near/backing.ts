/**
 * Backing pro agents on NEAR (the table contract's pools, vault and session history). Reads go straight to a NEAR RPC
 * node; writes go through the player's wallet (wallet.ts). Amounts are yoctoNEAR strings, as the contract returns them.
 */
import { viewContract } from './rpc';
import type { NearAiProof, PrivateStrategyView } from './nearAi';
import { nearCall } from './wallet';

export { NEAR_RPC } from './rpc';

export const NEAR_CONTRACT = (import.meta.env?.VITE_NEAR_CONTRACT as string | undefined) ?? 'table.nomad-poker.testnet';
export const NEAR_EXPLORER = 'https://testnet.nearblocks.io';
/** Value per share is scaled by 1e9 in the contract; a new pool starts at 1.0. */
export const PRICE_SCALE = 1_000_000_000;
const YOCTO = 10n ** 24n;

/** `profile`, `strategy_version` and `private_strategy` (a NEAR-AI agent: its sealed text's model and size) come with agents v2. */
export type Agent = { id: string; owner: string; tight: number; aggro: number; sessions: number; hands: number; net_chips: number; profile?: AgentProfile; strategy_version?: number; private_strategy?: PrivateStrategyView | null };
export type Pool = { shares: string; value: string; price: string; hwm_price: string; at_table: string; max_buy_in_bps: number; sessions: number; pending_in: string };
export type AgentCard = { agent: Agent; pool: Pool | null };
/** `deposited` / `withdrawn` (yoctoNEAR, all time) come with the contract's cost-basis views; P&L shows once they do. */
export type Holding = { shares: string; value: string; pending_in: string; pending_out_shares: string; deposited?: string; withdrawn?: string };
export type Position = { balance: string; at_table: string; net: string; deposited: string; sessions: number };
export type SessionSummary = { session_id: string; settled_at: string; hands: number; agents: string[]; end_stacks: number[] };
export type Payout = { backer: string | null; agent: string; pro: string; buy_in: string; cash_out: string; pro_fee: string; platform_fee: string; to_backer: string };
export type SessionRecord = {
  session_id: string;
  settled_at: string;
  stacks: number[];
  button: number;
  sb: number;
  bb: number;
  hands: number;
  alpha: string;
  signature_hex: string;
  actions: string;
  end_stacks: number[];
  payouts: { seats: Payout[] } | null;
  /** The private model's signed choice for each NEAR-AI seat (checked on chain before settling). */
  near_ai?: NearAiProof[];
};

/** A read-only call on the table contract (NEAR RPC `call_function`). */
export const view = <T>(method: string, args: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<T> =>
  viewContract<T>(NEAR_CONTRACT, method, args, fetchImpl);

export const listAgents = () => view<AgentCard[]>('list_agents', { limit: 100 });
export const recentSessions = (limit = 10) => view<SessionSummary[]>('recent_sessions', { limit });
export const sessionRecord = (session_id: string) => view<SessionRecord | null>('get_session_record', { session_id });
export const holding = (account: string, agent_id: string) => view<Holding>('get_holding', { account, agent_id });
export const position = (backer: string, agent_id: string) => view<Position | null>('get_position', { backer, agent_id });
export const earnings = (account: string) => view<string>('get_earnings', { account });

export const joinPool = (agentId: string, yocto: bigint) => nearCall(NEAR_CONTRACT, 'join_pool', { agent_id: agentId }, yocto, 30n);
export const leavePool = (agentId: string, shares: string) => nearCall(NEAR_CONTRACT, 'leave_pool', { agent_id: agentId, shares }, 0n, 50n);
/** Takes NEAR back out of your own (vault) position: only its idle balance, not what is at a table. */
export const withdrawPosition = (agentId: string, yocto: bigint) => nearCall(NEAR_CONTRACT, 'withdraw', { agent_id: agentId, amount: yocto.toString() }, 0n, 50n);
export const claimEarnings = () => nearCall(NEAR_CONTRACT, 'claim_earnings', {}, 0n, 30n);
/** One set of the Strategy tab's five numbers, in hundredths (the contract's `Numbers`). */
export type ProfileNumbers = { fold_below: number; raise_above: number; aggression: number; bluff_chance: number; raise_size: number };
/** An agent's v2 strategy as the contract stores it: the five numbers, position weight, per-street overrides, style name. */
export type AgentProfile = ProfileNumbers & { position_weight: number; streets: (ProfileNumbers | null)[]; style?: string };
export const getAgent = (agent_id: string) => view<(Agent & { profile?: AgentProfile; strategy_version?: number }) | null>('get_agent', { agent_id });
export const registerAgent = (agentId: string, profile: AgentProfile) => nearCall(NEAR_CONTRACT, 'register_agent', { agent_id: agentId, profile }, 0n, 30n);
/** A new strategy version for an agent you listed (backers see the change). */
export const updateAgent = (agentId: string, profile: AgentProfile) => nearCall(NEAR_CONTRACT, 'update_agent', { agent_id: agentId, profile }, 0n, 30n);

/** The contract's rule for agent ids. */
export const validAgentId = (id: string): boolean => /^[a-z0-9-]{1,32}$/.test(id);

/** yoctoNEAR to "1.2345" (rounded). */
export function formatNear(y: string | bigint, digits = 4): string {
  const v = BigInt(y);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scaled = (a * 10n ** BigInt(digits) + YOCTO / 2n) / YOCTO;
  const s = scaled.toString().padStart(digits + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, '') || '0';
}

/** "0.5" to yoctoNEAR; throws on anything else. */
export function parseNear(text: string): bigint {
  const m = text.trim().match(/^(\d+)(?:\.(\d{1,24}))?$/);
  if (!m) throw new Error('Enter an amount like 0.5');
  return BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? '').padEnd(24, '0'));
}

/** A pool's change since it opened, in percent. */
export const priceChangePct = (price: string): number => (Number(price) / PRICE_SCALE - 1) * 100;

/** "Tight, aggressive" from an agent's profile. */
export function styleWords(tight: number, aggro: number): string {
  const plays = tight >= 60 ? 'Tight' : tight <= 25 ? 'Loose' : 'Selective';
  const bets = aggro >= 65 ? 'aggressive' : aggro <= 35 ? 'passive' : 'balanced';
  return `${plays}, ${bets}`;
}
