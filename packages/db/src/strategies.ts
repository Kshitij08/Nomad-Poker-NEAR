import type { StreetProfileSnapshot } from '@nomad/engine/agents';
import type { AgentStrategy } from './agents';
import { coach, coachNote, type HandResult, type Report } from './style/coach';
import { clampProfile, PRESETS, STREETS, tags, type Profile } from './style/profile';
import { fitTwin, type Action, type Decision, type Twin } from './style/style';
import { alike, behaviour, distance, styleCell, type Behaviour } from './style/styleTags';
import { fail } from './util';

/**
 * Play style records, "My Twin", the coach, and the Coins copy-strategy marketplace (migrations/0005), ported from the
 * backend's StrategyService. The profit share itself is settled when a copied Agent completes (agents.ts), as ledger
 * entries in the same batch.
 */

export const TWIN_WINDOW = 3000;
export const MIN_TWIN_DECISIONS_TO_PUBLISH = 300;
/** What a strategy needs before others can copy it (hands, days since publishing, and a result that beats Autopilot). */
export interface ListingRules {
  minHands: number;
  minDays: number;
  /** Autopilot's simulated bb/100 until its own sessions have houseMinHands hands. */
  houseBb100: number;
  houseMinHands: number;
}
export const DEFAULT_LISTING: ListingRules = { minHands: 2000, minDays: 7, houseBb100: 371, houseMinHands: 2000 };
const NEW_DAYS = 30;
const NEW_MIN_HANDS = 300;
const SCORE_HALF_HANDS = 2000;

const ACTIONS = new Set<Action>(['fold', 'check', 'call', 'bet', 'raise']);
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};

// ---- Recording (the game server, from its Coins tables) ---------------------------------------------------------------

export interface DecisionRow extends Decision {
  playerId: string;
  table: string;
  handNo: number;
  stack: number;
  /** Milliseconds from the table asking to the action arriving (bot detection). */
  thinkMs?: number | null;
}

export interface StyleHandRow {
  playerId: string;
  table: string;
  handNo: number;
  position: number;
  bigBlind: number;
  net: number;
  showdown: boolean;
  won: boolean;
}

/** Decisions from a table. Rows that don't make sense are skipped. */
export async function recordDecisions(db: D1Database, rows: DecisionRow[], now = Date.now()): Promise<number> {
  const ok = rows.slice(0, 500).filter((r) => {
    const v = [r.handNo, r.street, r.position, r.opponents, r.pot, r.toCall, r.minRaiseTo, r.bigBlind, r.stack, r.amount ?? 0].map(int);
    return !!r.playerId && !!r.table && ACTIONS.has(r.action) && v.every(Number.isFinite) && r.strength >= 0 && r.strength <= 1;
  });
  if (!ok.length) return 0;
  await db.batch(
    ok.map((r) =>
      db
        .prepare(
          `INSERT INTO style_decisions (player_id, table_name, hand_no, street, position, opponents, strength, pot, to_call, min_raise_to,
             big_blind, stack, action, amount, created_at, think_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        )
        .bind(r.playerId, r.table, int(r.handNo), int(r.street), int(r.position), int(r.opponents), r.strength, int(r.pot), int(r.toCall),
          int(r.minRaiseTo), int(r.bigBlind), int(r.stack), r.action, int(r.amount ?? 0), now,
          r.thinkMs != null && Number.isFinite(r.thinkMs) ? Math.max(0, Math.min(600_000, Math.round(r.thinkMs))) : null),
    ),
  );
  return ok.length;
}

export async function recordStyleHands(db: D1Database, rows: StyleHandRow[], now = Date.now()): Promise<number> {
  const ok = rows.slice(0, 50).filter((r) => !!r.playerId && !!r.table && [r.handNo, r.position, r.bigBlind, r.net].map(int).every(Number.isFinite));
  if (!ok.length) return 0;
  await db.batch(
    ok.map((r) =>
      db
        .prepare(
          `INSERT INTO style_hands (player_id, table_name, hand_no, position, big_blind, net, showdown, won, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT DO NOTHING`,
        )
        .bind(r.playerId, r.table, int(r.handNo), int(r.position), int(r.bigBlind), int(r.net), r.showdown ? 1 : 0, r.won ? 1 : 0, now),
    ),
  );
  return ok.length;
}

// ---- Twin and coach (the player) ------------------------------------------------------------------------------------

interface DecisionDb {
  table_name: string;
  hand_no: number;
  street: number;
  position: number;
  opponents: number;
  strength: number;
  pot: number;
  to_call: number;
  min_raise_to: number;
  big_blind: number;
  action: Action;
  amount: number;
}

async function decisions(db: D1Database, playerId: string, limit = TWIN_WINDOW): Promise<(Decision & { table: string; handNo: number })[]> {
  const r = await db.prepare('SELECT * FROM style_decisions WHERE player_id = ?1 ORDER BY id DESC LIMIT ?2').bind(playerId, limit).all<DecisionDb>();
  return r.results.map((d) => ({
    table: d.table_name, handNo: d.hand_no, street: d.street, position: d.position, opponents: d.opponents, strength: d.strength,
    pot: d.pot, toCall: d.to_call, minRaiseTo: d.min_raise_to, bigBlind: d.big_blind, action: d.action, amount: d.amount,
  }));
}

export async function twin(db: D1Database, playerId: string): Promise<Twin & { tags: string[] }> {
  const t = fitTwin(await decisions(db, playerId));
  return { ...t, tags: tags(t.profile) };
}

type CoachOut = Report & { note: string | null; noteModel: string | null };
const coachCache = new Map<string, { at: number; report: CoachOut }>();

/** Stats, leaks and advice; with a NEAR AI note when a key is configured (cached 10 minutes per player per isolate). */
export async function coachReport(
  db: D1Database,
  playerId: string,
  opts: { apiKey?: string | null; model?: string | null; now?: number } = {},
): Promise<CoachOut> {
  const now = opts.now ?? Date.now();
  const cached = coachCache.get(playerId);
  if (cached && now - cached.at < 10 * 60_000) return cached.report;
  const ds = await decisions(db, playerId, 2000);
  const r = await db
    .prepare('SELECT * FROM style_hands WHERE player_id = ?1 ORDER BY created_at DESC LIMIT 500')
    .bind(playerId)
    .all<{ table_name: string; hand_no: number; position: number; big_blind: number; net: number; showdown: number; won: number }>();
  const hands: HandResult[] = r.results.map((h) => ({
    table: h.table_name, handNo: h.hand_no, position: h.position, bigBlind: h.big_blind, net: h.net, showdown: !!h.showdown, won: !!h.won,
  }));
  const report = coach(ds, hands);
  const n = await coachNote(report, { apiKey: opts.apiKey, model: opts.model });
  const out: CoachOut = { ...report, note: n?.text ?? null, noteModel: n?.model ?? null };
  coachCache.set(playerId, { at: now, report: out });
  return out;
}

// ---- The marketplace ------------------------------------------------------------------------------------------------

export interface PublicStrategy {
  strategyId: string;
  name: string;
  description: string;
  version: number;
  creatorId: string;
  creatorName: string;
  source: 'custom' | 'twin';
  listed: boolean;
  profile: Profile;
  tags: string[];
  behaviour: Behaviour;
  style: string;
  record: {
    copiers: number;
    sessions: number;
    hands: number;
    net: number;
    per100Hands: number;
    bb100: number;
    se100: number | null;
    swing: number;
    vsHouse: number;
    score: number | null;
  };
  verified: boolean;
  qualified: boolean;
  listing: { minHands: number; minDays: number; house: number };
  fees: { creatorPercent: number; platformPercent: number };
  createdAt: string;
}

/** The stake's big blind (StakeCatalog tiers), else buy-in / 20. */
const BB_SQL = `(CASE d.stake WHEN 50 THEN 2 WHEN 100 THEN 5 WHEN 500 THEN 25 WHEN 1000 THEN 50 WHEN 5000 THEN 250 WHEN 10000 THEN 500 ELSE max(1, d.stake / 20) END)`;

interface RecordRow {
  id: string;
  creator_id: string;
  creator_code: string | null;
  creator_name: string;
  name: string;
  description: string;
  version: number;
  profile: string;
  source: 'custom' | 'twin';
  listed: number;
  created_at: number;
  copiers: number;
  sessions: number;
  hands: number;
  net: number | null;
  sum_bb: number | null;
  sum_bb2: number | null;
}

/** Strategies matching `where` (on s.*) with their track record: every hand their Agents played, in big blinds. */
async function records(db: D1Database, where: string, params: unknown[], rules: ListingRules, now: number): Promise<PublicStrategy[]> {
  const r = await db
    .prepare(
      `SELECT s.*, (SELECT friend_code FROM players WHERE id = s.creator_id) AS creator_code, count(DISTINCT d.owner_id) AS copiers, count(DISTINCT d.id) AS sessions, count(h.hand_number) AS hands,
         sum(h.net) AS net, sum(h.net * 1.0 / ${BB_SQL}) AS sum_bb, sum((h.net * 1.0 / ${BB_SQL}) * (h.net * 1.0 / ${BB_SQL})) AS sum_bb2
       FROM strategies s
       LEFT JOIN agent_deployments d ON d.strategy_id = s.id AND d.phase IN ('completed', 'failed')
       LEFT JOIN agent_hands h ON h.deployment_id = d.id
       WHERE ${where}
       GROUP BY s.id`,
    )
    .bind(...params)
    .all<RecordRow>();
  const house = await houseBb100(db, rules, now);
  return r.results.map((row) => toPublic(row, now, house, rules));
}

/**
 * The bar a strategy must beat: what Autopilot itself made over the last 30 days (sessions tagged Autopilot, playing
 * its numbers), or the simulated figure until it has enough hands.
 */
export async function houseBb100(db: D1Database, rules: ListingRules = DEFAULT_LISTING, now = Date.now()): Promise<number> {
  const r = await db
    .prepare(
      `SELECT count(h.hand_number) AS n, avg(h.net * 1.0 / ${BB_SQL}) AS mean
       FROM agent_deployments d JOIN agent_hands h ON h.deployment_id = d.id
       WHERE d.strategy_version = 'v1-nomad-autopilot' AND d.strategy_id IS NULL
         AND abs(json_extract(d.strategy, '$.foldBelow') - 0.35) < 0.005
         AND abs(json_extract(d.strategy, '$.raiseAbove') - 0.58) < 0.005
         AND abs(json_extract(d.strategy, '$.aggression') - 0.45) < 0.005
         AND h.created_at > ?1`,
    )
    .bind(now - 30 * 86_400_000)
    .first<{ n: number; mean: number | null }>();
  return (r?.n ?? 0) >= rules.houseMinHands && r?.mean != null ? r.mean * 100 : rules.houseBb100;
}

function toPublic(r: RecordRow, now: number, house: number, rules: ListingRules): PublicStrategy {
  let profile: Profile;
  try {
    profile = JSON.parse(r.profile) as Profile;
  } catch {
    profile = PRESETS.tactician!;
  }
  const hands = Number(r.hands ?? 0);
  const mean = hands ? Number(r.sum_bb ?? 0) / hands : 0;
  const variance = hands > 1 ? Math.max(0, (Number(r.sum_bb2 ?? 0) - hands * mean * mean) / (hands - 1)) : 0;
  const sd = Math.sqrt(variance);
  const bb100 = mean * 100;
  const se100 = hands > 1 ? (sd / Math.sqrt(hands)) * 100 : Infinity;
  // Score: win rate per unit of swing, counted fully only with enough hands.
  const score = hands > 1 && sd > 0 ? (mean / sd) * (hands / (hands + SCORE_HALF_HANDS)) : null;
  const ageDays = (now - r.created_at) / 86_400_000;
  const vsHouse = bb100 - house;
  const b = behaviour(profile as never);
  return {
    // The creator's public Friend ID, never the internal player id.
    strategyId: r.id, name: r.name, description: r.description, version: r.version, creatorId: r.creator_code ?? '', creatorName: r.creator_name,
    source: r.source, listed: !!r.listed, profile, tags: tags(profile), behaviour: b, style: styleCell(b),
    record: {
      copiers: Number(r.copiers ?? 0), sessions: Number(r.sessions ?? 0), hands, net: Number(r.net ?? 0),
      per100Hands: hands ? Math.round((Number(r.net ?? 0) * 100) / hands) : 0,
      bb100: Math.round(bb100), se100: Number.isFinite(se100) ? Math.round(se100) : null, swing: Math.round(sd * 10) / 10,
      vsHouse: Math.round(vsHouse), score: score == null ? null : Math.round(score * 1000) / 1000,
    },
    verified: hands >= rules.minHands,
    qualified: hands >= rules.minHands && ageDays >= rules.minDays && Number.isFinite(se100) && vsHouse > se100,
    listing: { minHands: rules.minHands, minDays: rules.minDays, house: Math.round(house) },
    fees: { creatorPercent: 8, platformPercent: 2 },
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * The marketplace lists: "top" (qualified, by score), "styles" (the best qualified per style cell), "new" (under 30 days
 * with 300+ hands, qualified or not), "popular" (qualified, by copiers). `style` keeps one cell ("Loose Aggressive"…).
 */
const listCache = new Map<string, { at: number; value: PublicStrategy[] }>();
/** How long one isolate reuses a computed list (the query joins every copied hand; the list is anonymous). */
export const LIST_CACHE_MS = 60_000;

export async function listStrategies(
  db: D1Database,
  q: { sort?: string; limit?: number; style?: string | null },
  rules: ListingRules = DEFAULT_LISTING,
  now = Date.now(),
  cache = true,
): Promise<PublicStrategy[]> {
  const key = JSON.stringify([q.sort ?? 'top', q.limit ?? 30, q.style ?? null, rules]);
  const hit = cache ? listCache.get(key) : undefined;
  if (hit && now - hit.at < LIST_CACHE_MS) return hit.value;
  const value = await listStrategiesUncached(db, q, rules, now);
  if (cache) listCache.set(key, { at: now, value });
  return value;
}

async function listStrategiesUncached(
  db: D1Database,
  q: { sort?: string; limit?: number; style?: string | null },
  rules: ListingRules,
  now: number,
): Promise<PublicStrategy[]> {
  let all = await records(db, 's.listed = 1', [], rules, now);
  if (q.style) all = all.filter((x) => x.style === q.style);
  const byScore = (a: PublicStrategy, b: PublicStrategy) => (b.record.score ?? -1e9) - (a.record.score ?? -1e9);
  const n = Math.min(100, Math.max(1, Math.trunc(q.limit ?? 30) || 30));
  if (q.sort === 'new') {
    const since = now - NEW_DAYS * 86_400_000;
    return all.filter((x) => Date.parse(x.createdAt) >= since && x.record.hands >= NEW_MIN_HANDS).sort(byScore).slice(0, n);
  }
  const qualified = all.filter((x) => x.qualified);
  if (q.sort === 'popular') return qualified.sort((a, b) => b.record.copiers - a.record.copiers || byScore(a, b)).slice(0, n);
  if (q.sort === 'styles') {
    const best = new Map<string, PublicStrategy>();
    for (const x of qualified.sort(byScore)) if (!best.has(x.style)) best.set(x.style, x);
    return [...best.values()].slice(0, n);
  }
  return qualified.sort(byScore).slice(0, n);
}

export async function getStrategy(db: D1Database, id: string, rules: ListingRules = DEFAULT_LISTING, now = Date.now()) {
  const s = (await records(db, 's.id = ?1', [id], rules, now))[0];
  if (!s) fail(404, 'not_found', "That strategy doesn't exist.");
  const similar = (await records(db, 's.listed = 1 AND s.id <> ?1', [id], rules, now))
    .map((o) => ({ o, d: distance(s.behaviour, o.behaviour) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ o }) => ({ strategyId: o.strategyId, name: o.name, creatorName: o.creatorName, style: o.style, record: o.record }));
  return { ...s, similar };
}

/** Publishes a frozen strategy (from the creator's twin, or a custom profile). Re-publishing a name adds a version. */
export async function publishStrategy(
  db: D1Database,
  creator: { id: string; display_name: string },
  body: { name?: unknown; description?: unknown; fromTwin?: unknown; profile?: unknown },
  rules: ListingRules = DEFAULT_LISTING,
  now = Date.now(),
) {
  const name = String(body?.name ?? '').trim().slice(0, 40);
  if (name.length < 3) fail(400, 'bad_request', 'Give your strategy a name (3–40 letters).');
  const description = String(body?.description ?? '').trim().slice(0, 280);
  let profile: Profile;
  let source: 'custom' | 'twin';
  if (body?.fromTwin) {
    const t = await twin(db, creator.id);
    if (t.decisions < MIN_TWIN_DECISIONS_TO_PUBLISH) {
      fail(400, 'bad_request', `Play a few more hands first: your twin has ${t.decisions} of ${MIN_TWIN_DECISIONS_TO_PUBLISH} decisions.`);
    }
    profile = t.profile;
    source = 'twin';
  } else {
    try {
      profile = clampProfile((body?.profile ?? {}) as Partial<Profile>);
    } catch (e) {
      fail(400, 'bad_request', (e as Error).message);
    }
    source = 'custom';
  }
  // A strategy that plays like one already listed (and qualified) by someone else isn't a new strategy.
  const mine = behaviour(profile as never);
  for (const other of await records(db, 's.listed = 1 AND s.creator_id <> ?1', [creator.id], rules, now)) {
    if (other.qualified && alike(mine, other.behaviour)) {
      fail(409, 'conflict', `That plays like "${other.name}" by ${other.creatorName}, which is already listed. Change how many hands it plays, its pressure, bluffing or bet size.`);
    }
  }
  const prev = await db.prepare('SELECT coalesce(max(version), 0) AS v FROM strategies WHERE creator_id = ?1 AND name = ?2').bind(creator.id, name).first<{ v: number }>();
  const version = Number(prev?.v ?? 0) + 1;
  const id = crypto.randomUUID();
  await db.batch([
    // Older versions leave the listing; their copiers keep them.
    db.prepare('UPDATE strategies SET listed = 0 WHERE creator_id = ?1 AND name = ?2').bind(creator.id, name),
    db
      .prepare(
        `INSERT INTO strategies (id, creator_id, creator_name, name, description, version, profile, source, listed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)`,
      )
      .bind(id, creator.id, creator.display_name, name, description, version, JSON.stringify(profile), source, now),
  ]);
  return getStrategy(db, id, rules, now);
}

export async function unlistStrategy(db: D1Database, creatorId: string, id: string): Promise<void> {
  const r = await db.prepare('UPDATE strategies SET listed = 0 WHERE id = ?1 AND creator_id = ?2').bind(id, creatorId).run();
  if (!r.meta.changes) fail(404, 'not_found', 'Not your strategy.');
}

/** The creator's dashboard: their strategies and what copiers earned them (paid at settlement, so earned = paid). */
export async function creatorDashboard(db: D1Database, creatorId: string, rules: ListingRules = DEFAULT_LISTING, now = Date.now()) {
  const mine = (await records(db, 's.creator_id = ?1', [creatorId], rules, now)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const f = await db
    .prepare('SELECT coalesce(sum(creator_fee), 0) AS earned, count(*) AS n FROM copy_fees WHERE creator_id = ?1')
    .bind(creatorId)
    .first<{ earned: number; n: number }>();
  const earned = Number(f?.earned ?? 0);
  return { strategies: mine, earned, paid: earned, settlements: Number(f?.n ?? 0) };
}

/** A market strategy's profile as the Agent's numbers (BotProfileSnapshot fields), with its per-street overrides. */
export function agentStrategyOf(p: Profile): AgentStrategy {
  const streets: StreetProfileSnapshot[] | null = p.streets
    ? STREETS.map((st) => {
        const o = p.streets?.[st];
        return o
          ? { HasValue: true, FoldBelow: o.foldBelow, RaiseAbove: o.raiseAbove, Aggression: o.aggression, BluffChance: o.bluffChance, RaiseFractionOfPot: o.raiseFractionOfPot }
          : { HasValue: false, FoldBelow: 0, RaiseAbove: 0, Aggression: 0, BluffChance: 0, RaiseFractionOfPot: 0 };
      })
    : null;
  return {
    hasCustom: true, foldBelow: p.foldBelow, raiseAbove: p.raiseAbove, aggression: p.aggression, bluffChance: p.bluffChance,
    raiseFractionOfPot: p.raiseFractionOfPot, positionWeight: p.positionWeight ?? 0, brain: p.brain ?? 0, streets,
  };
}

/**
 * The numbers a copied Agent plays: the published profile, never what the client sent. Others may copy only a listed
 * strategy with a proven record; its creator may always run it (that builds the record).
 */
export async function strategyForAgent(db: D1Database, id: string, ownerId: string, rules: ListingRules = DEFAULT_LISTING, now = Date.now()): Promise<AgentStrategy> {
  const s = (await records(db, 's.id = ?1', [id], rules, now))[0];
  if (!s) fail(404, 'not_found', "That strategy doesn't exist.");
  const creator = await db.prepare('SELECT creator_id FROM strategies WHERE id = ?1').bind(id).first<{ creator_id: string }>();
  if (creator?.creator_id !== ownerId && (!s.listed || !s.qualified)) {
    fail(403, 'forbidden', `That strategy can't be copied yet: it needs ${rules.minHands.toLocaleString('en-US')} hands over ${rules.minDays} days and a result that beats Autopilot.`);
  }
  return agentStrategyOf(s.profile);
}
