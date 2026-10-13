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
import { CONFIG_PDA, PROGRAM_ID, TeeSession, accountsOf, coder, l1, rollupPrograms } from "./chain";
import { config } from "./config";
import { event, pool } from "./db";
import { PRESETS, Profile, clampProfile, decide, Game, ST } from "./agentBot";
import * as market from "./solStrategies";
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
    out.custom = clampProfile({ foldBelow: Number(c.foldBelow ?? 0.3), raiseAbove: Number(c.raiseAbove ?? 0.66), aggression: Number(c.aggression ?? 0.5), bluffChance: Number(c.bluffChance ?? 0.07), raiseFractionOfPot: Number(c.raiseFractionOfPot ?? 0.62) });
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
  terms: market.FeeTerms; seatIn: bigint; netIn: bigint; netOut: bigint; highWater: bigint; skipped: number;
};
const AGENT_STATE_LEN = 8 + 32 + 32 + 8 + 4 + 8 + 8 + 32 + 1 + 32 + 1 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 4 + 16;
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
  const skipped = d.readUInt32LE(o); o += 4;
  return { wallet, agent, expires, keySet, stake, committed, table, seat, reader, terms: { creator, creatorFeeBps, platformFeeBps }, seatIn, netIn, netOut, highWater, skipped };
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
const seenRequests = new Map<string, number>(); // request signature -> when (review L2: each is accepted once)
setInterval(() => { const cut = Date.now() - 5 * 60_000; for (const [k, v] of seenRequests) if (v < cut) seenRequests.delete(k); }, 60_000).unref();

export async function authorize(path: string, body: any): Promise<{ wallet: PublicKey; playKey: PublicKey; data: any }> {
  const { wallet, playKey, expires, keySet, walletSig, ts, data, sig } = body ?? {};
  const now = Math.floor(Date.now() / 1000);
  if (typeof data !== "string" || typeof sig !== "string" || typeof walletSig !== "string" || !Number.isFinite(ts) || Math.abs(now - ts) > 120) throw new Error("stale or malformed request");
  if (!Number.isFinite(expires) || expires <= now || !Number.isInteger(keySet) || keySet < 0) throw new Error("play key expired");
  const w = new PublicKey(wallet), k = new PublicKey(playKey);
  // Review L3: both signatures before any network call; then the key set on Solana must still be this one.
  if (!nacl.sign.detached.verify(playKeyMessage(k, expires, keySet), Buffer.from(walletSig, "base64"), w.toBytes())) throw new Error("bad wallet signature");
  if (!nacl.sign.detached.verify(requestMessage(path, ts, data), Buffer.from(sig, "base64"), k.toBytes())) throw new Error("bad request signature");
  if (seenRequests.has(sig)) throw new Error("request already used");
  seenRequests.set(sig, Date.now());
  if ((await walletState(w)).keySet !== keySet) throw new Error("play key cancelled");
  return { wallet: w, playKey: k, data: data ? JSON.parse(data) : {} };
}

/** Rollup logins travel as `?token=` in URLs; never send one back (review L4). */
const redact = (m: string) => m.replace(/token=[^&\s"']+/g, "token=<redacted>");

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
      settings.terms = { creator: c.terms.creator.toBase58(), creatorFeeBps: c.terms.creatorFeeBps, platformFeeBps: c.terms.platformFeeBps };
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
  route("/quickplay/onchain", async (_wallet, data) => {
    const level = Math.max(0, Math.min(STAKES.length - 1, Number(data?.stake ?? 0) | 0));
    const st = STAKES[level];
    const recentTs = Math.floor(Date.now() / 1000) - 600;
    const listed = (await pool.query(
      `select address from tables where status = 1 and delegated and not invite_only and seated < max_seats and big_blind = $1
         and (hand_state <> 0 or idle_since > $2) order by seated desc, updated_at desc limit 1`, [st.big.toString(), recentTs])).rows;
    if (listed.length) return { table: listed[0].address, hosted: false };
    const now = Date.now();
    for (const h of hostedTables.values()) if (h.big === st.big && now - h.at < 10 * 60_000) return { table: h.address, hosted: true };
    const recent = [...hostedTables.values()].filter((h) => now - h.at < 10 * 60_000);
    if (recent.length >= MAX_WAITING_HOSTED) throw new Error("too many new tables are waiting for players; try again in a minute");
    const table = await hostTableAt(st);
    if (!table) throw new Error("couldn't open a table right now; try again");
    return { table, hosted: true };
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
  a.get("/sol-strategies", (req: Request, res: Response) => reply(res, market.list(String(req.query.sort ?? "top"), Number(req.query.limit) || 30).then((strategies) => ({ strategies }))));
  a.get("/sol-strategies/:id", (req: Request, res: Response) => reply(res, market.get(String(req.params.id))));
  route("/sol-strategies/publish", (wallet, data) => market.publish(wallet, data));
  route("/sol-strategies/unlist", (wallet, data) => market.unlist(wallet, data?.strategyId));
  route("/sol-strategies/mine", (wallet) => market.dashboard(wallet));
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
let hosting: Promise<string | null> | null = null;
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
async function hostTableFor(settings: AgentSettings, left: bigint): Promise<string | null> {
  if (hosting) return null;
  const fits = STAKES.filter((st) => { const bb = BigInt(Math.max(10, settings.buyInBB)) * st.big; return (bb > st.min ? bb : st.min) <= left; });
  if (fits.length === 0) return null;
  const st = fits[fits.length - 1];
  const now = Date.now();
  // One waiting at this stake already (hosted in the last 10 minutes)? The Agent joins that one instead.
  const recent = [...hostedTables.values()].filter((h) => now - h.at < 10 * 60_000);
  if (recent.some((h) => h.big === st.big) || recent.length >= MAX_WAITING_HOSTED) return null;
  return hostTableAt(st);
}

/** Hosts one public 8-seat table at a stake level, the keeper as its creator (it pays and later reclaims the rent). */
async function hostTableAt(st: { small: bigint; big: bigint; min: bigint; max: bigint }): Promise<string | null> {
  if (hosting) return hosting;
  hosting = (async () => {
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
  })();
  try { return await hosting; } finally { hosting = null; }
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
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("step took too long")), STEP_LIMIT_MS).unref());
    Promise.race([stepAgent(row), timeout])
      .catch((e: any) => { runnerState.lastError = redact(`${row.wallet.slice(0, 6)}: ${String(e?.message ?? e).slice(0, 200)}`); })
      .finally(() => busy.delete(row.wallet));
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
  const left = rec.stake > rec.committed ? rec.stake - rec.committed : 0n;
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
        // Lost a race for the seat (or the table just appeared): try again next step, not in 10 minutes.
        const lostRace = t.hosted || /SeatTaken|InvalidSeat/.test(String(e?.message ?? e));
        if (!lostRace) triedTables.set(`${row.wallet}|${t.address}`, now);
        await event(t.address, "agent buy-in", false, redact(String(e?.message ?? e)));
        continue;
      }
    }
    waitingSince.delete(row.wallet);
    await setStatus(row.wallet, row.status, `playing at table ${t.address.slice(0, 6)}…, seat ${seat + 1}`);
    await event(t.address, "agent buy-in", true, `${amount} lamports, seat ${seat}`);
    return;
  }
  if (left < 1n) { await setStatus(row.wallet, row.status, "its stake is used up"); return; }
  // Your playtest: nothing to join, so after a minute of waiting it hosts a public table at its stake (the platform's
  // keeper pays the rent, as for tournament tables, and closes and reclaims it once it's empty). Another Agent or a
  // player can then join; with its host not seated, any seated player may press Start round.
  if (!waitingSince.has(row.wallet)) waitingSince.set(row.wallet, now);
  if (!settings.table && now - waitingSince.get(row.wallet)! >= 60_000) {
    const hosted = await hostTableFor(settings, left).catch(async (e: any) => { await event(null, "agent host", false, redact(String(e?.message ?? e))); return null; });
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
    seatCount: g.seatCount, toAct: g.toAct, highBet: toBig(g.highBet), minRaise: toBig(g.minRaise), pot: toBig(g.pot), runout: g.runout,
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
  const program = await sessionFor(reader).program();
  try {
    await program.methods.agentCashOut(seat).accountsPartial(await agentCashOutAccounts(reader.publicKey, wallet, terms, table, seat)).rpc();
  } catch (e: any) {
    const why = redact(String(e?.message ?? e));
    if (!s.strategy_id || /HandInProgress/.test(why)) throw e;
    // Copying, and the cash-out with the fees failed: leaving comes first. The seat's table key cashes it out the plain
    // way; the record then counts the seat as left another way (no fee, no loss carried forward).
    const { seed } = await walletState(wallet);
    const vault = vaultOf(wallet, seed), acc = accountsOf(table), hand = handOf(table, seat);
    await program.methods.vaultCashOut(seat, new anchor.BN(0)).accountsPartial({
      signer: reader.publicKey, wallet, vault, walletState: walletStateOf(wallet), vaultToken: ata(vault), instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      table, ledger: acc.ledger, ledgerPermission: permissionPdaFromAccount(acc.ledger), hand, handPermission: permissionPdaFromAccount(hand), escrow: ata(table), rollup: rollupPrograms,
    } as any).rpc();
    await event(s.table_address, "agent cash-out", false, `with the profit share failed (${why.slice(0, 200)}); left without it`);
    await endSession(row, s, stack, reason);
    return;
  }
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
