// M12b: the Agent runner. A player's Agent plays private SOL tables for them with the program-limited Agent key
// (instructions/agent.rs): it may only buy in from their game balance as their own seat (within the stake, one
// seat at a time), play that seat, and cash it out into their game balance. This service holds that key
// (encrypted at rest), picks a table, plays with the game's bot (agentBot.ts), and leaves when a limit is hit
// or the player stops it. Every request from the game is signed by the player's play key, which carries the
// wallet's signed authorization, so only the wallet's owner can deploy, stop or read their Agent.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import type { Express, Request, Response } from "express";
import { CONFIG_PDA, PROGRAM_ID, TeeSession, accountsOf, coder, l1, redact, rollupPrograms } from "./chain";
import { config } from "./config";
import { admitSpend, event, pool, settleSpend } from "./db";
import { PRESETS, Profile, clampProfile, decide, Game, ST } from "./agentBot";
import * as market from "./solStrategies";
import { creditOf, decodeHostTab, hostFees, hostTabOf, refundHostFee, reserveHostFee } from "./hostFees";
import { payoutRoute } from "./payouts";
import idl from "./shared/poker_per.json";

// ---------------------------------------------------------------------------------------- settings and limits

export type AgentSettings = {
  strategy: "conservative" | "balanced" | "aggressive" | "custom";
  custom?: Profile;
  /** Most at risk, lamports (the on-chain stake). */
  stake: number;
  /** Buy-in in big blinds (clamped to the table and the stake). */
  buyInBB: number;
  maxHands: number;
  maxMinutes: number;
  /** Leave once down this much in a session, lamports (0 = off). */
  stopLoss: number;
  /** Leave once up this much in a session, lamports (0 = off). */
  profitTarget: number;
  /** A table to play (else the first open public one that fits). */
  table?: string;
  /** A copied marketplace strategy (solStrategies.ts): its profile is `custom`, and the record must carry its fee terms. */
  strategyId?: string;
  /** Its fee terms, set by /agents/prepare (the game sets the same on chain). */
  terms?: { creator: string; creatorFeeBps: number; platformFeeBps: number };
};

const MIN_STAKE = 1_000_000, MAX_STAKE = 5_000_000_000;
export function checkSettings(s: any): AgentSettings {
  const num = (v: any, lo: number, hi: number, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be ${lo}..${hi}`);
    return Math.floor(n);
  };
  const strategy = ["conservative", "balanced", "aggressive", "custom"].includes(s?.strategy) ? s.strategy : "balanced";
  const out: AgentSettings = {
    strategy,
    stake: num(s?.stake, MIN_STAKE, MAX_STAKE, "stake"),
    buyInBB: num(s?.buyInBB ?? 50, 10, 100, "buyInBB"),
    maxHands: num(s?.maxHands ?? 100, 1, 10_000, "maxHands"),
    maxMinutes: num(s?.maxMinutes ?? 60, 1, 7 * 24 * 60, "maxMinutes"),
    stopLoss: num(s?.stopLoss ?? 0, 0, MAX_STAKE, "stopLoss"),
    profitTarget: num(s?.profitTarget ?? 0, 0, 100 * MAX_STAKE, "profitTarget"),
  };
  if (strategy === "custom") {
    const c = s?.custom ?? {};
    // Deep review: clamp() passes NaN through (every comparison is false), and a NaN profile broke that Agent.
    const f = (v: any, d: number, name: string) => { const n = Number(v ?? d); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; };
    out.custom = clampProfile({ foldBelow: f(c.foldBelow, 0.3, "foldBelow"), raiseAbove: f(c.raiseAbove, 0.66, "raiseAbove"), aggression: f(c.aggression, 0.5, "aggression"),
      bluffChance: f(c.bluffChance, 0.07, "bluffChance"), raiseFractionOfPot: f(c.raiseFractionOfPot, 0.62, "raiseFractionOfPot"),
      // Agents v2 (optional; a profile without them plays as before): position, brain 2, per-street numbers.
      positionWeight: c.positionWeight === undefined ? undefined : f(c.positionWeight, 0, "positionWeight"), brain: Number(c.brain) === 2 ? 2 : undefined, streets: c.streets });
  }
  if (s?.table) out.table = new PublicKey(s.table).toBase58();
  if (s?.strategyId !== undefined && s?.strategyId !== null) {
    if (typeof s.strategyId !== "string" || !/^[0-9a-f-]{36}$/.test(s.strategyId)) throw new Error("bad strategyId");
    out.strategyId = s.strategyId;
  }
  return out;
}
const profileOf = (s: AgentSettings): Profile => (s.strategy === "custom" && s.custom ? s.custom : PRESETS[s.strategy] ?? PRESETS.balanced);

// ---------------------------------------------------------------------------------------- keys at rest

/** AES-256-GCM key for Agent and seat keys at rest, derived from the archive key (both are server secrets). */
const keyKey = createHash("sha256").update("nomad-agent-keys/v1").update(config.archiveKey).digest();
function seal(secret: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyKey, iv);
  const body = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(sealed: Buffer): Keypair {
  const d = createDecipheriv("aes-256-gcm", keyKey, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Keypair.fromSecretKey(Buffer.concat([d.update(sealed.subarray(28)), d.final()]));
}

export const AGENT_MIGRATIONS = [
  `create table if not exists agents (
     wallet text primary key,
     agent_pub text not null,
     agent_secret bytea not null,
     settings jsonb not null,
     status text not null,
     detail text not null default '',
     until bigint not null,
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists agent_sessions (
     id bigserial primary key,
     wallet text not null,
     agent_pub text not null,
     table_address text not null,
     seat smallint not null,
     reader_secret bytea not null,
     buy_in bigint not null,
     stack bigint not null,
     cash_out bigint,
     hands int not null default 0,
     last_hand bigint not null default 0,
     started_at timestamptz not null default now(),
     ended_at timestamptz,
     end_reason text
   )`,
  `create index if not exists agent_sessions_wallet on agent_sessions (wallet, id desc)`,
  `create table if not exists agent_hands (
     session_id bigint not null,
     hand_no bigint not null,
     stack_after bigint not null,
     at timestamptz not null default now(),
     primary key (session_id, hand_no)
   )`,
  // Deep review: one open session per wallet, whatever the runner does (a second buy-in's insert fails). Rows
  // that already break it (from before) skip the index rather than stop the service starting; it's made on a
  // later start once they're ended.
  `do $$ begin
     create unique index if not exists agent_sessions_one_open on agent_sessions (wallet) where ended_at is null;
   exception when unique_violation then raise notice 'agent_sessions_one_open not made: a wallet has two open sessions';
   end $$`,
];

// ---------------------------------------------------------------------------------------- addresses

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), NATIVE_MINT.toBuffer()], ATA_PROGRAM)[0];
/** Agents v2: the record moved to new seeds for its bigger layout (fee terms and counts). */
const agentStateOf = (wallet: PublicKey) => pda(Buffer.from("agent2"), wallet.toBuffer());
const walletStateOf = (wallet: PublicKey) => pda(Buffer.from("wallet"), wallet.toBuffer());
const handOf = (table: PublicKey, seat: number) => pda(Buffer.from("hand"), table.toBuffer(), Buffer.from([seat]));
const PLAY_CU = 1_400_000;

/** (key set, vault seed) from the wallet's state on Solana: none = (0, first vault). */
async function walletState(wallet: PublicKey): Promise<{ keySet: number; seed: Buffer }> {
  const a = await l1.getAccountInfo(walletStateOf(wallet), "confirmed");
  if (!a || a.data.length < 52) return { keySet: 0, seed: Buffer.alloc(8) };
  return { keySet: a.data.readUInt32LE(40), seed: Buffer.from(a.data.subarray(44, 52)) };
}
const vaultOf = (wallet: PublicKey, seed: Buffer) => (seed.every((b) => b === 0) ? pda(Buffer.from("vault"), wallet.toBuffer()) : pda(Buffer.from("vault"), wallet.toBuffer(), seed));

export type AgentRecord = {
  wallet: PublicKey; agent: PublicKey; expires: number; keySet: number; stake: bigint; committed: bigint; table: PublicKey; seat: number; reader: PublicKey;
  terms: market.FeeTerms; seatIn: bigint; netIn: bigint; netOut: bigint; highWater: bigint;
};
const AGENT_STATE_LEN = 8 + 32 + 32 + 8 + 4 + 8 + 8 + 32 + 1 + 32 + 1 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 20;
export function decodeAgentState(d: Buffer): AgentRecord | null {
  if (!d || d.length < AGENT_STATE_LEN) return null;
  let o = 8;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const wallet = key(), agent = key();
  const expires = Number(d.readBigInt64LE(o)); o += 8;
  const keySet = d.readUInt32LE(o); o += 4;
  const stake = d.readBigUInt64LE(o); o += 8;
  const committed = d.readBigUInt64LE(o); o += 8;
  const table = key();
  const seat = d[o]; o += 1;
  const reader = key();
  o += 1; // bump
  const creator = key();
  const creatorFeeBps = d.readUInt16LE(o); o += 2;
  const platformFeeBps = d.readUInt16LE(o); o += 2;
  const seatIn = d.readBigUInt64LE(o); o += 8;
  const netIn = d.readBigUInt64LE(o); o += 8;
  const netOut = d.readBigUInt64LE(o); o += 8;
  const highWater = d.readBigInt64LE(o); o += 8;
  return { wallet, agent, expires, keySet, stake, committed, table, seat, reader, terms: { creator, creatorFeeBps, platformFeeBps }, seatIn, netIn, netOut, highWater };
}

/** The fee terms the Agent's record must carry for these settings (none for the player's own strategy): the ones
 *  /agents/prepare handed the game, so a later change of Nomad's share doesn't stop a running Agent. */
const termsOf = (s: AgentSettings): market.FeeTerms => s.strategyId && s.terms
  ? { creator: new PublicKey(s.terms.creator), creatorFeeBps: s.terms.creatorFeeBps, platformFeeBps: s.terms.platformFeeBps }
  : market.NO_TERMS;

// ---------------------------------------------------------------------------------------- requests from the game

/** As the program's `play_key_message` (and client-web/vault.ts). */
export function playKeyMessage(key: PublicKey, expires: number, keySet: number): Buffer {
  return Buffer.from(`Nomad Poker private tables
Allow play key ${key.toBase58()} to use my game balance until ${expires} (unix time). It can buy in to tables (where chips can be lost), leave them, and send money only back to this wallet.${keySet ? ` Key set ${keySet}.` : ""}`, "utf8");
}
/** What the play key signs for one request: the route, the time, and the request's data as sent. */
export const requestMessage = (path: string, ts: number, data: string) => Buffer.from(`nomad-agent|${path}|${ts}|${data}`, "utf8");

/** The wallet behind a signed request, or an error: the wallet authorized this play key (its current key set,
 *  not expired), and the play key signed this request within the last 2 minutes. */
const seenRequests = new Map<string, number>(); // request signature (its bytes, hex) -> when (review L2: each is accepted once)
setInterval(() => {
  const cut = Date.now() - 5 * 60_000;
  for (const [k, v] of seenRequests) if (v < cut) seenRequests.delete(k);
  for (const [k, v] of failEventAt) if (v < cut) failEventAt.delete(k);
}, 60_000).unref();
/** A 64-byte signature in canonical base64. Node's decoder skips bad characters and ignores padding, so one
 *  signature had many accepted spellings, each new to `seenRequests` (deep review: replay). */
const SIG_B64 = /^[A-Za-z0-9+/]{86}==$/;

export async function authorize(path: string, body: any): Promise<{ wallet: PublicKey; playKey: PublicKey; data: any }> {
  const { wallet, playKey, expires, keySet, walletSig, ts, data, sig } = body ?? {};
  const now = Math.floor(Date.now() / 1000);
  if (typeof data !== "string" || typeof sig !== "string" || typeof walletSig !== "string" || !Number.isFinite(ts) || Math.abs(now - ts) > 120) throw new Error("stale or malformed request");
  if (!SIG_B64.test(sig) || !SIG_B64.test(walletSig)) throw new Error("malformed signature");
  if (!Number.isFinite(expires) || expires <= now || !Number.isInteger(keySet) || keySet < 0) throw new Error("play key expired");
  const w = new PublicKey(wallet), k = new PublicKey(playKey);
  // Review L3: both signatures before any network call; then the key set on Solana must still be this one.
  if (!nacl.sign.detached.verify(playKeyMessage(k, expires, keySet), Buffer.from(walletSig, "base64"), w.toBytes())) throw new Error("bad wallet signature");
  const sigBytes = Buffer.from(sig, "base64");
  if (!nacl.sign.detached.verify(requestMessage(path, ts, data), sigBytes, k.toBytes())) throw new Error("bad request signature");
  const seen = sigBytes.toString("hex");
  if (seenRequests.has(seen)) throw new Error("request already used");
  seenRequests.set(seen, Date.now());
  if ((await walletState(w)).keySet !== keySet) throw new Error("play key cancelled");
  return { wallet: w, playKey: k, data: data ? JSON.parse(data) : {} };
}

/** A failure event at most once a minute per key (deep review: an Agent with an empty game balance logged one
 *  every step, about 57k a day). */
const failEventAt = new Map<string, number>();
async function failEvent(key: string, table: string | null, action: string, detail: string) {
  if ((failEventAt.get(key) ?? 0) > Date.now() - 60_000) return;
  failEventAt.set(key, Date.now());
  await event(table, action, false, redact(detail));
}

export function agentRoutes(a: Express) {
  const route = (path: string, handler: (wallet: PublicKey, data: any) => Promise<any>) =>
    a.post(path, async (req: Request, res: Response) => {
      let who;
      try { who = await authorize(path, req.body); } catch (e: any) { res.status(401).json({ error: redact(String(e?.message ?? e)) }); return; }
      try { res.json(await handler(who.wallet, who.data)); } catch (e: any) { res.status(400).json({ error: redact(String(e?.message ?? e)).slice(0, 300) }); }
    });

  /** Step 1 of Deploy: a fresh Agent key for these settings. The game then sets it on chain (agent_set, its play
   *  key) and calls /agents/start. */
  route("/agents/prepare", async (wallet, data) => {
    const settings = checkSettings(data.settings);
    // Copying a marketplace strategy: play its profile, and hand the game the fee terms to set on chain with the Agent.
    if (settings.strategyId) {
      const c = await market.termsFor(settings.strategyId, wallet);
      settings.strategy = "custom";
      settings.custom = clampProfile(c.profile);
      // The creator running their own: no fee (its record grows). Anyone else: the config's shares.
      if (c.terms) settings.terms = { creator: c.terms.creator.toBase58(), creatorFeeBps: c.terms.creatorFeeBps, platformFeeBps: c.terms.platformFeeBps };
    }
    const cur = await pool.query("select status from agents where wallet = $1", [wallet.toBase58()]);
    if (cur.rows[0] && ["running", "stopping"].includes(cur.rows[0].status)) throw new Error("your Agent is still playing: stop it first");
    const seated = await pool.query("select 1 from agent_sessions where wallet = $1 and ended_at is null", [wallet.toBase58()]);
    if (seated.rows.length) throw new Error("your Agent is still leaving its table: try again in a minute");
    const kp = Keypair.generate();
    const until = Math.floor(Date.now() / 1000) + Math.min(settings.maxMinutes * 60 + 15 * 60, 7 * 24 * 3600);
    await pool.query(
      `insert into agents (wallet, agent_pub, agent_secret, settings, status, detail, until, updated_at) values ($1, $2, $3, $4, 'prepared', '', $5, now())
       on conflict (wallet) do update set agent_pub = $2, agent_secret = $3, settings = $4, status = 'prepared', detail = '', until = $5, updated_at = now()`,
      [wallet.toBase58(), kp.publicKey.toBase58(), seal(kp.secretKey), settings, until]);
    return { agent: kp.publicKey.toBase58(), until, stake: settings.stake, terms: settings.terms ?? null };
  });

  /** Step 2: the record on chain names this Agent key; start playing. */
  route("/agents/start", async (wallet) => {
    const row = (await pool.query("select * from agents where wallet = $1", [wallet.toBase58()])).rows[0];
    if (!row) throw new Error("no Agent prepared");
    const kp = open(row.agent_secret);
    const rec = decodeAgentState((await (await sessionFor(kp).get()).getAccountInfo(agentStateOf(wallet), "processed"))?.data as Buffer);
    if (!rec || !rec.agent.equals(kp.publicKey) || rec.expires <= Date.now() / 1000) throw new Error("the Agent isn't set on chain yet (agent_set)");
    // A copied strategy plays only under its fee terms (the program then pays them at every cash-out).
    if (!market.sameTerms(rec.terms, termsOf(row.settings))) throw new Error("the Agent was set on chain without the strategy's fee terms");
    await pool.query("update agents set status = 'running', detail = 'looking for a table', updated_at = now() where wallet = $1", [wallet.toBase58()]);
    return { status: "running" };
  });

  /** Stop: leave after the current hand. */
  route("/agents/stop", async (wallet) => {
    // Review H1: idempotent. A second Stop (or a prepared Agent) never turns a seated Agent into "stopped" with its seat unplayed.
    await pool.query(`update agents set status = case when status in ('running', 'stopping') then 'stopping' when status = 'prepared' then 'stopped' else status end,
       detail = case when status in ('running', 'stopping') then 'leaving after this hand' else detail end, updated_at = now() where wallet = $1`, [wallet.toBase58()]);
    return { status: "stopping" };
  });

  /** Nomad menu, ONCHAIN Quick Play: a public table at this stake level with a free seat, that is playing or was
   *  opened in the last 10 minutes; else one this service hosts (as for Agents). The game then buys in and sits. */
  route("/quickplay/onchain", async (wallet, data) => {
    const level = Math.max(0, Math.min(STAKES.length - 1, Number(data?.stake ?? 0) | 0));
    const st = STAKES[level];
    const recentTs = Math.floor(Date.now() / 1000) - 600;
    const listed = (await pool.query(
      `select address from tables where status = 1 and delegated and not invite_only and seated < max_seats and big_blind = $1
         and (hand_state <> 0 or idle_since > $2) order by seated desc, updated_at desc limit 1`, [st.big.toString(), recentTs])).rows;
    if (listed.length) return { table: listed[0].address, hosted: false };
    // One hosted at this stake in the last 10 minutes (by any instance, deep review #5): join that one.
    const waiting = (await pool.query(
      "select table_address from keeper_spend where kind = 'host' and ok and ref = $1 and at > now() - interval '10 minutes' order by id desc", [st.big.toString()])).rows;
    if (waiting.length) return { table: waiting[0].table_address, hosted: true };
    const recent = (await pool.query("select count(*)::int as n from keeper_spend where kind = 'host' and ok and at > now() - interval '10 minutes'")).rows[0].n;
    if (recent >= MAX_WAITING_HOSTED) throw new Error("too many new tables are waiting for players; try again in a minute");
    // Deep review #5: any fresh key could make the keeper pay for a table. Only a wallet that can buy in there.
    const fees = await hostFees();
    const need = st.min + (fees.on ? fees.fee : 0n);
    if ((await gameBalance(wallet)) < need) throw new Error(`deposit first: this stake's minimum buy-in is ${st.min} lamports${fees.on ? `, plus ${fees.fee} to open the table` : ""}`);
    // Requester pays: the table's rent comes from the asker's game balance (pay_host_fee, signed by the play key; no
    // wallet prompt), before the keeper spends anything. The game pays it when told to, then asks again.
    const w = wallet.toBase58();
    if (fees.on) {
      const paid = await hostTabPaid(wallet);
      if (!(await reserveHostFee(w, fees.fee, paid))) return { needHostFee: fees.fee.toString(), hostWallet: fees.hostWallet.toBase58(), credit: (await creditOf(w, paid)).toString() };
    }
    try {
      return { table: await hostTableAt(st, w), hosted: true, hostFee: fees.on ? fees.fee.toString() : "0" };
    } catch (e) {
      if (fees.on) await refundHostFee(w, fees.fee); // kept as credit for the next table
      throw e;
    }
  });

  /** Your Agent: settings, status, the current session and the history (yours only). */
  route("/agents/me", async (wallet) => {
    const w = wallet.toBase58();
    const row = (await pool.query("select agent_pub, settings, status, detail, until, updated_at from agents where wallet = $1", [w])).rows[0] ?? null;
    const sessions = (await pool.query(
      "select id, table_address, seat, buy_in, stack, cash_out, hands, started_at, ended_at, end_reason, strategy_id, creator_fee, platform_fee from agent_sessions where wallet = $1 order by id desc limit 20", [w])).rows;
    return { agent: row, sessions };
  });

  // ---- Agents v2: the SOL copy-strategy marketplace (solStrategies.ts). Browsing is public; publishing, unlisting
  // and the creator's dashboard are signed by the wallet's play key like every Agent request.
  const reply = (res: Response, p: Promise<any>) => p.then((v) => res.json(v), (e: any) =>
    res.status(e instanceof market.StrategyError ? 400 : 500).json({ error: e instanceof market.StrategyError ? e.message : "something went wrong; try again" }));
  a.get("/sol-strategies", (req: Request, res: Response) => reply(res, market.list(String(req.query.sort ?? "top"), Number(req.query.limit) || 30,
    typeof req.query.style === "string" && req.query.style.trim() ? req.query.style.trim() : undefined).then((strategies) => ({ strategies }))));
  a.get("/sol-strategies/:id", (req: Request, res: Response) => reply(res, market.get(String(req.params.id))));
  route("/sol-strategies/publish", (wallet, data) => market.publish(wallet, data));
  route("/sol-strategies/unlist", (wallet, data) => market.unlist(wallet, data?.strategyId));
  route("/sol-strategies/mine", (wallet) => market.dashboard(wallet));

  /** Background withdrawals (payouts.ts): register one (`expected`), or ask to pay out what has arrived (`ready`). The
   *  keeper sends vault_payout_to_owner, so the money can only go to this wallet. */
  route("/vault/payout", (wallet, data) => payoutRoute(wallet, data));
}

// ---------------------------------------------------------------------------------------- the runner

const sessions = new Map<string, TeeSession>();
function sessionFor(kp: Keypair): TeeSession {
  const k = kp.publicKey.toBase58();
  let s = sessions.get(k);
  if (!s) { s = new TeeSession(kp); sessions.set(k, s); }
  return s;
}
const busy = new Set<string>();
const waitingSince = new Map<string, number>();
const startPressedAt = new Map<number, number>();
/** Tables this service hosted for Agents: address -> stake (big blind) and when. */
const hostedTables = new Map<string, { address: string; big: bigint; at: number }>();
/** Tables being hosted right now, by stake (big blind): a second request at that stake gets the same table. */
const hosting = new Map<bigint, Promise<string>>();
// PerHost.Stakes: the Coins tiers in "$" ($1 = 0.0001 SOL) — Micro $1/$2, Low $2/$5, Mid $10/$25, High $25/$50, Elite $100/$250;
// buy-ins from the Coins tier's minimum to 100 big blinds, capped at the program's 1 SOL.
const USD = 100_000n;
const STAKES = [[1n, 2n, 50n], [2n, 5n, 100n], [10n, 25n, 500n], [25n, 50n, 1000n], [100n, 250n, 5000n]].map(([s, b, m]) => {
  const big = b * USD, min = m * USD > 10n * big ? m * USD : 10n * big, max = 100n * big < 1_000_000_000n ? 100n * big : 1_000_000_000n;
  return { small: s * USD, big, min, max };
});
const MAX_WAITING_HOSTED = 3;
const ESPL = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/** Hosts a public 8-seat table for an Agent with `left` lamports of stake: the highest stake level whose buy-in
 *  (its buy-in in big blinds, at least the 10 BB minimum) fits. One at a time; at most 3 hosted tables waiting. */
async function hostTableFor(wallet: string, settings: AgentSettings, left: bigint, agentKp?: Keypair): Promise<string | null> {
  if (hosting.size > 0) return null;
  // Requester pays: the Agent pays the table's rent within its stake (agent_pay_host_fee), so a buy-in must fit after it.
  const fees = await hostFees();
  const fee = fees.on ? fees.fee : 0n;
  const fits = STAKES.filter((st) => { const bb = BigInt(Math.max(10, settings.buyInBB)) * st.big; return (bb > st.min ? bb : st.min) + fee <= left; });
  if (fits.length === 0) return null;
  const st = fits[fits.length - 1];
  const now = Date.now();
  // One waiting at this stake already (hosted in the last 10 minutes)? The Agent joins that one instead.
  const recent = [...hostedTables.values()].filter((h) => now - h.at < 10 * 60_000);
  if (recent.some((h) => h.big === st.big) || recent.length >= MAX_WAITING_HOSTED) return null;
  if (fees.on) {
    const w = new PublicKey(wallet);
    let paid = await hostTabPaid(w);
    if (!(await reserveHostFee(wallet, fee, paid))) {
      if (!agentKp) return null;
      await agentPayHostFee(w, agentKp, fee);
      paid = await hostTabPaid(w);
      if (!(await reserveHostFee(wallet, fee, paid))) return null;
    }
    try { return await hostTableAt(st, wallet); }
    catch (e) { await refundHostFee(wallet, fee); throw e; }
  }
  return hostTableAt(st, wallet);
}

/** What the wallet has paid in hosting fees (its HostTab, which the keeper reads). */
async function hostTabPaid(wallet: PublicKey): Promise<bigint> {
  return decodeHostTab((await (await sessionFor(config.keeper).get()).getAccountInfo(hostTabOf(wallet), "processed"))?.data as Buffer);
}

/** The Agent pays a hosting fee from the player's game balance, within its stake (program agent_pay_host_fee). */
async function agentPayHostFee(wallet: PublicKey, agentKp: Keypair, fee: bigint) {
  const fees = await hostFees();
  const host = fees.hostWallet;
  const vault = vaultOf(wallet, (await walletState(wallet)).seed);
  const program = await sessionFor(agentKp).program();
  await program.methods.agentPayHostFee(new anchor.BN(fee.toString())).accountsPartial({
    agentKey: agentKp.publicKey,
    pay: {
      wallet, walletState: walletStateOf(wallet), vault, vaultToken: ata(vault), config: CONFIG_PDA,
      hostWalletState: walletStateOf(host), hostVaultToken: ata(vaultOf(host, (await walletState(host)).seed)),
      hostTab: hostTabOf(wallet), hostTabPermission: permissionPdaFromAccount(hostTabOf(wallet)), sponsor: pda(Buffer.from("agent-sponsor")),
      rollup: rollupPrograms, tokenProgram: TOKEN_PROGRAM,
    },
    agentState: agentStateOf(wallet),
  } as any).rpc();
  await event(null, "agent host fee", true, `${wallet.toBase58().slice(0, 6)}… paid ${fee}`);
}

/** The wallet's game balance (lamports): its vault's wSOL account in the rollup, which any logged-in reader may
 *  see (a public permission; program vault_balance's note). None yet = 0. */
async function gameBalance(wallet: PublicKey): Promise<bigint> {
  const { seed } = await walletState(wallet);
  const info = await (await sessionFor(config.keeper).get()).getAccountInfo(ata(vaultOf(wallet, seed)), "processed");
  return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
}

/** Hosts one public 8-seat table at a stake level, the keeper as its creator (it pays and later reclaims the rent).
 *  Deep review #5: every attempt, failed ones too, is recorded in Postgres and counts toward the hourly caps for
 *  `who` (the wallet asking) and for everyone. */
async function hostTableAt(st: { small: bigint; big: bigint; min: bigint; max: bigint }, who: string): Promise<string> {
  const inFlight = hosting.get(st.big);
  if (inFlight) return inFlight;
  const job = (async () => {
    // Requester pays (hostFees.ts): with hosting fees on, each table is paid for before the keeper spends, so only the
    // per-wallet cap stays; the cap for everyone applies only while fees are off.
    const spend = await admitSpend("host", who, st.big.toString(), config.hostsPerWalletHour, (await hostFees()).on ? 0 : config.hostsPerHour);
    if (spend === null) throw new Error("too many tables were opened in the last hour; join an open one or try again later");
    let address: string | null = null;
    try {
      address = await createHostedTable(st, (a) => { address = a; });
      await settleSpend(spend, true, address, `blinds ${st.small}/${st.big}`);
      return address;
    } catch (e: any) {
      await settleSpend(spend, false, address, redact(String(e?.message ?? e))).catch(() => undefined);
      throw e;
    }
  })();
  hosting.set(st.big, job);
  try { return await job; } finally { hosting.delete(st.big); }
}

async function createHostedTable(st: { small: bigint; big: bigint; min: bigint; max: bigint }, created: (address: string) => void): Promise<string> {
  const keeper = config.keeper;
  const id = BigInt("0x" + randomBytes(8).toString("hex")) & ((1n << 63n) - 1n);
  const idLe = Buffer.alloc(8); idLe.writeBigUInt64LE(id);
  const table = pda(Buffer.from("table"), keeper.publicKey.toBuffer(), idLe);
  const escrowEata = PublicKey.findProgramAddressSync([table.toBuffer(), NATIVE_MINT.toBuffer()], ESPL)[0];
  const l1Program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(l1, new anchor.Wallet(keeper), { commitment: "confirmed" }));
  const params = { smallBlind: new anchor.BN(st.small.toString()), bigBlind: new anchor.BN(st.big.toString()), minBuyIn: new anchor.BN(st.min.toString()), maxBuyIn: new anchor.BN(st.max.toString()), maxSeats: 8, inviteOnly: false };
  const create = await l1Program.methods.createTable(new anchor.BN(id.toString()), params)
    .accountsPartial({ creator: keeper.publicKey, config: CONFIG_PDA, table, mint: NATIVE_MINT, escrow: ata(table), escrowEata } as any).instruction();
  const delegate = await l1Program.methods.delegateTable(new anchor.BN(id.toString()), keeper.publicKey)
    .accountsPartial({ payer: keeper.publicKey, table, escapePayer: pda(Buffer.from("escape-payer"), table.toBuffer()), validator: TEE_VALIDATOR } as any).instruction();
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), create, delegate);
  created(table.toBase58());
  await anchor.web3.sendAndConfirmTransaction(l1, tx, [keeper], { commitment: "confirmed" });
  // The rollup picks the table up within seconds; then open it (its private ledger, deck, record, log).
  const keeperProgram = await sessionFor(keeper).program();
  const acc = accountsOf(table);
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await keeperProgram.methods.openTable().accountsPartial({
        payer: keeper.publicKey, table, ledger: acc.ledger, ledgerPermission: permissionPdaFromAccount(acc.ledger), deck: acc.deck,
        deckPermission: permissionPdaFromAccount(acc.deck), record: acc.record, log: acc.log, logPermission: acc.logPermission, rollup: rollupPrograms,
      } as any).rpc();
      opened = true;
    } catch { /* not in the rollup yet */ }
  }
  if (!opened) throw new Error(`hosted table ${table.toBase58()} didn't open`);
  hostedTables.set(table.toBase58(), { address: table.toBase58(), big: st.big, at: Date.now() });
  await event(table.toBase58(), "agent host", true, `blinds ${st.small}/${st.big}`);
  return table.toBase58();
}
/** Per running session: the hand its seed went in for, and when it last saw another player. */
const seededFor = new Map<number, bigint>();
const aloneSince = new Map<number, number>();
const triedTables = new Map<string, number>(); // wallet|table -> when a buy-in there failed
export const runnerState = { loops: 0, lastError: "", running: 0 };

/** Accounts of agent_cash_out. Copying a strategy, also where the fees go: the creator's and config.dev_wallet's
 *  game balances (their current vaults' token accounts). */
async function agentCashOutAccounts(signer: PublicKey, wallet: PublicKey, terms: market.FeeTerms, table: PublicKey, seat: number) {
  const vault = vaultOf(wallet, (await walletState(wallet)).seed);
  const acc = accountsOf(table), hand = handOf(table, seat);
  const fees: Record<string, PublicKey | null> = { creatorWalletState: null, creatorVaultToken: null, treasuryWalletState: null, treasuryVaultToken: null };
  if (!terms.creator.equals(PublicKey.default)) {
    const cfg: any = coder.decode("config", (await l1.getAccountInfo(CONFIG_PDA, "confirmed"))!.data);
    const treasury: PublicKey = cfg.devWallet;
    fees.creatorWalletState = walletStateOf(terms.creator);
    fees.creatorVaultToken = ata(vaultOf(terms.creator, (await walletState(terms.creator)).seed));
    fees.treasuryWalletState = walletStateOf(treasury);
    fees.treasuryVaultToken = ata(vaultOf(treasury, (await walletState(treasury)).seed));
  }
  return {
    signer, wallet, agentState: agentStateOf(wallet), vault, walletState: walletStateOf(wallet), vaultToken: ata(vault),
    table, ledger: acc.ledger, ledgerPermission: permissionPdaFromAccount(acc.ledger), hand, handPermission: permissionPdaFromAccount(hand),
    escrow: ata(table), config: CONFIG_PDA, ...fees, rollup: rollupPrograms, tokenProgram: TOKEN_PROGRAM,
  } as any;
}

async function setStatus(wallet: string, status: string, detail: string) {
  await pool.query("update agents set status = $2, detail = $3, updated_at = now() where wallet = $1", [wallet, status, detail]);
}

const STEP_LIMIT_MS = 90_000;
/** A table counts as not playing once no hand has started for this long while the Agent sits there (half that
 *  when choosing one is twice too long: a table that's between hands is idle for seconds, not minutes). */
const DEAD_TABLE_SECS = 5 * 60;
/** Starts a step for every Agent that's playing or leaving, or still holds a seat (review H1: whatever its
 *  status says). Each Agent runs one step at a time, and none waits for another's (review M6). */
export async function stepAgents() {
  runnerState.loops++;
  const rows = (await pool.query(
    "select * from agents a where status in ('running', 'stopping') or exists (select 1 from agent_sessions s where s.wallet = a.wallet and s.ended_at is null)")).rows;
  runnerState.running = rows.length;
  for (const row of rows) {
    if (busy.has(row.wallet)) continue;
    if (!["running", "stopping"].includes(row.status)) row.status = "stopping"; // a seat to leave
    busy.add(row.wallet);
    // Deep review: a timeout used to free the wallet while its step still ran, so a second step could start
    // beside it (two buy-ins, two sessions). The wallet stays busy until the step itself settles; a slow one is
    // only reported. (Every RPC call gives up after 20 s, so a step can't hang for good.)
    const slow = setTimeout(() => { runnerState.lastError = `${row.wallet.slice(0, 6)}: step still running after ${STEP_LIMIT_MS / 1000} s`; }, STEP_LIMIT_MS);
    slow.unref();
    stepAgent(row)
      .catch((e: any) => { runnerState.lastError = redact(`${row.wallet.slice(0, 6)}: ${String(e?.message ?? e).slice(0, 200)}`); })
      .finally(() => { clearTimeout(slow); busy.delete(row.wallet); });
  }
}

async function stepAgent(row: any) {
  const wallet = new PublicKey(row.wallet);
  const agentKp = open(row.agent_secret);
  const settings: AgentSettings = row.settings;
  const open_ = (await pool.query("select * from agent_sessions where wallet = $1 and ended_at is null order by id desc limit 1", [row.wallet])).rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (!open_) {
    if (row.status === "stopping") { await setStatus(row.wallet, "stopped", "stopped by you"); return; }
    if (now >= Number(row.until) - 60) { await setStatus(row.wallet, "stopped", "its time is up"); return; }
    const done = (await pool.query("select coalesce(sum(hands), 0)::int as hands, min(started_at) as first from agent_sessions where wallet = $1 and agent_pub = $2", [row.wallet, row.agent_pub])).rows[0];
    if (done.hands >= settings.maxHands) { await setStatus(row.wallet, "stopped", `played ${done.hands} hands (your limit)`); return; }
    if (done.first && Date.now() - new Date(done.first).getTime() >= settings.maxMinutes * 60_000) { await setStatus(row.wallet, "stopped", "played for your time limit"); return; }
    await sitDown(row, wallet, agentKp, settings);
    return;
  }
  await play(row, open_, wallet, agentKp, settings);
}

/** Picks a table and buys in, within the stake left on the record. */
async function sitDown(row: any, wallet: PublicKey, agentKp: Keypair, settings: AgentSettings) {
  const agentConn = await sessionFor(agentKp).get();
  const rec = decodeAgentState((await agentConn.getAccountInfo(agentStateOf(wallet), "processed"))?.data as Buffer);
  if (!rec || !rec.agent.equals(agentKp.publicKey)) { await setStatus(row.wallet, "stopped", "the Agent key was replaced or stopped on chain"); return; }
  if (rec.expires <= Date.now() / 1000) { await setStatus(row.wallet, "stopped", "its time is up"); return; }
  const { keySet, seed: vaultSeed } = await walletState(wallet);
  if (keySet !== rec.keySet) { await setStatus(row.wallet, "stopped", "you cancelled your play keys"); return; } // review L1
  // Copying: the record must still carry the strategy's fee terms (the play key could set it again without them).
  if (!market.sameTerms(rec.terms, termsOf(settings))) { await setStatus(row.wallet, "stopped", "its fee terms on chain no longer match the copied strategy"); return; }
  const program = await sessionFor(agentKp).program();
  // A seat left another way (you cashed it out, the table closed): free the record first. If the seat is in fact
  // still held (one this service lost track of), leave it with the Agent key (review H1).
  if (!rec.table.equals(PublicKey.default)) {
    const acc = accountsOf(rec.table);
    try {
      await program.methods.agentRelease().accountsPartial({ wallet, agentState: agentStateOf(wallet), table: rec.table, ledger: acc.ledger } as any).rpc();
    } catch (e: any) {
      try {
        await program.methods.agentCashOut(rec.seat).accountsPartial(await agentCashOutAccounts(agentKp.publicKey, wallet, rec.terms, rec.table, rec.seat)).rpc();
        await event(rec.table.toBase58(), "agent cash-out", true, "a seat this service had lost track of");
      } catch (e2: any) { await setStatus(row.wallet, row.status, "leaving its last seat (between hands)"); }
      return;
    }
  }
  const stakeLeft = rec.stake > rec.committed ? rec.stake - rec.committed : 0n;
  // Deep review: the stake on the record isn't money. Buy in (and host) only within what the game balance holds.
  const balance = await gameBalance(wallet);
  const left = stakeLeft < balance ? stakeLeft : balance;
  const listed = settings.table
    ? (await pool.query("select * from tables where address = $1 and status = 1 and delegated", [settings.table])).rows
    : (await pool.query("select * from tables where status = 1 and delegated and not invite_only and seated >= 1 and seated < max_seats order by seated desc, updated_at desc limit 30")).rows;
  const now = Date.now();
  // Tables this service hosted for Agents (newest first): joined even before the lobby index lists them.
  const hostedRows = settings.table ? [] : [...hostedTables.values()].filter((h) => now - h.at < 10 * 60_000).reverse()
    .map((h) => ({ address: h.address, big_blind: h.big.toString(), min_buy_in: (STAKES.find((st) => st.big === h.big)?.min ?? 10n * h.big).toString(), max_buy_in: (STAKES.find((st) => st.big === h.big)?.max ?? 100n * h.big).toString(), hosted: true }));
  // Copiers of one strategy, and the creator's own Agent, never share a table (docs §5, collusion).
  const avoid = await market.tablesToAvoid(row.wallet, settings.strategyId, settings.terms?.creator);
  const candidates = [...hostedRows, ...listed.filter((t: any) => !hostedTables.has(t.address))].filter((t: any) => !avoid.has(t.address));
  for (const t of candidates.slice(0, 10)) {
    if ((triedTables.get(`${row.wallet}|${t.address}`) ?? 0) > now - 10 * 60_000) continue;
    const bb = BigInt(t.big_blind), min = BigInt(t.min_buy_in), max = BigInt(t.max_buy_in);
    let amount = BigInt(settings.buyInBB) * bb;
    if (amount > max) amount = max;
    if (amount > left) amount = left;
    if (amount < min) continue;
    const table = new PublicKey(t.address);
    const info = await (await sessionFor(agentKp).get()).getAccountInfo(table, "processed");
    if (!info) continue;
    const tb = coder.decode("table", info.data);
    if (tb.status !== 1 || tb.kind !== 0 || (tb.seatMask === 0 && !t.hosted)) continue; // review M5: someone else must be there (or it's one we hosted)
    // Your playtest (12 Oct): both Agents sat at a table nobody had started (Start round never pressed), idle for
    // 30 h, whose other seats were abandoned wallets. Only tables that have started and dealt in the last 10 minutes.
    const idleSecs = Math.floor(now / 1000) - Number(tb.idleSince);
    if (tb.handState === 0 && idleSecs > DEAD_TABLE_SECS * 2) continue; // opened, or last dealt, over 10 minutes ago
    let seat = -1;
    // A random free seat: two Agents joining the same table at once (a hosted one) shouldn't both pick the first.
    const free = Array.from({ length: tb.maxSeats }, (_, i) => i).filter((i) => ((tb.seatMask >> i) & 1) === 0);
    if (free.length > 0) seat = free[randomBytes(1)[0] % free.length];
    if (seat < 0) continue;
    const reader = Keypair.generate();
    const { seed } = await walletState(wallet);
    const vault = vaultOf(wallet, seed);
    const acc = accountsOf(table);
    const hand = handOf(table, seat);
    // The record's counts don't change while the Agent holds this seat: with them, its cash-out's fees are known.
    const pending = (await pool.query(
      `insert into agent_sessions (wallet, agent_pub, table_address, seat, reader_secret, buy_in, stack, last_hand, strategy_id, fee_net_before, fee_high_water)
       values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10) returning id`,
      [row.wallet, row.agent_pub, t.address, seat, seal(reader.secretKey), amount.toString(), tb.handNo.toString(), settings.strategyId ?? null,
        (rec.netOut - rec.netIn).toString(), rec.highWater.toString()])).rows[0].id;
    try {
      await program.methods.agentBuyIn(seat, new anchor.BN(amount.toString()), reader.publicKey).accountsPartial({
        agentKey: agentKp.publicKey, wallet, agentState: agentStateOf(wallet), vault, walletState: walletStateOf(wallet), vaultToken: ata(vault),
        config: CONFIG_PDA, table, ledger: acc.ledger, ledgerPermission: permissionPdaFromAccount(acc.ledger), hand, handPermission: permissionPdaFromAccount(hand),
        invites: null, escrow: ata(table), rollup: rollupPrograms, tokenProgram: TOKEN_PROGRAM,
      } as any).rpc();
    } catch (e: any) {
      // Did it land anyway (the answer was lost)? The record says.
      const after = decodeAgentState((await agentConn.getAccountInfo(agentStateOf(wallet), "processed").catch(() => null))?.data as Buffer);
      if (!(after && after.table.equals(table) && after.reader.equals(reader.publicKey))) {
        await pool.query("delete from agent_sessions where id = $1", [pending]);
        // Lost a race for the seat: try again next step, not in 10 minutes. Deep review: a failed buy-in at a table
        // this service hosted is a failure too (it was retried, and logged, every step); retried after a minute.
        const lostRace = /SeatTaken|InvalidSeat/.test(String(e?.message ?? e));
        if (!lostRace) triedTables.set(`${row.wallet}|${t.address}`, t.hosted ? now - 9 * 60_000 : now);
        await failEvent(`${row.wallet}|buy-in`, t.address, "agent buy-in", String(e?.message ?? e));
        continue;
      }
    }
    waitingSince.delete(row.wallet);
    await setStatus(row.wallet, row.status, `playing at table ${t.address.slice(0, 6)}…, seat ${seat + 1}`);
    await event(t.address, "agent buy-in", true, `${amount} lamports, seat ${seat}`);
    return;
  }
  if (stakeLeft < 1n) { await setStatus(row.wallet, row.status, "its stake is used up"); return; }
  if (balance < STAKES[0].min) { await setStatus(row.wallet, row.status, "waiting: your game balance is too low to buy in (deposit to play)"); return; }
  // Your playtest: nothing to join, so after a minute of waiting it hosts a public table at its stake (the platform's
  // keeper pays the rent, as for tournament tables, and closes and reclaims it once it's empty). Another Agent or a
  // player can then join; with its host not seated, any seated player may press Start round.
  if (!waitingSince.has(row.wallet)) waitingSince.set(row.wallet, now);
  if (!settings.table && now - waitingSince.get(row.wallet)! >= 60_000) {
    const hosted = await hostTableFor(row.wallet, settings, left, agentKp).catch(async (e: any) => { await failEvent(`${row.wallet}|host`, null, "agent host", String(e?.message ?? e)); return null; });
    // Deep review: a minute before the next try, whatever came of this one (a failed host was retried every step).
    waitingSince.set(row.wallet, Date.now());
    if (hosted) { await setStatus(row.wallet, row.status, `hosted a table (${hosted.slice(0, 6)}…); sitting down`); return; }
  }
  await setStatus(row.wallet, row.status, "waiting for a table with players at your stake");
}

const KIND = { fold: 0, check: 1, call: 2, bet: 3, raise: 4, allIn: 5 } as const;
const toBig = (v: any) => BigInt(v.toString());

/** One step at the Agent's seat: leave if a limit was hit (between hands), commit its seed and help start the
 *  next hand, or act when it's its turn. */
async function play(row: any, s: any, wallet: PublicKey, agentKp: Keypair, settings: AgentSettings) {
  const table = new PublicKey(s.table_address);
  const reader = open(s.reader_secret);
  const rconn = await sessionFor(reader).get();
  const acc = accountsOf(table);
  const [ti, li] = await Promise.all([rconn.getAccountInfo(table, "processed"), rconn.getAccountInfo(acc.ledger, "processed")]);
  const seat = Number(s.seat);
  const tb = ti ? coder.decode("table", ti.data) : null;
  const ledger = li ? coder.decode("ledger", li.data) : null;
  // Review H1: a read that failed is tried again next step; only a table that's closed, or a ledger that shows
  // the seat isn't ours any more, ends the session.
  if (!tb || !ledger) return;
  const mine = ledger.seats[seat];
  if (tb.status !== 1 || !mine || !mine.player.equals(wallet) || !mine.reader.equals(reader.publicKey)) {
    await endSession(row, s, null, "the seat is gone (the table closed, or you took it back)");
    return;
  }
  const stack = toBig(mine.stack);
  const handNo = toBig(tb.handNo);
  // A hand finished since the last step: count it and record the stack.
  if (tb.handState === 0 && handNo > BigInt(s.last_hand)) {
    const dealtMe = ((tb.dealtMask >> seat) & 1) === 1;
    await pool.query("update agent_sessions set hands = hands + $2, last_hand = $3, stack = $4 where id = $1", [s.id, dealtMe ? 1 : 0, handNo.toString(), stack.toString()]);
    if (dealtMe) await pool.query("insert into agent_hands (session_id, hand_no, stack_after) values ($1, $2, $3) on conflict do nothing", [s.id, handNo.toString(), stack.toString()]);
    s.hands = Number(s.hands) + (dealtMe ? 1 : 0);
    s.last_hand = handNo.toString();
  }
  const program = await sessionFor(reader).program();
  if (tb.handState === 0) {
    // Between hands: leave when a limit is hit.
    const buyIn = BigInt(s.buy_in);
    const now = Math.floor(Date.now() / 1000);
    const total = (await pool.query("select coalesce(sum(hands), 0)::int as hands from agent_sessions where wallet = $1 and agent_pub = $2", [row.wallet, row.agent_pub])).rows[0].hands;
    const others = ledger.seats.filter((x: any, i: number) => i !== seat && !x.player.equals(PublicKey.default) && toBig(x.stack) > 0n).length;
    if (others === 0) { if (!aloneSince.has(s.id)) aloneSince.set(s.id, Date.now()); } else aloneSince.delete(s.id);
    const reason = row.status === "stopping" ? "stopped by you"
      : stack === 0n ? "lost its stack"
      : settings.stopLoss > 0 && stack + BigInt(settings.stopLoss) <= buyIn ? "hit your stop-loss"
      : settings.profitTarget > 0 && stack >= buyIn + BigInt(settings.profitTarget) ? "hit your profit target"
      : total >= settings.maxHands ? `played ${total} hands (your limit)`
      : now >= Number(row.until) - 60 ? "its time is up"
      : Date.now() - new Date(s.started_at).getTime() >= settings.maxMinutes * 60_000 ? "played for your time limit"
      : (aloneSince.get(s.id) ?? Date.now()) < Date.now() - 5 * 60_000 ? "nobody else at the table for 5 minutes"
      : now - Math.max(Number(tb.idleSince), Math.floor(new Date(s.started_at).getTime() / 1000)) > DEAD_TABLE_SECS ? "no hand was dealt there for 5 minutes"
      : "";
    if (reason) { await cashOut(row, s, wallet, agentKp, reader, table, stack, reason); return; }
    if (Number(tb.startRequestedFor) === 0) {
      // The host starts the table. At one whose host holds no seat (one this service hosted), any seated player may.
      const hostSeated = ledger.seats.some((x: any) => x.player.equals(tb.creator));
      const withChips = ledger.seats.filter((x: any) => !x.player.equals(PublicKey.default) && toBig(x.stack) > 0n).length;
      if (!hostSeated && withChips >= 2 && (startPressedAt.get(Number(s.id)) ?? 0) < Date.now() - 20_000) {
        startPressedAt.set(Number(s.id), Date.now());
        try { await program.methods.requestStart().accountsPartial({ player: reader.publicKey, table, ledger: acc.ledger } as any).rpc(); } catch { /* not yet */ }
      }
      return;
    }
    const next = handNo + 1n;
    if (seededFor.get(Number(s.id)) !== next) {
      try {
        await program.methods.commitSeed(seat, Array.from(randomBytes(32))).accountsPartial({ player: reader.publicKey, table, deck: acc.deck, hand: handOf(table, seat) } as any).rpc();
        seededFor.set(Number(s.id), next);
      } catch { /* already in (e.g. after a restart), or the hand started: try to start it anyway */ }
    }
    try { await program.methods.startHand().accountsPartial({ payer: reader.publicKey, config: CONFIG_PDA, table, deck: acc.deck, ledger: acc.ledger, oracleQueue: ORACLE_QUEUE } as any).rpc(); } catch { /* not yet */ }
    return;
  }
  if (tb.handState !== 3) return;
  const g = ledger.game;
  if (g.toAct !== seat) return;
  const handInfo = await rconn.getAccountInfo(handOf(table, seat), "processed");
  if (!handInfo) return;
  const hand = coder.decode("hand", handInfo.data);
  if (toBig(hand.handNo) !== handNo || hand.cards[0] === 255) return;
  const game: Game = {
    seatCount: g.seatCount, button: g.button, toAct: g.toAct, highBet: toBig(g.highBet), minRaise: toBig(g.minRaise), pot: toBig(g.pot), runout: g.runout,
    board: Array.from(g.board as number[]).slice(0, g.boardLen), boardLen: g.boardLen, bigBlind: toBig(g.bigBlind), street: g.street,
    seats: g.seats.map((x: any) => ({ status: x.status, stack: toBig(x.stack), currentBet: toBig(x.currentBet) })),
  };
  const opponents = game.seats.filter((x, i) => i !== seat && (x.status === ST.active || x.status === ST.allIn)).length;
  const d = decide(profileOf(settings), [hand.cards[0], hand.cards[1]], game.board, game, opponents);
  try {
    await program.methods.act(seat, KIND[d.kind], new anchor.BN(d.amount.toString()))
      .accountsPartial({ signer: reader.publicKey, hand: { table, ledger: acc.ledger, deck: acc.deck, record: acc.record, log: acc.log } } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: PLAY_CU })]).rpc();
  } catch { /* the turn moved on; next step */ }
}

async function cashOut(row: any, s: any, wallet: PublicKey, agentKp: Keypair, reader: Keypair, table: PublicKey, stack: bigint, reason: string) {
  const seat = Number(s.seat);
  const settings: AgentSettings = row.settings;
  const terms = s.strategy_id ? termsOf(settings) : market.NO_TERMS;
  // The seat's table key signs: it works whether or not the Agent was stopped or replaced on chain.
  // An Agent's seat leaves only through agent_cash_out (the plain cash-outs refuse it), so a copied strategy's share
  // applies whichever key signs. A fee balance that can't take money never blocks it (the program skips that share).
  const program = await sessionFor(reader).program();
  await program.methods.agentCashOut(seat).accountsPartial(await agentCashOutAccounts(reader.publicKey, wallet, terms, table, seat)).rpc();
  if (s.strategy_id && s.fee_net_before !== null) {
    const f = market.settleSol(terms, BigInt(s.fee_net_before), BigInt(s.fee_high_water), BigInt(s.buy_in), stack);
    await pool.query("update agent_sessions set creator_fee = $2, platform_fee = $3 where id = $1", [s.id, f.creatorFee.toString(), f.platformFee.toString()]);
    if (f.profit > 0n) await event(s.table_address, "agent copy fee", true, `${f.creatorFee} to the creator, ${f.platformFee} to Nomad, on ${f.profit} new profit`);
  }
  await event(s.table_address, "agent cash-out", true, `${stack} lamports: ${reason}`);
  await endSession(row, s, stack, reason);
}

async function endSession(row: any, s: any, cashOut: bigint | null, reason: string) {
  await pool.query("update agent_sessions set ended_at = now(), end_reason = $2, cash_out = $3 where id = $1", [s.id, reason, cashOut === null ? null : cashOut.toString()]);
  seededFor.delete(Number(s.id));
  aloneSince.delete(Number(s.id));
  try { sessions.delete(open(s.reader_secret).publicKey.toBase58()); } catch { /* */ }
  hostedTables.delete(s.table_address); // a hosted table its Agent left no longer stops another being hosted
  if (reason.startsWith("nobody else") || reason.startsWith("no hand was dealt")) triedTables.set(`${row.wallet}|${s.table_address}`, Date.now() + 5 * 60_000); // review M5: 15 min there
  // A limit or a stop ends the run; a lost seat or an empty table moves on to another table.
  const moveOn = reason.startsWith("nobody else") || reason.startsWith("no hand was dealt") || reason.startsWith("the seat is gone");
  if (!moveOn || row.status === "stopping") await setStatus(row.wallet, "stopped", reason);
  else await setStatus(row.wallet, "running", reason + "; looking for another table");
}
