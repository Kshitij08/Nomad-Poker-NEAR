import { sessionPlayer } from './accounts';
import { conditionalPostingStatement, isInsufficientFunds, postingStatement } from './ledger';
import { fail, sha256Hex } from './util';

/**
 * Hosted round-format tournaments (migrations/0005), ported from the backend's TournamentService. The API creates and
 * registers; the game server's tournament room reads the roster, says when it started, heartbeats, and posts the result;
 * the game server's minute cron moves the clock (lock at the start time, abort a tournament nobody started or whose
 * server went quiet).
 *
 * Money: every move is a ledger entry in the same D1 batch as the change it pays for, keyed so a retry never repeats it:
 * the host prize ('trn:<id>:host_prize', raises 'trn:<id>:raise:<n>'), entry fees ('trn:<id>:entry:<attempt>'), refunds
 * ('trn:<id>:refund:<attempt>', 'trn:<id>:refund:host') and prizes ('trn:<id>:payout:<place>'). A debit that would
 * overdraw aborts its whole batch, so nobody is ever registered without having paid.
 *
 * Players are named by their public Friend ID (friend_code) everywhere outside the database: views, the roster the
 * tournament room plays with, and the standings it posts back.
 */

export type Speed = 'turbo' | 'regular' | 'slow';
export type Visibility = 'public' | 'private';
export type TournamentStatus = 'registering' | 'locked' | 'running' | 'finished' | 'cancelled' | 'aborted';

export interface TournamentRow {
  id: string;
  name: string;
  host_id: string;
  entry_fee: number;
  host_prize: number;
  prize_raises: number;
  visibility: Visibility;
  join_code: string;
  session_name: string;
  starts_at: number;
  speed: Speed;
  max_players: number;
  status: TournamentStatus;
  cancel_reason: string;
  locked_at: number | null;
  started_at: number | null;
  last_heartbeat_at: number | null;
  progress_seq: number;
  last_progress: string | null;
  finished_at: number | null;
  result: string | null;
  result_hash: string | null;
  created_at: number;
  updated_at: number;
}

/** The client's view (TournamentInfo in the web client: flat, no nulls). */
export interface TournamentView {
  id: string;
  name: string;
  hostPlayFabId: string;
  hostName: string;
  currency: 'coins';
  entryFee: number;
  hostPrize: number;
  prizePool: number;
  firstPrize: number;
  secondPrize: number;
  visibility: Visibility;
  joinCode: string;
  startsAt: string;
  startsAtUnix: number;
  speed: Speed;
  maxPlayers: number;
  players: number;
  format: 'cancelled' | 'single' | 'two_tables' | 'four_tables';
  status: TournamentStatus;
  cancelReason: string;
  myStatus: string;
  myPlace: number;
  myPrize: number;
  serverReady: boolean;
  sessionName: string;
}

export interface TournamentRules {
  /** Earliest a new tournament may start (10 minutes; staging shortens it for test runs). */
  minLeadMs: number;
  maxLeadMs: number;
  maxActivePerHost: number;
}
export const DEFAULT_RULES: TournamentRules = { minLeadMs: 10 * 60_000, maxLeadMs: 14 * 86_400_000, maxActivePerHost: 2 };

/** Players may connect from this long before the start; the game server opens the room then. */
export const SPAWN_LEAD_MS = 3 * 60_000;
export const START_GRACE_MS = 3 * 60_000;
export const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;
const EDIT_FREEZE_MS = 5 * 60_000;
const MAX_ENTRY_FEE = 1_000_000;
const MAX_HOST_PRIZE = 10_000_000;
export const MAX_POOL = 2_147_483_647;
const OPEN = `('registering', 'locked', 'running')`;

// ---- Codes and prize maths --------------------------------------------------------------------------------------------

const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I: typed off a friend's screen
const SESSION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function pick(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length]; // 32 symbols: no modulo bias
  return out;
}

export const newJoinCode = (): string => pick(JOIN_ALPHABET, 6);
/** The game server room. Kept apart from the join code: knowing the code lets you register, not connect. */
export const newSessionName = (): string => 'TRN' + pick(SESSION_ALPHABET, 10);
export const normalizeJoinCode = (raw: unknown): string => String(raw ?? '').trim().toUpperCase();
export const isJoinCode = (code: string): boolean => code.length === 6 && [...code].every((c) => JOIN_ALPHABET.includes(c));
/** A hosted tournament room (TRN + 10): the game server's Durable Object name. */
export const isTournamentSessionName = (s: string): boolean => /^TRN[A-Z2-7]{10}$/.test(s);

export interface Payout {
  pool: number;
  fee: number;
  first: number;
  second: number;
}

/** PayoutCalculator: the host prize plus every paid entry; 2nd gets 40 % rounded down, 1st the rest. */
export function computePayout(hostPrize: number, entryFee: number, paidEntrants: number, feeBps = 0): Payout {
  const entries = entryFee * paidEntrants;
  const pool = hostPrize + entries;
  const fee = Math.floor((entries * feeBps) / 10_000);
  const net = pool - fee;
  const second = Math.floor((net * 4000) / 10_000);
  return { pool, fee, first: net - second, second };
}

/** RoundPlanner's split, so the page can say what the field will play. */
export function formatFor(players: number): TournamentView['format'] {
  if (players < 2) return 'cancelled';
  if (players <= 7) return 'single';
  if (players <= 15) return 'two_tables';
  return 'four_tables';
}

// ---- Reading ------------------------------------------------------------------------------------------------------------

const unix = (ms: number) => Math.floor(ms / 1000);
const SELECT = `SELECT t.*, h.display_name AS host_name, h.friend_code AS host_code,
  (SELECT count(*) FROM tournament_entries e2 WHERE e2.tournament_id = t.id AND e2.status IN ('registered', 'playing', 'finished')) AS players
  FROM tournaments t JOIN players h ON h.id = t.host_id`;
type Row = TournamentRow & { host_name: string; host_code: string | null; players: number };
interface EntryRow {
  status: string;
  place: number;
  prize: number;
  paid_amount: number;
  attempt: number;
}

function view(row: Row, entry: EntryRow | null, viewerId: string | null, now: number, showCode = row.visibility === 'public'): TournamentView {
  const players = Number(row.players ?? 0);
  const estimate = computePayout(row.host_prize, row.entry_fee, players);
  const myStatus = entry?.status ?? '';
  const isHost = viewerId !== null && viewerId === row.host_id;
  // Where the room is: its players and the host learn it once the room may be open (a few minutes before the start).
  const roomOpen = (row.status === 'registering' || row.status === 'locked' || row.status === 'running') && now >= row.starts_at - SPAWN_LEAD_MS && players >= 2;
  const mayConnect = roomOpen && (myStatus === 'registered' || myStatus === 'playing' || isHost);
  return {
    id: row.id,
    name: row.name,
    hostPlayFabId: row.host_code ?? '',
    hostName: row.host_name ?? '',
    currency: 'coins',
    entryFee: row.entry_fee,
    hostPrize: row.host_prize,
    prizePool: estimate.pool - estimate.fee,
    firstPrize: estimate.first,
    secondPrize: estimate.second,
    visibility: row.visibility,
    joinCode: showCode || isHost || !!entry ? row.join_code : '',
    startsAt: new Date(row.starts_at).toISOString(),
    startsAtUnix: unix(row.starts_at),
    speed: row.speed,
    maxPlayers: row.max_players,
    players,
    format: formatFor(players),
    status: row.status,
    cancelReason: row.cancel_reason ?? '',
    myStatus,
    myPlace: entry?.place ?? 0,
    myPrize: entry?.prize ?? 0,
    serverReady: mayConnect,
    sessionName: mayConnect ? row.session_name : '',
  };
}

async function findRow(db: D1Database, id: string): Promise<Row | null> {
  return db.prepare(`${SELECT} WHERE t.id = ?1`).bind(id).first<Row>();
}

async function entryOf(db: D1Database, id: string, playerId: string | null): Promise<EntryRow | null> {
  if (!playerId) return null;
  return db
    .prepare('SELECT status, place, prize, paid_amount, attempt FROM tournament_entries WHERE tournament_id = ?1 AND player_id = ?2')
    .bind(id, playerId)
    .first<EntryRow>();
}

const notFound = (): never => fail(404, 'not_found', 'Tournament not found.');

export async function tournamentView(db: D1Database, id: string, viewerId: string | null, now = Date.now()): Promise<{ serverNowUnix: number; tournament: TournamentView }> {
  const row = await findRow(db, id);
  if (!row) notFound();
  const entry = await entryOf(db, id, viewerId);
  return { serverNowUnix: unix(now), tournament: view(row!, entry, viewerId, now) };
}

export async function tournamentByCode(db: D1Database, rawCode: string, viewerId: string | null, now = Date.now()) {
  const code = normalizeJoinCode(rawCode);
  if (!isJoinCode(code)) fail(400, 'bad_request', "That isn't a tournament code.");
  const row = await db.prepare(`${SELECT} WHERE t.join_code = ?1`).bind(code).first<Row>();
  if (!row) fail(404, 'not_found', 'No tournament has that code.');
  const entry = await entryOf(db, row!.id, viewerId);
  return { serverNowUnix: unix(now), tournament: view(row!, entry, viewerId, now, true) };
}

export async function listTournaments(db: D1Database, filter: string, limit = 50, now = Date.now()) {
  const lim = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  const where =
    filter === 'running' ? `t.status IN ('locked', 'running')`
    : filter === 'finished' ? `t.status = 'finished' AND t.finished_at > ?1 - 604800000`
    : `t.status = 'registering' AND t.starts_at > ?1`;
  const order = filter === 'finished' ? 't.finished_at DESC' : 't.starts_at ASC';
  const rows = await db.prepare(`${SELECT} WHERE t.visibility = 'public' AND ${where} ORDER BY ${order} LIMIT ?2`).bind(now, lim).all<Row>();
  return { serverNowUnix: unix(now), tournaments: rows.results.map((r) => view(r, null, null, now)) };
}

/** Everything the player is in or hosting, newest first. */
export async function myTournaments(db: D1Database, playerId: string, now = Date.now()) {
  const recent = `(t.status IN ${OPEN} OR t.starts_at > ?2 - 604800000)`;
  const [entries, hosted] = await db.batch([
    db
      .prepare(
        `SELECT t.*, h.display_name AS host_name, h.friend_code AS host_code,
           (SELECT count(*) FROM tournament_entries e2 WHERE e2.tournament_id = t.id AND e2.status IN ('registered', 'playing', 'finished')) AS players,
           e.status AS e_status, e.place AS e_place, e.prize AS e_prize, e.paid_amount AS e_paid, e.attempt AS e_attempt
         FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id JOIN players h ON h.id = t.host_id
         WHERE e.player_id = ?1 AND ${recent} ORDER BY t.starts_at DESC LIMIT 50`,
      )
      .bind(playerId, now),
    db.prepare(`${SELECT} WHERE t.host_id = ?1 AND ${recent} ORDER BY t.starts_at DESC LIMIT 50`).bind(playerId, now),
  ]);
  type WithEntry = Row & { e_status: string; e_place: number; e_prize: number; e_paid: number; e_attempt: number };
  return {
    serverNowUnix: unix(now),
    entries: (entries!.results as WithEntry[]).map((r) =>
      view(r, { status: r.e_status, place: r.e_place, prize: r.e_prize, paid_amount: r.e_paid, attempt: r.e_attempt }, playerId, now, true),
    ),
    hosted: (hosted!.results as Row[]).map((r) => view(r, null, playerId, now, true)),
  };
}

// ---- Validation --------------------------------------------------------------------------------------------------------

function text(value: unknown, min: number, max: number, label: string): string {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) fail(400, 'bad_request', `${label} must be ${min}–${max} characters.`);
  return s;
}
function whole(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, 'bad_request', `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}
function oneOf<T extends string>(value: unknown, allowed: T[], label: string): T {
  const s = String(value ?? '').toLowerCase() as T;
  if (!allowed.includes(s)) fail(400, 'bad_request', `${label} must be one of: ${allowed.join(', ')}.`);
  return s;
}
function startTime(input: { startsAtUnix?: unknown; startsAt?: unknown }, now: number, rules: TournamentRules): number {
  const raw = input?.startsAtUnix !== undefined ? Number(input.startsAtUnix) * 1000 : Date.parse(String(input?.startsAt ?? ''));
  if (!Number.isFinite(raw)) fail(400, 'bad_request', 'Pick a start time.');
  const minutes = Math.ceil(rules.minLeadMs / 60_000);
  if (raw < now + rules.minLeadMs) fail(400, 'bad_request', `Start at least ${minutes} minute${minutes === 1 ? '' : 's'} from now.`);
  if (raw > now + rules.maxLeadMs) fail(400, 'bad_request', 'Start within the next two weeks.');
  return raw;
}
const isUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));

async function hosted(db: D1Database, id: string, hostId: string): Promise<Row> {
  const t = await findRow(db, id);
  if (!t) notFound();
  if (t!.host_id !== hostId) fail(403, 'forbidden', 'Only the host can do that.');
  return t!;
}

// ---- Hosting ------------------------------------------------------------------------------------------------------------

export interface CreateInput {
  name?: unknown;
  entryFee?: unknown;
  hostPrize?: unknown;
  maxPlayers?: unknown;
  speed?: unknown;
  visibility?: unknown;
  startsAtUnix?: unknown;
  startsAt?: unknown;
}

/** Creates a tournament and takes the host's prize, atomically. */
export async function createTournament(db: D1Database, hostId: string, input: CreateInput, rules: TournamentRules = DEFAULT_RULES, now = Date.now()) {
  const name = text(input?.name, 1, 40, 'Name');
  const entryFee = whole(input?.entryFee ?? 0, 0, MAX_ENTRY_FEE, 'Entry fee');
  const hostPrize = whole(input?.hostPrize ?? 0, 0, MAX_HOST_PRIZE, 'Host prize');
  const maxPlayers = whole(input?.maxPlayers ?? 30, 2, 30, 'Max players');
  const speed = oneOf<Speed>(input?.speed ?? 'regular', ['turbo', 'regular', 'slow'], 'Speed');
  const visibility = oneOf<Visibility>(input?.visibility ?? 'public', ['public', 'private'], 'Visibility');
  const startsAt = startTime(input, now, rules);
  if (hostPrize + entryFee * maxPlayers > MAX_POOL) fail(400, 'bad_request', 'That prize pool is too big.');
  const open = await db.prepare(`SELECT count(*) AS n FROM tournaments WHERE host_id = ?1 AND status IN ${OPEN}`).bind(hostId).first<{ n: number }>();
  if ((open?.n ?? 0) >= rules.maxActivePerHost) fail(409, 'conflict', `You can host ${rules.maxActivePerHost} tournaments at a time.`);

  const id = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    const stmts = [
      db
        .prepare(
          `INSERT INTO tournaments (id, name, host_id, entry_fee, host_prize, visibility, join_code, session_name, starts_at, speed, max_players,
             status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'registering', ?12, ?12)`,
        )
        .bind(id, name, hostId, entryFee, hostPrize, visibility, newJoinCode(), newSessionName(), startsAt, speed, maxPlayers, now),
    ];
    if (hostPrize > 0) {
      stmts.push(postingStatement(db, { playerId: hostId, currency: 'coins', delta: -hostPrize, reason: 'tournament:host_prize', ref: id, idempotencyKey: `trn:${id}:host_prize` }, now));
    }
    try {
      await db.batch(stmts);
      break;
    } catch (err) {
      if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', "You don't have enough coins for that prize.");
      if (!isUnique(err) || attempt >= 5) throw err; // a code collision: draw again
    }
  }
  return tournamentView(db, id, hostId, now);
}

export async function editTournament(db: D1Database, hostId: string, id: string, input: CreateInput, rules: TournamentRules = DEFAULT_RULES, now = Date.now()) {
  const t = await hosted(db, id, hostId);
  if (t.status !== 'registering') fail(409, 'conflict', "This tournament can't be changed now.");
  if (now >= t.starts_at - EDIT_FREEZE_MS) fail(409, 'conflict', 'Details are frozen in the last 5 minutes.');
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (column: string, value: unknown) => {
    args.push(value);
    sets.push(`${column} = ?${args.length + 1}`);
  };
  if (input?.name !== undefined) set('name', text(input.name, 1, 40, 'Name'));
  if (input?.speed !== undefined) set('speed', oneOf(input.speed, ['turbo', 'regular', 'slow'], 'Speed'));
  if (input?.visibility !== undefined) set('visibility', oneOf(input.visibility, ['public', 'private'], 'Visibility'));
  if (input?.startsAt !== undefined || input?.startsAtUnix !== undefined) set('starts_at', startTime(input, now, rules));
  if (input?.maxPlayers !== undefined) {
    const max = whole(input.maxPlayers, 2, 30, 'Max players');
    if (max < t.players) fail(409, 'conflict', `${t.players} players are already in.`);
    set('max_players', max);
  }
  if (input?.entryFee !== undefined) {
    const fee = whole(input.entryFee, 0, MAX_ENTRY_FEE, 'Entry fee');
    if (fee !== t.entry_fee) {
      const anyone = await db.prepare('SELECT 1 AS x FROM tournament_entries WHERE tournament_id = ?1 LIMIT 1').bind(id).first();
      if (anyone) fail(409, 'conflict', "The entry fee can't change once someone has registered.");
      set('entry_fee', fee);
    }
  }
  if (sets.length) {
    set('updated_at', now);
    await db.prepare(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?1 AND status = 'registering'`).bind(id, ...args).run();
  }
  return tournamentView(db, id, hostId, now);
}

export async function raisePrize(db: D1Database, hostId: string, id: string, rawAmount: unknown, now = Date.now()) {
  const amount = whole(rawAmount, 1, MAX_HOST_PRIZE, 'Amount');
  const t = await hosted(db, id, hostId);
  if (t.status !== 'registering' || now >= t.starts_at) fail(409, 'conflict', 'The prize can only be raised before the start.');
  if (t.host_prize + amount + t.entry_fee * t.max_players > MAX_POOL) fail(400, 'bad_request', 'That prize pool is too big.');
  const n = t.prize_raises + 1;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE tournaments SET host_prize = host_prize + ?3, prize_raises = ?4, updated_at = ?5
           WHERE id = ?1 AND host_id = ?2 AND status = 'registering' AND starts_at > ?5 AND prize_raises = ?4 - 1`,
        )
        .bind(id, hostId, amount, n, now),
      conditionalPostingStatement(
        db,
        { playerId: hostId, currency: 'coins', delta: -amount, reason: 'tournament:host_prize', ref: id, idempotencyKey: `trn:${id}:raise:${n}` },
        `EXISTS (SELECT 1 FROM tournaments WHERE id = ?8 AND prize_raises = ?9 AND updated_at = ?10)`,
        [id, n, now],
        now,
      ),
    ]);
  } catch (err) {
    if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', "You don't have enough coins.");
    throw err;
  }
  return tournamentView(db, id, hostId, now);
}

export async function cancelTournament(db: D1Database, hostId: string, id: string, now = Date.now()) {
  const t = await hosted(db, id, hostId);
  if (t.status !== 'registering') fail(409, 'conflict', 'A tournament can only be cancelled before it starts.');
  await endAndRefund(db, id, 'cancelled', 'host_cancelled', now, `('registering')`);
  return tournamentView(db, id, hostId, now);
}

/**
 * Ends a tournament that won't finish and gives back everything taken: each entry's fee and the host's prize. One
 * batch; the status change is the fence (a tournament already ended refunds nothing more), and every refund is keyed.
 */
export async function endAndRefund(db: D1Database, id: string, status: 'cancelled' | 'aborted', reason: string, now = Date.now(), from = OPEN): Promise<boolean> {
  const did = `EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND status = '${status}' AND updated_at = ?2)`;
  const results = await db.batch([
    db.prepare(`UPDATE tournaments SET status = ?2, cancel_reason = ?3, updated_at = ?4 WHERE id = ?1 AND status IN ${from}`).bind(id, status, reason, now),
    db
      .prepare(
        `INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
         SELECT e.player_id, 'coins', e.paid_amount, 'tournament:refund', ?1, 'trn:' || ?1 || ':refund:' || e.attempt, ?2
         FROM tournament_entries e WHERE e.tournament_id = ?1 AND e.status IN ('registered', 'playing') AND e.paid_amount > 0 AND ${did}
         ON CONFLICT (player_id, idempotency_key) DO NOTHING`,
      )
      .bind(id, now),
    db
      .prepare(
        `INSERT INTO ledger_entries (player_id, currency, delta, reason, ref, idempotency_key, created_at)
         SELECT t.host_id, 'coins', t.host_prize, 'tournament:refund', ?1, 'trn:' || ?1 || ':refund:host', ?2
         FROM tournaments t WHERE t.id = ?1 AND t.host_prize > 0 AND ${did}
         ON CONFLICT (player_id, idempotency_key) DO NOTHING`,
      )
      .bind(id, now),
    db
      .prepare(`UPDATE tournament_entries SET status = 'cancelled', updated_at = ?2 WHERE tournament_id = ?1 AND status IN ('registered', 'playing') AND ${did}`)
      .bind(id, now),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

// ---- Playing -----------------------------------------------------------------------------------------------------------

/** Registers and takes the entry fee, atomically: a full or closed tournament takes nothing, a short balance registers nobody. */
export async function register(db: D1Database, player: { id: string; display_name: string }, id: string, now = Date.now()) {
  const t = await findRow(db, id);
  if (!t) notFound();
  if (t!.status !== 'registering' || now >= t!.starts_at) fail(409, 'conflict', 'Registration is closed.');
  const existing = await entryOf(db, id, player.id);
  if (existing?.status === 'registered') return tournamentView(db, id, player.id, now);
  if (existing?.status === 'removed') fail(403, 'forbidden', 'The host removed you from this tournament.');
  const attempt = (existing?.attempt ?? 0) + 1;
  const fee = t!.entry_fee;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO tournament_entries (tournament_id, player_id, display_name, status, attempt, paid_amount, created_at, updated_at)
         SELECT ?1, ?2, ?3, 'registered', ?4, ?5, ?6, ?6
         WHERE EXISTS (SELECT 1 FROM tournaments t WHERE t.id = ?1 AND t.status = 'registering' AND t.starts_at > ?6
           AND (SELECT count(*) FROM tournament_entries e WHERE e.tournament_id = ?1 AND e.status = 'registered') < t.max_players)
         ON CONFLICT (tournament_id, player_id) DO UPDATE SET status = 'registered', attempt = excluded.attempt, paid_amount = excluded.paid_amount,
           display_name = excluded.display_name, place = 0, round_reached = 0, prize = 0, updated_at = excluded.updated_at
         WHERE tournament_entries.status IN ('unregistered', 'cancelled') AND tournament_entries.attempt = excluded.attempt - 1`,
      )
      .bind(id, player.id, player.display_name, attempt, fee, now),
  ];
  if (fee > 0) {
    stmts.push(
      conditionalPostingStatement(
        db,
        { playerId: player.id, currency: 'coins', delta: -fee, reason: 'tournament:entry', ref: id, idempotencyKey: `trn:${id}:entry:${attempt}` },
        `EXISTS (SELECT 1 FROM tournament_entries WHERE tournament_id = ?8 AND player_id = ?9 AND status = 'registered' AND attempt = ?10)`,
        [id, player.id, attempt],
        now,
      ),
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    if (isInsufficientFunds(err)) fail(409, 'insufficient_funds', "You don't have enough coins to enter.");
    throw err;
  }
  const after = await entryOf(db, id, player.id);
  if (after?.status !== 'registered') fail(409, 'conflict', 'This tournament is full.');
  return tournamentView(db, id, player.id, now);
}

/** Takes a player out before the start and refunds their fee (the player leaving, or the host removing them). */
async function leave(db: D1Database, id: string, playerId: string, status: 'unregistered' | 'removed', now: number): Promise<void> {
  const entry = await entryOf(db, id, playerId);
  if (!entry || entry.status !== 'registered') fail(404, 'not_found', "That player isn't registered.");
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE tournament_entries SET status = ?3, updated_at = ?4 WHERE tournament_id = ?1 AND player_id = ?2 AND status = 'registered'
           AND EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND status = 'registering' AND starts_at > ?4)`,
      )
      .bind(id, playerId, status, now),
  ];
  if (entry!.paid_amount > 0) {
    stmts.push(
      conditionalPostingStatement(
        db,
        { playerId, currency: 'coins', delta: entry!.paid_amount, reason: 'tournament:refund', ref: id, idempotencyKey: `trn:${id}:refund:${entry!.attempt}` },
        `EXISTS (SELECT 1 FROM tournament_entries WHERE tournament_id = ?8 AND player_id = ?9 AND status = ?10 AND attempt = ?11)`,
        [id, playerId, status, entry!.attempt],
        now,
      ),
    );
  }
  const [r] = await db.batch(stmts);
  if (!r?.meta.changes) fail(409, 'conflict', "You can't leave after the start.");
}

export async function unregister(db: D1Database, playerId: string, id: string, now = Date.now()) {
  const t = await findRow(db, id);
  if (!t) notFound();
  if (t!.status !== 'registering' || now >= t!.starts_at) fail(409, 'conflict', "You can't leave after the start.");
  await leave(db, id, playerId, 'unregistered', now);
  return tournamentView(db, id, playerId, now);
}

/** The host removes a player (named by Friend ID) before the start. */
export async function removePlayer(db: D1Database, hostId: string, id: string, friendCode: string, now = Date.now()) {
  const t = await hosted(db, id, hostId);
  if (t.status !== 'registering' || now >= t.starts_at) fail(409, 'conflict', 'Players can only be removed before the start.');
  const who = await db.prepare('SELECT id FROM players WHERE friend_code = ?1').bind(String(friendCode ?? '').replace(/-/g, '').toUpperCase()).first<{ id: string }>();
  if (!who) fail(404, 'not_found', "That player isn't registered.");
  await leave(db, id, who!.id, 'removed', now);
  return tournamentView(db, id, hostId, now);
}

// ---- The tournament room (game server) -----------------------------------------------------------------------------

export interface Roster {
  serverNowUnix: number;
  tournamentId: string;
  name: string;
  hostPlayFabId: string;
  status: string;
  sessionName: string;
  speed: string;
  startsAtUnix: number;
  rosterFrozen: boolean;
  firstPrize: number;
  secondPrize: number;
  entrants: { playFabId: string; displayName: string }[];
}

export async function tournamentBySession(db: D1Database, sessionName: string): Promise<TournamentRow | null> {
  return db.prepare('SELECT * FROM tournaments WHERE session_name = ?1').bind(sessionName).first<TournamentRow>();
}

/**
 * Freezes the roster at the start time: everyone registered plays; fewer than 2 cancels (and refunds). Called by the
 * room when it reads the roster after the start, and by the minute cron for rooms nobody opened.
 */
export async function lockOrCancel(db: D1Database, id: string, now = Date.now()): Promise<TournamentStatus | null> {
  const t = await db.prepare('SELECT status, starts_at FROM tournaments WHERE id = ?1').bind(id).first<{ status: TournamentStatus; starts_at: number }>();
  if (!t) return null;
  if (t.status !== 'registering' || t.starts_at > now) return t.status;
  const ready = await db.prepare(`SELECT count(*) AS n FROM tournament_entries WHERE tournament_id = ?1 AND status = 'registered'`).bind(id).first<{ n: number }>();
  if ((ready?.n ?? 0) < 2) {
    await endAndRefund(db, id, 'cancelled', 'not_enough_players', now, `('registering')`);
    return 'cancelled';
  }
  await db.batch([
    db.prepare(`UPDATE tournaments SET status = 'locked', locked_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'registering'`).bind(id, now),
    db
      .prepare(
        `UPDATE tournament_entries SET status = 'playing', updated_at = ?2 WHERE tournament_id = ?1 AND status = 'registered'
           AND EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND status = 'locked')`,
      )
      .bind(id, now),
  ]);
  return 'locked';
}

/** The tournament as the room needs it: settings plus the roster (frozen once the start time passes). */
export async function roster(db: D1Database, id: string, now = Date.now()): Promise<Roster> {
  await lockOrCancel(db, id, now);
  const t = await findRow(db, id);
  if (!t) notFound();
  const entries = await db
    .prepare(
      `SELECT p.friend_code, e.display_name FROM tournament_entries e JOIN players p ON p.id = e.player_id
       WHERE e.tournament_id = ?1 AND e.status IN ('registered', 'playing', 'finished') ORDER BY e.created_at, p.id`,
    )
    .bind(id)
    .all<{ friend_code: string; display_name: string }>();
  const prizes = computePayout(t!.host_prize, t!.entry_fee, entries.results.length);
  return {
    serverNowUnix: unix(now),
    tournamentId: t!.id,
    name: t!.name,
    hostPlayFabId: t!.host_code ?? '',
    status: t!.status,
    sessionName: t!.session_name,
    speed: t!.speed,
    startsAtUnix: unix(t!.starts_at),
    rosterFrozen: t!.status === 'locked' || t!.status === 'running' || t!.status === 'finished',
    firstPrize: prizes.first,
    secondPrize: prizes.second,
    entrants: entries.results.map((e) => ({ playFabId: e.friend_code, displayName: e.display_name })),
  };
}

/** Who a joining connection is (its hello ticket is the Nomad session token), and whether it plays or may watch. */
export async function verifyEntrant(db: D1Database, id: string, token: string, now = Date.now()) {
  const t = await db.prepare('SELECT host_id FROM tournaments WHERE id = ?1').bind(id).first<{ host_id: string }>();
  if (!t) return { ok: false, playFabId: '', displayName: '', entrant: false, host: false, error: 'Tournament not found.', code: 'not_found' };
  const who = token ? await sessionPlayer(db, token, now) : null;
  if (!who) return { ok: false, playFabId: '', displayName: '', entrant: false, host: false, error: 'Sign in again.', code: 'unauthorized' };
  const entry = await entryOf(db, id, who.player.id);
  return {
    ok: true,
    playFabId: who.player.friend_code ?? '',
    displayName: who.player.display_name,
    entrant: !!entry && ['registered', 'playing', 'finished'].includes(entry.status),
    host: who.player.id === t.host_id,
    error: '',
    code: '',
  };
}

export async function markStarted(db: D1Database, id: string, now = Date.now()): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE tournaments SET status = 'running', started_at = coalesce(started_at, ?2), last_heartbeat_at = ?2, updated_at = ?2 WHERE id = ?1 AND status IN ('locked', 'running')`)
    .bind(id, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function heartbeat(db: D1Database, id: string, seq: number, snapshot: unknown, now = Date.now()): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE tournaments SET last_heartbeat_at = ?2,
         last_progress = CASE WHEN ?3 > progress_seq THEN ?4 ELSE last_progress END, progress_seq = max(progress_seq, ?3), updated_at = ?2
       WHERE id = ?1 AND status IN ('locked', 'running')`,
    )
    .bind(id, now, Math.trunc(Number(seq) || 0), JSON.stringify(snapshot ?? null))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export interface Standing {
  playFabId: string;
  place: number;
  roundReached: number;
}

/**
 * The final standings from the room: records places and pays 1st and 2nd. The same result again is a no-op; a
 * different result for a finished tournament is refused (409).
 */
export async function postResult(db: D1Database, id: string, body: { championId?: unknown; standings?: unknown }, now = Date.now()): Promise<{ status: number; error?: string }> {
  const championId = String(body?.championId ?? '');
  const standings: Standing[] = Array.isArray(body?.standings)
    ? (body.standings as Record<string, unknown>[]).map((s) => ({ playFabId: String(s?.playFabId ?? ''), place: Number(s?.place), roundReached: Number(s?.roundReached) }))
    : [];
  const hash = await sha256Hex(JSON.stringify({ championId, standings: [...standings].sort((a, b) => a.place - b.place) }));
  const t = await db.prepare('SELECT * FROM tournaments WHERE id = ?1').bind(id).first<TournamentRow>();
  if (!t) return { status: 404, error: 'Tournament not found.' };
  if (t.status === 'finished') return t.result_hash === hash ? { status: 200 } : { status: 409, error: 'A different result was already recorded.' };
  if (t.status !== 'running' && t.status !== 'locked') return { status: 409, error: `This tournament is ${t.status}.` };

  const playing = await db
    .prepare(`SELECT e.player_id, e.paid_amount, p.friend_code FROM tournament_entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = ?1 AND e.status = 'playing'`)
    .bind(id)
    .all<{ player_id: string; paid_amount: number; friend_code: string }>();
  const byCode = new Map(playing.results.map((e) => [e.friend_code, e]));
  const bad = validateStandings(standings, championId, [...byCode.keys()]);
  if (bad) return { status: 400, error: bad };

  const payout = computePayout(t.host_prize, t.entry_fee, playing.results.filter((e) => e.paid_amount > 0).length);
  const did = `EXISTS (SELECT 1 FROM tournaments WHERE id = ?8 AND status = 'finished' AND result_hash = ?9)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE tournaments SET status = 'finished', finished_at = ?2, result = ?3, result_hash = ?4, updated_at = ?2 WHERE id = ?1 AND status IN ('locked', 'running')`)
      .bind(id, now, JSON.stringify({ championId, standings, payout }), hash),
  ];
  for (const s of standings) {
    const prize = s.place === 1 ? payout.first : s.place === 2 ? payout.second : 0;
    const e = byCode.get(s.playFabId)!;
    stmts.push(
      db
        .prepare(
          `UPDATE tournament_entries SET status = 'finished', place = ?3, round_reached = ?4, prize = ?5, updated_at = ?6
           WHERE tournament_id = ?1 AND player_id = ?2 AND status = 'playing' AND EXISTS (SELECT 1 FROM tournaments WHERE id = ?1 AND result_hash = ?7)`,
        )
        .bind(id, e.player_id, s.place, s.roundReached, prize, now, hash),
    );
    if (prize > 0) {
      stmts.push(
        conditionalPostingStatement(
          db,
          { playerId: e.player_id, currency: 'coins', delta: prize, reason: 'tournament:prize', ref: id, idempotencyKey: `trn:${id}:payout:${s.place}` },
          did,
          [id, hash],
          now,
        ),
      );
    }
  }
  await db.batch(stmts);
  return { status: 200 };
}

function validateStandings(standings: Standing[], championId: string, roster: string[]): string | null {
  if (standings.length !== roster.length) return `Expected ${roster.length} standings, got ${standings.length}.`;
  const rosterSet = new Set(roster);
  const players = new Set<string>();
  const places = new Set<number>();
  for (const s of standings) {
    if (!rosterSet.has(s.playFabId)) return `${s.playFabId} wasn't playing.`;
    if (players.has(s.playFabId)) return `${s.playFabId} appears twice.`;
    if (!Number.isInteger(s.place) || s.place < 1 || s.place > roster.length || places.has(s.place)) return `Place ${s.place} is invalid or repeated.`;
    if (!Number.isInteger(s.roundReached) || s.roundReached < 1) return `Round ${s.roundReached} is invalid.`;
    players.add(s.playFabId);
    places.add(s.place);
  }
  const champion = standings.find((s) => s.place === 1);
  return champion && champion.playFabId === championId ? null : 'The champion must be in 1st place.';
}

// ---- The clock (game server cron, every minute) -------------------------------------------------------------------------

/**
 * One pass of what time moves along: lock or cancel at the start time; abort a tournament no room started, or whose
 * room went quiet. Returns the rooms that should be open now (a few minutes before the start, with 2+ players), so
 * the caller can wake them.
 */
export async function tournamentTick(db: D1Database, now = Date.now()): Promise<{ open: string[]; ended: string[] }> {
  const ended: string[] = [];
  const due = await db.prepare(`SELECT id FROM tournaments WHERE status = 'registering' AND starts_at <= ?1`).bind(now).all<{ id: string }>();
  for (const r of due.results) if ((await lockOrCancel(db, r.id, now)) === 'cancelled') ended.push(r.id);

  const never = await db
    .prepare(`SELECT id FROM tournaments WHERE status = 'locked' AND started_at IS NULL AND starts_at < ?1`)
    .bind(now - START_GRACE_MS)
    .all<{ id: string }>();
  for (const r of never.results) if (await endAndRefund(db, r.id, 'aborted', 'server_never_started', now)) ended.push(r.id);

  const quiet = await db
    .prepare(`SELECT id FROM tournaments WHERE status = 'running' AND max(coalesce(last_heartbeat_at, 0), coalesce(started_at, 0)) < ?1`)
    .bind(now - HEARTBEAT_TIMEOUT_MS)
    .all<{ id: string }>();
  for (const r of quiet.results) if (await endAndRefund(db, r.id, 'aborted', 'server_lost', now)) ended.push(r.id);

  const open = await db
    .prepare(
      `SELECT t.session_name FROM tournaments t WHERE t.status IN ('registering', 'locked', 'running') AND t.starts_at <= ?1
         AND (SELECT count(*) FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status IN ('registered', 'playing')) >= 2`,
    )
    .bind(now + SPAWN_LEAD_MS)
    .all<{ session_name: string }>();
  return { open: open.results.map((r) => r.session_name), ended };
}
