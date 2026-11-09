// The keeper: keeps every live table moving and archives its hands. It only ever sends four
// permissionless instructions, each signed by the keeper key:
//   - `tick`: begins a dealt hand, or times out a player whose turn is up;
//   - `open_log`: shows a finished hand's action log to the auditor, which then downloads it;
//   - `commit_table`: copies the table (with its latest hand record) to Solana, at most every
//     15 minutes and only when it changed;
//   - `close_table_keyed` (M9b): closes a table left empty and idle for 6 escape delays. Any
//     unpaid rake goes to the dev wallet and any leftover to the host's game balance; the host
//     reclaims the rent.
// It can't move funds, deal, act for a player or read live cards: the program allows none of that
// to anyone but the players and the VRF. M11 adds the tournament jobs (tourney.ts): it creates and pays for
// tournament tables, and the refunds and prizes it triggers can only go to players' own game balances.
import { createHash } from "crypto";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { CONFIG_PDA, MAGIC_FEE_VAULT, PROGRAM_ID, TeeSession, accountsOf, coder, l1, redact, rollupPrograms, toPublic } from "./chain";
import { config } from "./config";
import { event, pool } from "./db";
import { seal } from "./archive";
import { verify, verifyLog, HandLogFile, Record } from "./shared/verifier";
import { stepTournaments } from "./tourney";
import * as anchor from "@coral-xyz/anchor";
import idl from "./shared/poker_per.json";

const STATUS_OPEN = 1, STATUS_CLOSED = 2;
const HAND_DEALT = 2, HAND_PLAYING = 3;
const PLAY_CU = 1_400_000;
const RETRY_AFTER_MS = 30_000;
const CONCURRENCY = 4;

export const keeperState = { standby: false, startedAt: Date.now(), lastLoopAt: 0, lastDiscoverAt: 0, loops: 0, tablesTracked: 0, lastError: "", lastErrorAt: 0, auditorMatches: null as boolean | null,
  dlp: { slot: null as number | null, expected: null as number | null, changed: false, checkedAt: 0 }, tournaments: 0 };

/** Rollup logins, RPC keys and hosts never reach a log, an event or /health (chain.ts). */
export { redact };
function fail(where: string, e: any) {
  keeperState.lastError = redact(`${where}: ${String(e?.message ?? e)}`).slice(0, 300);
  keeperState.lastErrorAt = Date.now();
}

const keeperTee = new TeeSession(config.keeper);
const auditorTee = new TeeSession(config.auditor);
const live = new Map<string, PublicKey>();
const reclaimed = new Set<string>();
const failedAt = new Map<string, number>();

/** Runs `fn` unless the same action on the same table failed less than 30 s ago; logs the outcome. */
async function attempt(table: string, action: string, fn: () => Promise<string>) {
  const key = `${table}/${action}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS) return;
  try {
    const detail = await fn();
    failedAt.delete(key);
    await event(table, action, true, redact(detail));
  } catch (e: any) {
    failedAt.set(key, Date.now());
    fail(`${action} ${table}`, e);
    await event(table, action, false, redact(describe(e)));
  }
}

/** An error as text, including what an empty message hides (a staging commit_table failed with ""): its name, its
 *  cause, and the program's last log lines when the RPC returned them. */
function describe(e: any): string {
  const parts = [e?.message || `${e?.name ?? "Error"} (no message)`];
  if (e?.cause) parts.push(`cause: ${e.cause?.message ?? String(e.cause)}`);
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  if (logs.length) parts.push(`logs: ${logs.slice(-4).join(" | ")}`);
  if (!e?.message && !e?.cause && !logs.length) parts.push(String(e));
  return parts.join("; ");
}

function toRecord(x: any): Record & { logHash: Buffer; logLen: number; boardLen: number } {
  return { table: x.table, handNo: BigInt(x.handNo.toString()), button: x.button, dealtMask: x.dealtMask, seedMask: x.seedMask,
    seeds: x.seeds.map((s: number[]) => Buffer.from(s)), entropy: Buffer.from(x.entropy), shuffleSeed: Buffer.from(x.shuffleSeed),
    cards: Array.from(x.cards), logHash: Buffer.from(x.logHash), logLen: x.logLen, boardLen: x.boardLen };
}

export function recordJson(r: ReturnType<typeof toRecord>) {
  return { table: r.table.toBase58(), handNo: r.handNo.toString(), button: r.button, dealtMask: r.dealtMask, seedMask: r.seedMask,
    seeds: r.seeds.map((s) => s.toString("hex")), entropy: r.entropy.toString("hex"), shuffleSeed: r.shuffleSeed.toString("hex"),
    cards: r.cards, boardLen: r.boardLen, logHash: r.logHash.toString("hex"), logLen: r.logLen };
}

export function recordFromJson(j: any) {
  return { table: new PublicKey(j.table), handNo: BigInt(j.handNo), button: j.button, dealtMask: j.dealtMask, seedMask: j.seedMask,
    seeds: j.seeds.map((s: string) => Buffer.from(s, "hex")), entropy: Buffer.from(j.entropy, "hex"), shuffleSeed: Buffer.from(j.shuffleSeed, "hex"),
    cards: j.cards, boardLen: j.boardLen, logHash: Buffer.from(j.logHash, "hex"), logLen: j.logLen };
}

const recordHash = (j: object) => createHash("sha256").update(JSON.stringify(j)).digest("hex");

async function upsertTable(address: PublicKey, t: any) {
  const p = toPublic(address, t);
  await pool.query(
    `insert into tables (address, table_id, creator, status, max_seats, seated, invite_only, small_blind, big_blind, min_buy_in, max_buy_in, hand_no, hand_state, ledger_seq, last_commit_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (address) do update set status=$4, seated=$6, hand_no=$12, hand_state=$13, ledger_seq=$14, last_commit_ts=$15, updated_at=now()`,
    [p.address, p.tableId, p.creator, p.status, p.maxSeats, p.seated, p.inviteOnly, p.smallBlind, p.bigBlind, p.minBuyIn, p.maxBuyIn, p.handNo, p.handState, p.ledgerSeq, p.lastCommitTs]);
  await pool.query("update tables set idle_since = $2 where address = $1", [p.address, Number(t.idleSince)]);
}

/** Finds every table in the rollup with the current layout; older layouts don't decode and are skipped. */
async function discover() {
  const conn = await keeperTee.get();
  const accts = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: coder.memcmp("table") as any }] });
  const decoded: [PublicKey, any][] = [];
  for (const { pubkey, account } of accts) {
    try { decoded.push([pubkey, coder.decode("table", account.data)]); } catch { /* an older layout */ }
  }
  // Which open tables are still delegated (owned by the delegation program on Solana)? One taken
  // back through the escape hatch leaves a stale "open" copy in the rollup.
  const open = decoded.filter(([, t]) => t.status === STATUS_OPEN).map(([k]) => k);
  const delegated = new Set<string>();
  for (let i = 0; i < open.length; i += 100) {
    const infos = await l1.getMultipleAccountsInfo(open.slice(i, i + 100));
    infos.forEach((a, j) => { if (a?.owner.equals(DELEGATION_PROGRAM_ID)) delegated.add(open[i + j].toBase58()); });
  }
  for (const [pubkey, t] of decoded) {
    const key = pubkey.toBase58(), isLive = t.status === STATUS_OPEN && delegated.has(key);
    await upsertTable(pubkey, t);
    await pool.query("update tables set delegated = $2 where address = $1", [key, delegated.has(key)]);
    if (isLive) live.set(key, pubkey);
    else if (live.has(key)) {
      // Leaving: settle its last hand's pending log (closed tables are no longer stepped).
      live.delete(key);
      await archiveLogs(key, pubkey, t, false, null);
    }
  }
  // M12: tables the Agent runner hosted (the keeper is their creator and paid their rent). Once one is closed and
  // back on Solana, the keeper takes its rent back.
  for (const [pubkey, t] of decoded) {
    const key = pubkey.toBase58();
    if (t.status !== STATUS_CLOSED || !t.creator.equals(config.keeper.publicKey) || reclaimed.has(key)) continue;
    const onL1 = await l1.getAccountInfo(pubkey).catch(() => null);
    if (!onL1) { reclaimed.add(key); continue; }
    if (!onL1.owner.equals(PROGRAM_ID)) continue; // still on its way back from the rollup
    await attempt(key, "reclaim_table (agent-hosted)", async () => {
      const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(l1, new anchor.Wallet(config.keeper), { commitment: "confirmed" }));
      const sig = await program.methods.reclaimTable(t.tableId).accountsPartial({
        creator: config.keeper.publicKey, table: pubkey, escapePayer: PublicKey.findProgramAddressSync([Buffer.from("escape-payer"), pubkey.toBuffer()], PROGRAM_ID)[0],
      } as any).rpc();
      reclaimed.add(key);
      return sig;
    });
  }
  keeperState.lastDiscoverAt = Date.now();
  keeperState.tablesTracked = live.size;
  return decoded.length;
}

async function auditorIsOurs(): Promise<boolean> {
  const info = await (await keeperTee.get()).getAccountInfo(CONFIG_PDA);
  const ours = !!info && coder.decode("config", info.data).auditor.equals(config.auditor.publicKey);
  keeperState.auditorMatches = ours;
  return ours;
}

/**
 * Archives the table's last finished hand. After an escape-hatch rollback the table restarts from
 * an older commit and replays hand numbers with new content, so rows for rolled-back hands (a
 * number above the table's last, or the same number with a different record) move to
 * hands_superseded and the new record is archived in their place.
 */
async function archive(key: string, t: any) {
  const lastHand = BigInt(t.lastRecord.handNo.toString());
  const rolledBack = await pool.query("select hand_no from hands where table_address = $1 and hand_no > $2", [key, lastHand.toString()]);
  if (lastHand === 0n && !rolledBack.rowCount) return;
  const r = toRecord(t.lastRecord), json = recordJson(r), hash = recordHash(json);
  const same = lastHand > 0n
    ? await pool.query("select record->>'shuffleSeed' as seed from hands where table_address = $1 and hand_no = $2", [key, lastHand.toString()])
    : { rowCount: 0, rows: [] as any[] };
  // A hand's shuffle seed identifies its content: a different one under the same number is a replay.
  const replaced = same.rowCount && same.rows[0].seed !== json.shuffleSeed ? [lastHand.toString()] : [];
  const supersede = [...rolledBack.rows.map((x: any) => String(x.hand_no)), ...replaced];
  if (supersede.length) {
    // SQLite (D1) has no data-modifying CTE: copy, then delete. A failure between the two leaves a duplicate in
    // hands_superseded, never a lost hand. The hand numbers travel as a JSON array (json_each).
    const nos = JSON.stringify(supersede.map(Number));
    await pool.query(
      `insert into hands_superseded (table_address, hand_no, record, verified, problems, log_status, log_enc, log_verified, archived_at, record_hash, button_checked, superseded_at)
       select table_address, hand_no, record, verified, problems, log_status, log_enc, log_verified, archived_at, record_hash, button_checked, now()
         from hands where table_address = $1 and hand_no in (select value from json_each($2))`, [key, nos]);
    await pool.query("delete from hands where table_address = $1 and hand_no in (select value from json_each($2))", [key, nos]);
    await event(key, "rollback", false, `hands ${supersede.join(", ")} superseded: the table was rolled back`);
  }
  if (lastHand === 0n || (same.rowCount && !replaced.length)) return;
  const prev = await pool.query("select record from hands where table_address = $1 and hand_no = $2", [key, (lastHand - 1n).toString()]);
  const buttonChecked = lastHand === 1n || (prev.rowCount ?? 0) > 0;
  const v = verify(r, undefined, prev.rowCount ? prev.rows[0].record.button : undefined);
  await pool.query(
    "insert into hands (table_address, hand_no, record, verified, problems, record_hash, button_checked) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing",
    [key, lastHand.toString(), json, v.ok, JSON.stringify(v.problems), hash, buttonChecked]);
  await event(key, "archive", v.ok, `hand ${lastHand}${v.ok ? "" : ": " + v.problems.join("; ")}${buttonChecked ? "" : " (button not checked: previous hand not archived)"}`);
}

/** Reads the log as the auditor, logging in again once if the session was rejected. */
async function readLogAsAuditor(log: PublicKey) {
  try { return await (await auditorTee.get()).getAccountInfo(log, "processed"); }
  catch { return (await auditorTee.get(true)).getAccountInfo(log, "processed"); }
}

/** Right after open_log the rollup can take a moment before the auditor's reads see the log (staging, 9 Nov: "can't
 *  read the log yet", then readable on the next try). Retried for a few seconds here, rather than failing the action
 *  into its 30 s backoff, which lost the log once the next hand began. */
async function readOpenedLog(log: PublicKey) {
  for (let i = 0; i < 8; i++) {
    const info = await readLogAsAuditor(log);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** The finished hand's log: open it to the auditor, download, check against the record, seal. */
async function archiveLogs(key: string, address: PublicKey, t: any, auditorOurs: boolean, program: any) {
  const lastHand = BigInt(t.lastRecord.handNo.toString());
  const acc = accountsOf(address);
  const pending = await pool.query("select hand_no, record from hands where table_address = $1 and log_status = 'pending' order by hand_no", [key]);
  for (const row of pending.rows) {
    const handNo = BigInt(row.hand_no);
    // Once a later hand has begun, or the table closed, this hand's log is gone for good.
    const reason = t.status !== STATUS_OPEN ? "the table closed"
      : handNo < lastHand || (BigInt(t.handNo.toString()) > lastHand && t.handState === HAND_PLAYING) ? "a later hand began first" : "";
    if (reason) {
      await pool.query("update hands set log_status = 'missed' where table_address = $1 and hand_no = $2", [key, row.hand_no]);
      await event(key, "log", false, `hand ${handNo}: missed (${reason})`);
      continue;
    }
    if (!auditorOurs || !program || t.handState === HAND_PLAYING) continue;
    await attempt(key, "open_log", async () => {
      const sig = await program.methods.openLog().accountsPartial({ config: CONFIG_PDA, table: address, log: acc.log, logPermission: acc.logPermission, rollup: rollupPrograms } as any).rpc();
      const logInfo = await readOpenedLog(acc.log);
      if (!logInfo) throw new Error("the auditor can't read the log yet");
      const log = coder.decode("handLog", logInfo.data);
      if (BigInt(log.handNo.toString()) !== handNo) throw new Error(`the log holds hand ${log.handNo}, not ${handNo}`);
      const n = Math.min(log.len, log.entries.length);
      const file: HandLogFile = { table: key, handNo: handNo.toString(), secret: Buffer.from(log.secret).toString("hex"), len: log.len,
        entries: log.entries.slice(0, n).map((e: any) => ({ street: e.street, seat: e.seat, kind: e.kind, committed: e.committed.toString() })) };
      const v = verifyLog(recordFromJson(row.record), file);
      await pool.query("update hands set log_status = 'archived', log_enc = $3, log_verified = $4 where table_address = $1 and hand_no = $2",
        [key, row.hand_no, seal(key, handNo.toString(), file), v.ok]);
      return `hand ${handNo}: ${n} actions, ${v.ok ? "hash matches" : "HASH MISMATCH"} (${sig})`;
    });
  }
}

/** Commits when 15 minutes have passed since the table's last commit and it changed since ours. */
async function maybeCommit(key: string, address: PublicKey, t: any, program: any) {
  if (Math.floor(Date.now() / 1000) - Number(t.lastCommitTs) < config.commitEverySecs) return;
  // The program takes an outsider's commit only when the table changed since its last commit (commit_table:
  // ledger_seq or hand_no moved). Without this check a fresh table, before anyone sat, got a commit that fails
  // CommitTooSoon; Railway's slower loop usually reached tables after players sat, the new stack's doesn't.
  if (t.committedLedgerSeq !== undefined && t.ledgerSeq.toString() === t.committedLedgerSeq.toString() && t.handNo.toString() === t.committedHandNo.toString()) return;
  const mark = `${t.ledgerSeq}/${t.handNo}/${t.lastRecord.handNo}`;
  const last = await pool.query("select last_commit_mark from tables where address = $1", [key]);
  if (last.rows[0]?.last_commit_mark === mark) return;
  await attempt(key, "commit_table", async () => {
    try {
      const sig = await program.methods.commitTable().accountsPartial({ payer: config.keeper.publicKey, table: address, magicFeeVault: MAGIC_FEE_VAULT } as any).rpc();
      await pool.query("update tables set last_commit_mark = $2 where address = $1", [key, mark]);
      return `${mark} ${sig}`;
    } catch (e) {
      // A commit that landed but whose confirmation was lost (or someone else's commit) moves the
      // table's last_commit_ts: count it as done instead of paying for another.
      const info = await (await keeperTee.get()).getAccountInfo(address, "processed");
      if (info && Number(coder.decode("table", info.data).lastCommitTs) !== Number(t.lastCommitTs)) {
        await pool.query("update tables set last_commit_mark = $2 where address = $1", [key, mark]);
        return `${mark} (committed; confirmation not seen)`;
      }
      throw e;
    }
  });
}

async function step(address: PublicKey, auditorOurs: boolean) {
  const key = address.toBase58();
  const info = await (await keeperTee.get()).getAccountInfo(address, "processed");
  if (!info) { live.delete(key); return; }
  const t = coder.decode("table", info.data);
  await upsertTable(address, t);
  const program = await keeperTee.program();
  // Archive first: beginning the next hand (below) wipes the finished hand's log (M7 review).
  await archive(key, t);
  await archiveLogs(key, address, t, auditorOurs, program);
  if (t.status !== STATUS_OPEN) { live.delete(key); return; }

  const now = Math.floor(Date.now() / 1000);
  if (t.handState === HAND_DEALT || (t.handState === HAND_PLAYING && now > Number(t.turnDeadline) + 1)) {
    const acc = accountsOf(address);
    await attempt(key, "tick", () => program.methods.tick()
      .accountsPartial({ hand: { table: address, ledger: acc.ledger, deck: acc.deck, record: acc.record, log: acc.log }, logPermission: acc.logPermission, rollup: rollupPrograms } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: PLAY_CU })]).rpc());
    return; // the table changed: the next loop works from a fresh read
  }
  if (await maybeStartTourneyHand(key, address, t, program, now)) return;
  if (await maybeCloseAbandoned(key, address, t, program, now)) return;
  await maybeCommit(key, address, t, program);
}

const HAND_IDLE = 0, HAND_SHUFFLING = 1, KIND_TOURNEY = 1;
/** As the program's SEED_WINDOW_SECS and VRF_RETRY_SECS. */
const SEED_WINDOW_SECS = 20, VRF_RETRY_SECS = 20;
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const seatCount = (mask: number) => mask.toString(2).split("").filter((c) => c === "1").length;
/** Your playtest: a tournament table whose players are away never dealt a hand (start_hand was only ever sent by a
 *  player's browser). At a tournament table every seat with chips is dealt after the seed window, so the keeper
 *  starts the next hand there once the window has passed (or retries a VRF request that never came back). Cash
 *  tables are left to their players: an idle cash table should stay idle. */
async function maybeStartTourneyHand(key: string, address: PublicKey, t: any, program: any, now: number) {
  if (t.kind !== KIND_TOURNEY || Number(t.startRequestedFor) === 0) return false;
  const idleReady = t.handState === HAND_IDLE && t.needsSync === 0 && seatCount(t.seatMask) >= 2 && now - Number(t.idleSince) >= SEED_WINDOW_SECS + 1;
  const retry = t.handState === HAND_SHUFFLING && now - Number(t.vrfRequestedTs) >= VRF_RETRY_SECS + 1;
  if (!idleReady && !retry) return false;
  const acc = accountsOf(address);
  await attempt(key, retry ? "start_hand retry" : "start_hand", () => program.methods.startHand()
    .accountsPartial({ payer: config.keeper.publicKey, config: CONFIG_PDA, table: address, deck: acc.deck, ledger: acc.ledger, oracleQueue: ORACLE_QUEUE } as any).rpc());
  return true;
}
// Associated token addresses without @solana/spl-token (not a backend dependency).
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const getAssociatedTokenAddressSync = (mint: PublicKey, owner: PublicKey, _offCurve = false) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const DEFAULT_ESCAPE_IDLE_SECS = 3_600;
/** As the program's ABANDONED_ESCAPE_DELAYS: abandoned = empty and idle for 6 escape delays. */
const ABANDONED_ESCAPE_DELAYS = 6;
let configCache: { at: number; devWallet: PublicKey; idleSecs: number } | null = null;
async function programConfig() {
  if (configCache && Date.now() - configCache.at < 300_000) return configCache;
  const info = await l1.getAccountInfo(CONFIG_PDA);
  const c = coder.decode("config", info!.data);
  return (configCache = { at: Date.now(), devWallet: c.devWallet, idleSecs: (c.escapeIdleSecs || DEFAULT_ESCAPE_IDLE_SECS) * ABANDONED_ESCAPE_DELAYS });
}

/** M9b: closes a table nobody sits at that's been idle for the config's escape delay (the program
 *  checks the same rule; anyone may do it). Returns true when it closed the table. */
async function maybeCloseAbandoned(key: string, address: PublicKey, t: any, program: any, now: number) {
  if (!config.closeAbandoned || t.seatMask !== 0 || t.handState !== HAND_IDLE) return false;
  const cfg = await programConfig();
  if (now - Number(t.lastActivityTs) < cfg.idleSecs + 30) return false; // a margin for the rollup clock
  const acc = accountsOf(address);
  // A table created and delegated but never opened (its ledger, deck, record and log were never made) can't be closed:
  // close_table_keyed fails "expected this account to be already initialized". Two Quick Play tables were left so on
  // staging (9 Nov: the L1 confirmation bug stopped the host flow after delegating). Open it first: open_table only
  // creates the missing accounts and doesn't touch the idle clock, so the next pass closes it.
  if (!(await (await keeperTee.get()).getAccountInfo(acc.record, "processed").catch(() => null))) {
    let opened = false;
    await attempt(key, "open_table (never opened; then close)", async () => {
      const sig = await program.methods.openTable().accountsPartial({
        payer: config.keeper.publicKey, table: address, ledger: acc.ledger, ledgerPermission: permissionPdaFromAccount(acc.ledger), deck: acc.deck,
        deckPermission: permissionPdaFromAccount(acc.deck), record: acc.record, log: acc.log, logPermission: acc.logPermission, rollup: rollupPrograms,
      } as any).rpc();
      opened = true;
      return sig;
    });
    return opened;
  }
  // M10: the host's state on Solana says which game vault is current: its 8-byte seed (all zeros = the first
  // vault, the M9 address). A state that can't be read leaves the vault out (no leftover sweep).
  const walletState = PublicKey.findProgramAddressSync([Buffer.from("wallet"), t.creator.toBuffer()], PROGRAM_ID)[0];
  const st = await l1.getAccountInfo(walletState);
  const seed = st && st.data.length >= 52 ? st.data.subarray(44, 52) : Buffer.alloc(8);
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), t.creator.toBuffer(), seed.every((b) => b === 0) ? Buffer.alloc(0) : Buffer.from(seed)], PROGRAM_ID)[0];
  const vaultToken = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
  // The host's game balance gets any leftover, if the host has one (an absent optional account would fail).
  const hasVault = !!(await (await keeperTee.get()).getAccountInfo(vaultToken, "processed").catch(() => null));
  let closed = false;
  await attempt(key, "close_table_keyed", async () => {
    const sig = await program.methods.closeTableKeyed(new (require("@coral-xyz/anchor").BN)(0)).accountsPartial({
      signer: config.keeper.publicKey, config: CONFIG_PDA, table: address, ledger: acc.ledger, ledgerPermission: permissionPdaFromAccount(acc.ledger), deck: acc.deck,
      escrow: getAssociatedTokenAddressSync(NATIVE_MINT, address, true), creatorVaultToken: hasVault ? vaultToken : null,
      devToken: getAssociatedTokenAddressSync(NATIVE_MINT, cfg.devWallet), record: acc.record, log: acc.log, logPermission: acc.logPermission,
      vault: rollupPrograms.vault, permissionProgram: rollupPrograms.permissionProgram, magicFeeVault: MAGIC_FEE_VAULT,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID, walletState,
    } as any).rpc();
    closed = true;
    live.delete(key);
    return `abandoned (idle ${now - Number(t.lastActivityTs)} s) ${sig}`;
  });
  return closed;
}

/**
 * M10: MagicBlock's delegation program holds every table, escrow and vault while they're in the rollup, and
 * the escape hatch depends on how it behaves. Its program data records the slot it was last upgraded in;
 * a change from the expected slot (DLP_EXPECTED_SLOT, else the first one this process saw) shows on /health
 * and as a `dlp_changed` event, so the operator re-runs the escape-hatch suite before trusting it.
 */
async function checkDelegationProgram() {
  if (Date.now() - keeperState.dlp.checkedAt < 600_000) return;
  keeperState.dlp.checkedAt = Date.now();
  const prog = await l1.getAccountInfo(DELEGATION_PROGRAM_ID);
  if (!prog || prog.data.length < 36) return;
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const pd = await l1.getAccountInfo(programData, { dataSlice: { offset: 4, length: 8 } } as any);
  if (!pd) return;
  const slot = Number(pd.data.readBigUInt64LE(0));
  const d = keeperState.dlp;
  d.slot = slot;
  if (d.expected === null) d.expected = Number(process.env.DLP_EXPECTED_SLOT || slot);
  if (slot !== d.expected && !d.changed) {
    d.changed = true;
    await event(null, "dlp_changed", false, `delegation program upgraded: slot ${d.expected} -> ${slot}; re-run the escape-hatch checks`);
  }
}

let lastPrune = 0, lastTourneys = 0;
export async function runKeeper() {
  for (;;) {
    const started = Date.now();
    try {
      if (Date.now() - keeperState.lastDiscoverAt > config.discoverEveryMs) await discover();
      const ours = await auditorIsOurs();
      await checkDelegationProgram().catch((e) => fail("dlp check", e));
      const tables = [...live.values()];
      for (let i = 0; i < tables.length; i += CONCURRENCY) {
        await Promise.all(tables.slice(i, i + CONCURRENCY).map((a) => step(a, ours).catch((e) => fail(`step ${a.toBase58()}`, e))));
      }
      // M11: tournaments (create, open and link their tables, start, seat, sync, refund, pay out).
      if (Date.now() - lastTourneys > 5_000) {
        lastTourneys = Date.now();
        keeperState.tournaments = await stepTournaments(keeperTee, attempt).catch((e) => { fail("tournaments", e); return keeperState.tournaments; });
      }
      if (Date.now() - lastPrune > 3_600_000) {
        await pool.query("delete from keeper_events where at < now() - interval '30 days'");
        lastPrune = Date.now();
      }
      keeperState.loops++;
      keeperState.lastLoopAt = Date.now();
    } catch (e: any) {
      fail("loop", e);
      await keeperTee.get(true).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, config.keeperIntervalMs - (Date.now() - started))));
  }
}

export { STATUS_CLOSED };
