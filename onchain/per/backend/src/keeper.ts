// The keeper: keeps every live table moving and archives its hands. It only ever sends three
// permissionless instructions, each signed by the keeper key:
//   - `tick`: begins a dealt hand, or times out a player whose turn is up;
//   - `open_log`: shows a finished hand's action log to the auditor, which then downloads it;
//   - `commit_table`: copies the table (with its latest hand record) to Solana, at most every
//     15 minutes and only when it changed.
// It can't move funds, deal, act for a player or read live cards: the program allows none of that
// to anyone but the players and the VRF.
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { CONFIG_PDA, MAGIC_FEE_VAULT, PROGRAM_ID, TeeSession, accountsOf, coder, l1, rollupPrograms, toPublic } from "./chain";
import { config } from "./config";
import { event, pool } from "./db";
import { seal } from "./archive";
import { verify, verifyLog, HandLogFile, Record } from "./shared/verifier";

const STATUS_OPEN = 1, STATUS_CLOSED = 2;
const HAND_DEALT = 2, HAND_PLAYING = 3;
const PLAY_CU = 1_400_000;
const RETRY_AFTER_MS = 30_000;

export const keeperState = { startedAt: Date.now(), lastLoopAt: 0, lastDiscoverAt: 0, loops: 0, tablesTracked: 0, lastError: "", auditorMatches: null as boolean | null };

const keeperTee = new TeeSession(config.keeper);
const auditorTee = new TeeSession(config.auditor);
const live = new Map<string, PublicKey>();
const failedAt = new Map<string, number>();

/** Runs `fn` unless the same action on the same table failed less than 30 s ago; logs the outcome. */
async function attempt(table: string, action: string, fn: () => Promise<string>) {
  const key = `${table}/${action}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS) return;
  try {
    const detail = await fn();
    failedAt.delete(key);
    await event(table, action, true, detail);
  } catch (e: any) {
    failedAt.set(key, Date.now());
    const msg = String(e?.message ?? e).slice(0, 300);
    keeperState.lastError = `${action} ${table}: ${msg}`;
    await event(table, action, false, msg);
  }
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

async function upsertTable(address: PublicKey, t: any) {
  const p = toPublic(address, t);
  await pool.query(
    `insert into tables (address, table_id, creator, status, max_seats, seated, invite_only, small_blind, big_blind, min_buy_in, max_buy_in, hand_no, hand_state, ledger_seq, last_commit_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (address) do update set status=$4, seated=$6, hand_no=$12, hand_state=$13, ledger_seq=$14, last_commit_ts=$15, updated_at=now()`,
    [p.address, p.tableId, p.creator, p.status, p.maxSeats, p.seated, p.inviteOnly, p.smallBlind, p.bigBlind, p.minBuyIn, p.maxBuyIn, p.handNo, p.handState, p.ledgerSeq, p.lastCommitTs]);
}

/** Finds every table in the rollup with the current layout; older layouts don't decode and are skipped. */
async function discover() {
  const conn = await keeperTee.get();
  const accts = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: coder.memcmp("table") as any }] });
  const decoded: [PublicKey, any][] = [];
  for (const { pubkey, account } of accts) {
    try { decoded.push([pubkey, coder.decode("table", account.data)]); } catch { /* an older layout */ }
  }
  // Which open tables are still delegated (owned by the delegation program on Solana)?
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
    if (isLive) live.set(key, pubkey); else live.delete(key);
  }
  const n = decoded.length;
  keeperState.lastDiscoverAt = Date.now();
  keeperState.tablesTracked = live.size;
  return n;
}

async function auditorIsOurs(): Promise<boolean> {
  const info = await (await keeperTee.get()).getAccountInfo(CONFIG_PDA);
  const ours = !!info && coder.decode("config", info.data).auditor.equals(config.auditor.publicKey);
  keeperState.auditorMatches = ours;
  return ours;
}

async function step(address: PublicKey, auditorOurs: boolean) {
  const key = address.toBase58();
  const conn = await keeperTee.get();
  const info = await conn.getAccountInfo(address, "processed");
  if (!info) { live.delete(key); return; }
  const t = coder.decode("table", info.data);
  await upsertTable(address, t);
  if (t.status !== STATUS_OPEN) { live.delete(key); return; }
  const program = await keeperTee.program();
  const acc = accountsOf(address);
  const now = Math.floor(Date.now() / 1000);

  // 1. Keep the hand moving.
  if (t.handState === HAND_DEALT || (t.handState === HAND_PLAYING && now > Number(t.turnDeadline) + 1)) {
    await attempt(key, "tick", () => program.methods.tick()
      .accountsPartial({ hand: { table: address, ledger: acc.ledger, deck: acc.deck, record: acc.record, log: acc.log }, logPermission: acc.logPermission, rollup: rollupPrograms } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: PLAY_CU })]).rpc());
  }

  // 2. Archive a newly finished hand (the table's copy of its record).
  const lastHand = BigInt(t.lastRecord.handNo.toString());
  if (lastHand > 0n) {
    const known = await pool.query("select 1 from hands where table_address = $1 and hand_no = $2", [key, lastHand.toString()]);
    if (!known.rowCount) {
      const r = toRecord(t.lastRecord);
      const prev = await pool.query("select record from hands where table_address = $1 and hand_no = $2", [key, (lastHand - 1n).toString()]);
      const v = verify(r, undefined, prev.rowCount ? prev.rows[0].record.button : undefined);
      await pool.query("insert into hands (table_address, hand_no, record, verified, problems) values ($1,$2,$3,$4,$5) on conflict do nothing",
        [key, lastHand.toString(), recordJson(r), v.ok, JSON.stringify(v.problems)]);
      await event(key, "archive", v.ok, `hand ${lastHand}${v.ok ? "" : ": " + v.problems.join("; ")}`);
    }
  }

  // 3. The finished hand's log: open it to the auditor, download, check against the record, seal.
  const pending = await pool.query("select hand_no, record from hands where table_address = $1 and log_status = 'pending' order by hand_no", [key]);
  for (const row of pending.rows) {
    const handNo = BigInt(row.hand_no);
    // Once a later hand has begun (or is the table's last), this hand's log is gone for good.
    if (handNo < lastHand || (handNo === lastHand && BigInt(t.handNo.toString()) > lastHand && t.handState === HAND_PLAYING)) {
      await pool.query("update hands set log_status = 'missed' where table_address = $1 and hand_no = $2", [key, row.hand_no]);
      await event(key, "log", false, `hand ${handNo}: missed (a later hand began first)`);
      continue;
    }
    if (!auditorOurs || t.handState === HAND_PLAYING) continue;
    await attempt(key, "open_log", async () => {
      const sig = await program.methods.openLog().accountsPartial({ config: CONFIG_PDA, table: address, log: acc.log, logPermission: acc.logPermission, rollup: rollupPrograms } as any).rpc();
      const logInfo = await (await auditorTee.get()).getAccountInfo(acc.log, "processed");
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

  // 4. Commit when the table changed since its last commit and 15 minutes have passed.
  const due = now - Number(t.lastCommitTs) >= config.commitEverySecs;
  const mark = `${t.ledgerSeq}/${t.handNo}/${t.lastRecord.handNo}`;
  const last = await pool.query("select detail from keeper_events where table_address = $1 and action = 'commit_table' and ok order by id desc limit 1", [key]);
  const changed = !last.rowCount || !String(last.rows[0].detail).startsWith(mark + " ");
  if (due && changed) {
    await attempt(key, "commit_table", async () => {
      const sig = await program.methods.commitTable().accountsPartial({ payer: config.keeper.publicKey, table: address, magicFeeVault: MAGIC_FEE_VAULT } as any).rpc();
      return `${mark} ${sig}`;
    });
  }
}

export async function runKeeper() {
  for (;;) {
    const started = Date.now();
    try {
      if (Date.now() - keeperState.lastDiscoverAt > config.discoverEveryMs) await discover();
      const ours = await auditorIsOurs();
      for (const address of [...live.values()]) {
        try { await step(address, ours); } catch (e: any) { keeperState.lastError = `step ${address.toBase58()}: ${String(e?.message ?? e).slice(0, 200)}`; }
      }
      keeperState.loops++;
      keeperState.lastLoopAt = Date.now();
    } catch (e: any) {
      keeperState.lastError = `loop: ${String(e?.message ?? e).slice(0, 200)}`;
      await keeperTee.get(true).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, config.keeperIntervalMs - (Date.now() - started))));
  }
}

export { STATUS_CLOSED };
