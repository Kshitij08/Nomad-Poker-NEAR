// Agents v2 on SOL (docs/AGENTS_V2.md §5): the copy-strategy marketplace for SOL Agents. Mirrors the Coins version
// (backend/src/strategies), with the profit share enforced by the program: the copier's play key sets the fee terms
// with the Agent (agent_set), and each agent_cash_out pays the creator's 8% and Nomad's 2% of new profit above the
// high-water mark straight into their game balances. This service only lists strategies, hands the terms to the
// game, checks the Agent it runs was set with them, and keeps the track records.
import { randomUUID } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { CONFIG_PDA, coder, l1, PROGRAM_ID } from "./chain";
import { pool } from "./db";
import { clampProfile, Profile } from "./agentBot";

export const CREATOR_FEE_BPS = 800;
/** The program's default platform share (config.agent_fee_bps = 0). */
export const DEFAULT_PLATFORM_FEE_BPS = 200;
/** A track record counts as verified after this many hands (docs: minimum before ranking). */
const VERIFIED_HANDS = 2000;

export const SOL_STRATEGY_MIGRATIONS = [
  `create table if not exists sol_strategies (
     strategy_id text primary key,
     creator text not null,
     creator_name text not null,
     name text not null,
     description text not null default '',
     version int not null,
     profile jsonb not null,
     creator_fee_bps int not null,
     listed boolean not null default true,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists sol_strategies_creator on sol_strategies (creator, created_at desc)`,
  // Each Agent session's strategy, the record's counts when it sat down (net = net_out - net_in, and the high-water
  // mark), and the fees its cash-out paid (as the program computes them).
  `alter table agent_sessions add column if not exists strategy_id text`,
  `alter table agent_sessions add column if not exists fee_net_before bigint`,
  `alter table agent_sessions add column if not exists fee_high_water bigint`,
  `alter table agent_sessions add column if not exists creator_fee bigint`,
  `alter table agent_sessions add column if not exists platform_fee bigint`,
  `create index if not exists agent_sessions_strategy on agent_sessions (strategy_id) where strategy_id is not null`,
];

export class StrategyError extends Error {}

// ---------------------------------------------------------------------------------------- fees (as the program)

export type FeeTerms = { creator: PublicKey; creatorFeeBps: number; platformFeeBps: number };
export const NO_TERMS: FeeTerms = { creator: PublicKey.default, creatorFeeBps: 0, platformFeeBps: 0 };
export const sameTerms = (a: FeeTerms, b: FeeTerms) => a.creator.equals(b.creator) && a.creatorFeeBps === b.creatorFeeBps && a.platformFeeBps === b.platformFeeBps;

/** AgentState::settle: the fees of one cash-out, given the record's net (net_out - net_in) and high-water mark before
 *  the seat, and the seat's buy-in and cash-out. All lamports. */
export function settleSol(terms: FeeTerms, netBefore: bigint, highWater: bigint, buyIn: bigint, cashOut: bigint) {
  const net = netBefore + cashOut - buyIn;
  if (terms.creator.equals(PublicKey.default) || net <= highWater) return { profit: 0n, creatorFee: 0n, platformFee: 0n, highWater };
  let profit = net - highWater;
  if (profit > cashOut) profit = cashOut;
  return { profit, creatorFee: (profit * BigInt(terms.creatorFeeBps)) / 10_000n, platformFee: (profit * BigInt(terms.platformFeeBps)) / 10_000n, highWater: net };
}

let platformCache: { at: number; bps: number } | null = null;
/** Nomad's share now (config.agent_fee_bps; 0 = the default). Cached for a minute. */
export async function platformFeeBps(): Promise<number> {
  if (platformCache && Date.now() - platformCache.at < 60_000) return platformCache.bps;
  const info = await l1.getAccountInfo(CONFIG_PDA, "confirmed");
  if (!info) throw new Error("the program's config isn't readable");
  const c: any = coder.decode("config", info.data);
  const bps = Number(c.agentFeeBps ?? 0) || DEFAULT_PLATFORM_FEE_BPS;
  platformCache = { at: Date.now(), bps };
  return bps;
}

// ---------------------------------------------------------------------------------------- the marketplace

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Whether the wallet has opened its game balance (its vault's token account exists), so fees can reach it. */
async function hasGameBalance(wallet: PublicKey): Promise<boolean> {
  const ws = await l1.getAccountInfo(pda(Buffer.from("wallet"), wallet.toBuffer()), "confirmed");
  const seed = ws && ws.data.length >= 52 ? Buffer.from(ws.data.subarray(44, 52)) : Buffer.alloc(8);
  const vault = seed.every((b) => b === 0) ? pda(Buffer.from("vault"), wallet.toBuffer()) : pda(Buffer.from("vault"), wallet.toBuffer(), seed);
  const token = PublicKey.findProgramAddressSync([vault.toBuffer(), TOKEN_PROGRAM.toBuffer(), NATIVE_MINT.toBuffer()], ATA_PROGRAM)[0];
  return !!(await l1.getAccountInfo(token, "confirmed"));
}

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const isId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/.test(s);

/** Publishes a frozen strategy (a custom profile) by this wallet. Re-publishing a name adds a version; older
 *  versions leave the listing, and their copiers keep them. */
export async function publish(wallet: PublicKey, body: any) {
  const name = String(body?.name ?? "").trim().slice(0, 40);
  if (name.length < 3) throw new StrategyError("give your strategy a name (3–40 letters)");
  const description = String(body?.description ?? "").trim().slice(0, 280);
  const p = body?.profile ?? {};
  const values = [p.foldBelow, p.raiseAbove, p.aggression, p.bluffChance, p.raiseFractionOfPot].map(Number);
  if (values.some((v) => !Number.isFinite(v))) throw new StrategyError("the profile needs five numbers");
  const profile = clampProfile({ foldBelow: values[0], raiseAbove: values[1], aggression: values[2], bluffChance: values[3], raiseFractionOfPot: values[4] });
  // Fees are paid into the creator's game balance in the rollup: it must exist.
  if (!(await hasGameBalance(wallet))) throw new StrategyError("open your game balance first (deposit once): copiers' fees are paid into it");
  const creatorName = String(body?.creatorName ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 24) || short(wallet.toBase58());
  const w = wallet.toBase58();
  const prev = (await pool.query("select coalesce(max(version), 0) as v from sol_strategies where creator = $1 and name = $2", [w, name])).rows[0];
  const id = randomUUID();
  await pool.query(
    `insert into sol_strategies (strategy_id, creator, creator_name, name, description, version, profile, creator_fee_bps) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, w, creatorName, name, description, Number(prev.v) + 1, JSON.stringify(profile), CREATOR_FEE_BPS]);
  if (Number(prev.v) > 0) await pool.query("update sol_strategies set listed = false where creator = $1 and name = $2 and strategy_id <> $3", [w, name, id]);
  return get(id);
}

export async function unlist(wallet: PublicKey, strategyId: unknown) {
  if (!isId(strategyId)) throw new StrategyError("bad strategy id");
  const r = await pool.query("update sol_strategies set listed = false where strategy_id = $1 and creator = $2", [strategyId, wallet.toBase58()]);
  if (!r.rowCount) throw new StrategyError("not your strategy");
  return { ok: true };
}

// Track record: finished Agent sessions that ran the strategy (not self-reported). Score = profit per 100 hands, shrunk
// toward zero while the sample is small.
const TRACK_RECORD_SQL = `
  count(distinct a.wallet)::int as copiers,
  count(a.id)::int as sessions,
  coalesce(sum(a.hands), 0)::bigint as hands,
  coalesce(sum(a.cash_out - a.buy_in), 0)::bigint as net,
  coalesce(sum(a.creator_fee), 0)::bigint as creator_fees,
  case when coalesce(sum(a.hands), 0) = 0 then null
       else (sum(a.cash_out - a.buy_in)::float8 * 100 / sum(a.hands)) * (sum(a.hands)::float8 / (sum(a.hands) + 500)) end as score`;
const FROM_SQL = `from sol_strategies s left join agent_sessions a on a.strategy_id = s.strategy_id and a.ended_at is not null and a.cash_out is not null`;

function toPublic(r: any) {
  const profile: Profile = typeof r.profile === "string" ? JSON.parse(r.profile) : r.profile;
  const hands = Number(r.hands ?? 0);
  return {
    strategyId: r.strategy_id, name: r.name, description: r.description, version: r.version, creator: r.creator, creatorName: r.creator_name,
    listed: r.listed, profile, tags: tags(profile),
    record: { copiers: Number(r.copiers ?? 0), sessions: Number(r.sessions ?? 0), hands, net: Number(r.net ?? 0), per100Hands: hands ? Math.round((Number(r.net) * 100) / hands) : 0 },
    verified: hands >= VERIFIED_HANDS,
    fees: { creatorBps: r.creator_fee_bps, creatorPercent: r.creator_fee_bps / 100, platformPercent: DEFAULT_PLATFORM_FEE_BPS / 100 },
    createdAt: r.created_at,
  };
}

export async function list(sort = "top", limit = 30) {
  const order = sort === "new" ? "s.created_at desc" : sort === "popular" ? "copiers desc, s.created_at desc" : "score desc nulls last, s.created_at desc";
  const rows = (await pool.query(`select s.*, ${TRACK_RECORD_SQL} ${FROM_SQL} where s.listed group by s.strategy_id order by ${order} limit $1`,
    [Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 30))])).rows;
  const bps = await platformFeeBps().catch(() => DEFAULT_PLATFORM_FEE_BPS);
  return rows.map((r) => withPlatform(toPublic(r), bps));
}

export async function get(strategyId: unknown) {
  if (!isId(strategyId)) throw new StrategyError("bad strategy id");
  const r = (await pool.query(`select s.*, ${TRACK_RECORD_SQL} ${FROM_SQL} where s.strategy_id = $1 group by s.strategy_id`, [strategyId])).rows[0];
  if (!r) throw new StrategyError("that strategy doesn't exist");
  return withPlatform(toPublic(r), await platformFeeBps().catch(() => DEFAULT_PLATFORM_FEE_BPS));
}
const withPlatform = <T extends { fees: any }>(s: T, bps: number) => ({ ...s, fees: { ...s.fees, platformBps: bps, platformPercent: bps / 100 } });

/** The creator's strategies and what their copiers' Agents paid them (lamports). */
export async function dashboard(wallet: PublicKey) {
  const w = wallet.toBase58();
  const rows = (await pool.query(`select s.*, ${TRACK_RECORD_SQL} ${FROM_SQL} where s.creator = $1 group by s.strategy_id order by s.created_at desc`, [w])).rows;
  const earned = rows.reduce((sum, r) => sum + BigInt(r.creator_fees ?? 0), 0n);
  return { strategies: rows.map(toPublic), earned: earned.toString() };
}

/** The strategy a copier's Agent plays and the fee terms its record must carry. */
export async function termsFor(strategyId: unknown, copier: PublicKey): Promise<{ profile: Profile; terms: FeeTerms; name: string }> {
  if (!isId(strategyId)) throw new StrategyError("bad strategy id");
  const r = (await pool.query("select * from sol_strategies where strategy_id = $1", [strategyId])).rows[0];
  if (!r) throw new StrategyError("that strategy doesn't exist");
  if (r.creator === copier.toBase58()) throw new StrategyError("that's your own strategy: deploy it as Custom (no fee)");
  const profile: Profile = typeof r.profile === "string" ? JSON.parse(r.profile) : r.profile;
  return { profile, name: r.name, terms: { creator: new PublicKey(r.creator), creatorFeeBps: r.creator_fee_bps, platformFeeBps: await platformFeeBps() } };
}

/** Tables a copier's Agent must avoid: where another Agent copying the same strategy, or the creator's own Agent,
 *  sits (docs §5, collusion). */
export async function tablesToAvoid(wallet: string, strategyId: string | undefined, creator: string | undefined): Promise<Set<string>> {
  if (!strategyId) return new Set();
  const rows = (await pool.query(
    "select distinct table_address from agent_sessions where ended_at is null and wallet <> $1 and (strategy_id = $2 or wallet = $3)", [wallet, strategyId, creator ?? ""])).rows;
  return new Set(rows.map((r) => r.table_address));
}

function tags(p: Profile): string[] {
  const out: string[] = [];
  out.push(p.foldBelow >= 0.34 ? "Tight" : p.foldBelow <= 0.25 ? "Loose" : "Balanced");
  out.push(p.aggression >= 0.6 ? "Aggressive" : p.aggression <= 0.38 ? "Passive" : "Steady");
  if (p.bluffChance >= 0.1) out.push("Bluffer");
  if (p.raiseFractionOfPot >= 0.85) out.push("Big bets");
  return out;
}
