// Agents v2 on SOL (docs/AGENTS_V2.md §5): the copy-strategy marketplace for SOL Agents. Mirrors the Coins version
// (backend/src/strategies), with the profit share enforced by the program: the copier's play key sets the fee terms
// with the Agent (agent_set), and each agent_cash_out pays the creator's 8% and Nomad's 2% of new profit above the
// high-water mark straight into their game balances. This service only lists strategies, hands the terms to the
// game, checks the Agent it runs was set with them, and keeps the track records.
// Both shares are the program config's (one creator share for every strategy). A strategy is listed and copyable by
// others only after LISTING_MIN_HANDS Agent hands with a total profit of at least LISTING_MIN_NET lamports; its
// creator can always run it (without fees), which is how it builds that record.
import { randomUUID } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { CONFIG_PDA, coder, l1, PROGRAM_ID } from "./chain";
import { pool } from "./db";
import { clampProfile, Profile } from "./agentBot";
import { alike, behaviour, distance, styleCell, styleTags } from "./styleTags";

/** The program's defaults (config.agent_fee_bps / creator_fee_bps = 0). */
export const DEFAULT_PLATFORM_FEE_BPS = 200;
export const DEFAULT_CREATOR_FEE_BPS = 800;
/** What a strategy needs before others can copy it (as the Coins marketplace, backend/src/strategies LISTING, review
 *  20 Oct): Agent hands, days since it was published, and a win rate that beats the house's Autopilot by more than its
 *  standard error. LISTING_MIN_HANDS / LISTING_MIN_DAYS change the first two. */
export const LISTING = {
  minHands: Number(process.env.LISTING_MIN_HANDS ?? 2000),
  minDays: Number(process.env.LISTING_MIN_DAYS ?? 7),
};
/** Autopilot's win rate at SOL tables, big blinds per 100 hands. SOL tables have no filler bots: this is its measured
 *  result at tables of other Agents (docs/AGENTS_V2.md section 9); HOUSE_BB100 overrides it once real records exist. */
export const HOUSE_BB100 = Number(process.env.HOUSE_BB100 ?? 45);
const NEW_DAYS = 30, NEW_MIN_HANDS = 300, SCORE_HALF_HANDS = 2000;
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

export type FeeRates = { platformBps: number; creatorBps: number };
let ratesCache: { at: number; v: FeeRates } | null = null;
/** Both shares now (config.agent_fee_bps / creator_fee_bps; 0 = the defaults). Cached for a minute. */
export async function feeRates(): Promise<FeeRates> {
  if (ratesCache && Date.now() - ratesCache.at < 60_000) return ratesCache.v;
  const info = await l1.getAccountInfo(CONFIG_PDA, "confirmed");
  if (!info) throw new Error("the program's config isn't readable");
  const c: any = coder.decode("config", info.data);
  const v = { platformBps: Number(c.agentFeeBps ?? 0) || DEFAULT_PLATFORM_FEE_BPS, creatorBps: Number(c.creatorFeeBps ?? 0) || DEFAULT_CREATOR_FEE_BPS };
  ratesCache = { at: Date.now(), v };
  return v;
}
const ratesOrDefault = () => feeRates().catch(() => ({ platformBps: DEFAULT_PLATFORM_FEE_BPS, creatorBps: DEFAULT_CREATOR_FEE_BPS }));

/** Whether others may see and copy a strategy with this record. */
/** Copyable by others: enough hands and days, and beating Autopilot by more than the standard error. */
export const qualifies = (hands: number, ageDays: number, bb100: number, se100: number) =>
  hands >= LISTING.minHands && ageDays >= LISTING.minDays && Number.isFinite(se100) && bb100 - HOUSE_BB100 > se100;

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
  // The whole strategy: the five numbers, the brain and any before / after the flop rounds (they were dropped, so
  // every SOL strategy played and was tagged as a classic-brain twin).
  const profile = clampProfile({ foldBelow: values[0], raiseAbove: values[1], aggression: values[2], bluffChance: values[3], raiseFractionOfPot: values[4],
    brain: Number(p.brain) === 2 ? 2 : undefined, positionWeight: Number.isFinite(Number(p.positionWeight)) ? Number(p.positionWeight) : undefined, streets: p.streets });
  // A strategy that plays like one another creator already lists isn't new (as the Coins marketplace).
  const mine = behaviour(profile as any);
  for (const other of await records(`s.listed and s.creator <> $1`, [wallet.toBase58()]))
    if (other.qualified && alike(mine, other.behaviour))
      throw new StrategyError(`that plays like "${other.name}" by ${other.creatorName}, which is already listed. Change how many hands it plays, its pressure, bluffing or bet size`);
  // Fees are paid into the creator's game balance in the rollup: it must exist.
  if (!(await hasGameBalance(wallet))) throw new StrategyError("open your game balance first (deposit once): copiers' fees are paid into it");
  const creatorName = String(body?.creatorName ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 24) || short(wallet.toBase58());
  const w = wallet.toBase58();
  const prev = (await pool.query("select coalesce(max(version), 0) as v from sol_strategies where creator = $1 and name = $2", [w, name])).rows[0];
  const id = randomUUID();
  await pool.query(
    `insert into sol_strategies (strategy_id, creator, creator_name, name, description, version, profile) values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, w, creatorName, name, description, Number(prev.v) + 1, JSON.stringify(profile)]);
  if (Number(prev.v) > 0) await pool.query("update sol_strategies set listed = false where creator = $1 and name = $2 and strategy_id <> $3", [w, name, id]);
  return get(id);
}

export async function unlist(wallet: PublicKey, strategyId: unknown) {
  if (!isId(strategyId)) throw new StrategyError("bad strategy id");
  const r = await pool.query("update sol_strategies set listed = false where strategy_id = $1 and creator = $2", [strategyId, wallet.toBase58()]);
  if (!r.rowCount) throw new StrategyError("not your strategy");
  return { ok: true };
}

// Track record (review 20 Oct): every hand the strategy's Agents played in sessions that ended, whether or not the seat
// was cashed out (taking the seat back used to drop the session, so a creator could hide losing ones), in big blinds
// (each table's own), so stakes don't decide the ranking. A hand's result is its stack after it minus the one before.
const HANDS_SQL = `
  with hn as (
    select a.strategy_id, a.wallet, a.id as sid,
           (h.stack_after - coalesce(lag(h.stack_after) over (partition by h.session_id order by h.hand_no), a.buy_in))::float8
             / greatest(1, coalesce(t.big_blind, a.buy_in / 50))::float8 as nb
      from agent_sessions a
      join agent_hands h on h.session_id = a.id
      left join tables t on t.address = a.table_address
     where a.strategy_id is not null and a.ended_at is not null)`;
const TRACK_RECORD_SQL = `
  count(distinct a.wallet)::int as copiers,
  count(distinct a.id)::int as sessions,
  coalesce((select count(*) from hn where hn.strategy_id = s.strategy_id), 0)::bigint as hands,
  coalesce(sum(a.cash_out - a.buy_in) filter (where a.cash_out is not null), 0)::bigint as net,
  coalesce(sum(a.creator_fee), 0)::bigint as creator_fees,
  (select avg(nb) from hn where hn.strategy_id = s.strategy_id) as mean_bb,
  (select stddev_samp(nb) from hn where hn.strategy_id = s.strategy_id) as sd_bb`;
const FROM_SQL = `from sol_strategies s left join agent_sessions a on a.strategy_id = s.strategy_id and a.ended_at is not null`;

function toPublic(r: any, rates: FeeRates, now = new Date()) {
  const profile: Profile = typeof r.profile === "string" ? JSON.parse(r.profile) : r.profile;
  const hands = Number(r.hands ?? 0), net = Number(r.net ?? 0);
  const mean = r.mean_bb == null ? 0 : Number(r.mean_bb), sd = r.sd_bb == null ? 0 : Number(r.sd_bb);
  const bb100 = mean * 100, se100 = hands > 1 ? (sd / Math.sqrt(hands)) * 100 : Infinity;
  const score = hands > 1 && sd > 0 ? (mean / sd) * (hands / (hands + SCORE_HALF_HANDS)) : null;
  const ageDays = (now.getTime() - new Date(r.created_at).getTime()) / 86_400_000;
  const ok = qualifies(hands, ageDays, bb100, se100);
  const b = behaviour(profile as any);
  return {
    strategyId: r.strategy_id, name: r.name, description: r.description, version: r.version, creator: r.creator, creatorName: r.creator_name,
    listed: r.listed, profile, tags: tags(profile), behaviour: b, style: styleCell(b),
    record: {
      copiers: Number(r.copiers ?? 0), sessions: Number(r.sessions ?? 0), hands, net, per100Hands: hands ? Math.round((net * 100) / hands) : 0,
      bb100: Math.round(bb100), se100: Number.isFinite(se100) ? Math.round(se100) : null, swing: Math.round(sd * 10) / 10,
      vsHouse: Math.round(bb100 - HOUSE_BB100), score: score == null ? null : Math.round(score * 1000) / 1000,
    },
    verified: hands >= VERIFIED_HANDS,
    // Others may copy it once its record qualifies (the creator's own Agent runs build it).
    qualified: ok,
    copyable: r.listed && ok,
    listing: { minHands: LISTING.minHands, minDays: LISTING.minDays, house: HOUSE_BB100, handsLeft: Math.max(0, LISTING.minHands - hands) },
    fees: { creatorBps: rates.creatorBps, creatorPercent: rates.creatorBps / 100, platformBps: rates.platformBps, platformPercent: rates.platformBps / 100 },
    createdAt: r.created_at,
  };
}

async function records(where: string, params: unknown[]) {
  const rows = (await pool.query(`${HANDS_SQL} select s.*, ${TRACK_RECORD_SQL} ${FROM_SQL} where ${where} group by s.strategy_id`, params)).rows;
  const rates = await ratesOrDefault();
  return rows.map((r) => toPublic(r, rates));
}

/** The lists (as the Coins marketplace): "styles" (the best of each style cell), "new" (New and promising), "top",
 *  "popular"; `style` keeps one cell. */
export async function list(sort = "top", limit = 30, style?: string) {
  let all = await records(`s.listed`, []);
  if (style) all = all.filter((x) => x.style === style);
  const byScore = (a: any, b: any) => (b.record.score ?? -1e9) - (a.record.score ?? -1e9);
  const n = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 30));
  if (sort === "new") {
    const since = Date.now() - NEW_DAYS * 86_400_000;
    return all.filter((x) => new Date(x.createdAt).getTime() >= since && x.record.hands >= NEW_MIN_HANDS).sort(byScore).slice(0, n);
  }
  const ok = all.filter((x) => x.qualified);
  if (sort === "popular") return ok.sort((a, b) => b.record.copiers - a.record.copiers || byScore(a, b)).slice(0, n);
  if (sort === "styles") {
    const best = new Map<string, any>();
    for (const x of ok.sort(byScore)) if (!best.has(x.style)) best.set(x.style, x);
    return [...best.values()].slice(0, n);
  }
  return ok.sort(byScore).slice(0, n);
}

export async function get(strategyId: unknown) {
  if (!isId(strategyId)) throw new StrategyError("bad strategy id");
  const [r] = await records(`s.strategy_id = $1`, [strategyId]);
  if (!r) throw new StrategyError("that strategy doesn't exist");
  const similar = (await records(`s.listed and s.strategy_id <> $1`, [strategyId]))
    .map((o) => ({ o, d: distance(r.behaviour, o.behaviour) })).filter((x) => x.d <= 2).sort((a, b) => a.d - b.d).slice(0, 3)
    .map(({ o }) => ({ strategyId: o.strategyId, name: o.name, creatorName: o.creatorName, style: o.style, record: o.record }));
  return { ...r, similar };
}

/** The creator's strategies and what their copiers' Agents paid them (lamports). */
export async function dashboard(wallet: PublicKey) {
  const w = wallet.toBase58();
  const rows = (await records(`s.creator = $1`, [w])).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const fees = (await pool.query(`select coalesce(sum(a.creator_fee), 0)::bigint as earned from agent_sessions a join sol_strategies s on s.strategy_id = a.strategy_id where s.creator = $1`, [w])).rows[0];
  return { strategies: rows, earned: String(fees.earned ?? 0), listing: LISTING };
}

/** The strategy an Agent plays and the fee terms its record must carry: none when the creator runs their own
 *  (always allowed: that builds its record); for anyone else only once it's listed and qualifies. */
export async function termsFor(strategyId: unknown, copier: PublicKey): Promise<{ profile: Profile; terms: FeeTerms | null; name: string }> {
  const s = await get(strategyId);
  if (s.creator === copier.toBase58()) return { profile: s.profile, name: s.name, terms: null };
  if (!s.copyable) throw new StrategyError(!s.listed ? "that strategy isn't listed any more"
    : `that strategy can't be copied yet: it needs ${LISTING.minHands} Agent hands over ${LISTING.minDays} days (${s.record.hands} so far) and a result that beats Autopilot`);
  const rates = await feeRates();
  return { profile: s.profile, name: s.name, terms: { creator: new PublicKey(s.creator), creatorFeeBps: rates.creatorBps, platformFeeBps: rates.platformBps } };
}

/** Tables a copier's Agent must avoid: where another Agent copying the same strategy, or the creator's own Agent,
 *  sits (docs §5, collusion). */
export async function tablesToAvoid(wallet: string, strategyId: string | undefined, creator: string | undefined): Promise<Set<string>> {
  if (!strategyId) return new Set();
  const rows = (await pool.query(
    "select distinct table_address from agent_sessions where ended_at is null and wallet <> $1 and (strategy_id = $2 or wallet = $3)", [wallet, strategyId, creator ?? ""])).rows;
  return new Set(rows.map((r) => r.table_address));
}

/** Marketplace style tags from what the strategy does (styleTags.ts, the same as the Coins marketplace). */
function tags(p: Profile): string[] {
  return styleTags(p as any);
}
