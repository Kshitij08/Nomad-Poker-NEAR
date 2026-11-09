// The Postgres → D1 port, checked without a network: a local D1 bridge (apps/per/src/bridge.ts over node:sqlite, the
// schema from apps/per/migrations) and the service's own query shim (src/db.ts).
//   1. Every SQL statement the service sends (pool.query literals in src/) is translated and prepared against the
//      schema: a syntax error or a missing column fails here, not in the keeper loop.
//   2. Round trips keep the node-postgres types (bigint strings, booleans, Dates, JSON, Buffers).
//   3. The rewritten statements behave: admitSpend's caps, the keeper lease, upserts, the strategies' track record.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";

const MIGRATIONS = join(__dirname, "..", "..", "migrations");
const SRC = join(__dirname, "..", "src");

async function main() {
  // A D1 stand-in with the PER schema, served through the same bridge code the Worker runs.
  const { D1Shim } = await import("../../../../packages/db/src/testing/d1Shim");
  const { bridgeResponse } = await import("../../src/bridge");
  const shim = new D1Shim();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) shim.sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  const db = shim as unknown as D1Database;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const r = await bridgeResponse(db, new Request("http://d1.per/query", { method: "POST", body }));
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.D1_BRIDGE_URL = `http://127.0.0.1:${port}/query`;
  process.env.KEEPER_SECRET_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));
  process.env.AUDITOR_SECRET_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));
  process.env.ARCHIVE_KEY_HEX = randomBytes(32).toString("hex");
  process.env.ADMIN_TOKEN = "test";
  const { pool, toSqlite, admitSpend, holdLease, event } = await import("../src/db");

  // ---- 1. every statement prepares against the schema
  const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  const consts = new Map<string, string>();
  for (const f of sources) {
    const s = readFileSync(join(SRC, f), "utf8");
    for (const m of s.matchAll(/const (\w+_SQL) = `([^`]*)`/g)) consts.set(m[1], m[2]);
  }
  let prepared = 0;
  for (const f of sources) {
    const s = readFileSync(join(SRC, f), "utf8");
    for (const m of s.matchAll(/\bquery\(\s*(["`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      let sql = m[2].replace(/\$\{(\w+)\}/g, (_x, name) => consts.get(name) ?? (name === "where" ? "s.listed" : `<<${name}>>`));
      if (sql.includes("<<")) throw new Error(`${f}: unknown interpolation in ${sql.slice(0, 80)}`);
      if (/^\s*(do \$\$|create |alter )/i.test(sql)) continue; // the old Postgres migrations (now migrations/0001_per.sql)
      const t = toSqlite(sql);
      const n = Math.max(0, ...[...t.matchAll(/\?(\d+)/g)].map((x) => Number(x[1])));
      try {
        shim.sqlite.prepare(t.replace(/\?\d+/g, "?"));
      } catch (e) {
        throw new Error(`${f}: ${(e as Error).message}\n  postgres: ${sql}\n  sqlite:   ${t}`);
      }
      void n;
      prepared++;
    }
  }
  assert.ok(prepared >= 70, `found only ${prepared} statements`);
  console.log(`ok: ${prepared} statements prepare against the D1 schema`);

  // ---- 2. types round-trip as node-postgres returned them
  await pool.query(
    `insert into tables (address, table_id, creator, status, max_seats, seated, invite_only, small_blind, big_blind, min_buy_in, max_buy_in, hand_no, hand_state, ledger_seq, last_commit_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (address) do update set status=$4, seated=$6, hand_no=$12, hand_state=$13, ledger_seq=$14, last_commit_ts=$15, updated_at=now()`,
    ["T1", "42", "C1", 1, 6, 2, false, "5000", "10000", "100000", "1000000", "3", 2, "9", 1700000000]);
  await pool.query("update tables set delegated = $2 where address = $1", ["T1", true]);
  await pool.query("update tables set idle_since = $2 where address = $1", ["T1", Math.floor(Date.now() / 1000)]);
  const lobby = await pool.query("select * from tables where status = 1 and delegated and (hand_state <> 0 or idle_since > extract(epoch from now()) - 3600) order by updated_at desc limit 200");
  assert.equal(lobby.rows.length, 1);
  const t = lobby.rows[0];
  assert.equal(t.small_blind, "5000");
  assert.equal(t.hand_no, "3");
  assert.equal(t.invite_only, false);
  assert.equal(t.delegated, true);
  assert.ok(t.updated_at instanceof Date && Math.abs(t.updated_at.getTime() - Date.now()) < 5000);
  const record = { handNo: "3", shuffleSeed: "ab", cards: [1, 2] };
  const enc = randomBytes(40);
  await pool.query(
    "insert into hands (table_address, hand_no, record, verified, problems, record_hash, button_checked) values ($1, $2, $3, $4, $5, $6, $7)",
    ["T1", "3", record, true, [], "h", false]);
  await pool.query("update hands set log_status = 'archived', log_enc = $3, log_verified = $4 where table_address = $1 and hand_no = $2", ["T1", "3", enc, true]);
  const h = (await pool.query("select * from hands where table_address = $1 and hand_no = $2", ["T1", "3"])).rows[0];
  assert.deepEqual(h.record, record);
  assert.deepEqual(h.problems, []);
  assert.equal(h.button_checked, false); // api.ts reads `button_checked !== false`
  assert.ok(Buffer.isBuffer(h.log_enc) && h.log_enc.equals(enc));
  assert.equal((await pool.query("select record->>'shuffleSeed' as seed from hands where table_address = $1 and hand_no = $2", ["T1", "3"])).rows[0].seed, "ab");
  const before = await pool.query(
    `select table_address, hand_no, record from hands where table_address = $1 and ($2::bigint is null or hand_no < $2::bigint) order by hand_no desc limit $3`, ["T1", null, 50]);
  assert.equal(before.rows.length, 1);
  console.log("ok: bigint strings, booleans, Dates, JSON and blobs round-trip");

  // ---- 3. the rewritten statements
  assert.ok(await admitSpend("host", "w1", "r", 2, 3));
  assert.ok(await admitSpend("host", "w1", "r", 2, 3));
  assert.equal(await admitSpend("host", "w1", "r", 2, 3), null, "per-wallet cap");
  assert.ok(await admitSpend("host", "w2", "r", 2, 3));
  assert.equal(await admitSpend("host", "w3", "r", 2, 3), null, "cap for everyone");
  assert.ok(await admitSpend("host", "w3", "r", 2, 0), "no cap for everyone when total <= 0");
  const recent = (await pool.query("select count(*)::int as n from keeper_spend where kind = 'host' and at > now() - interval '10 minutes'")).rows[0].n;
  assert.equal(recent, 4);
  assert.equal(await holdLease("keeper", "a", 30_000), true);
  assert.equal(await holdLease("keeper", "b", 30_000), false, "another holder waits");
  assert.equal(await holdLease("keeper", "a", 30_000), true, "the holder renews");
  shim.sqlite.exec("update leases set expires_at = 0");
  assert.equal(await holdLease("keeper", "b", 30_000), true, "a lapsed lease is taken over");
  await event("T1", "tick", true, "x");
  const ev = (await pool.query("select * from keeper_events where (cast($2 as text) is null or table_address = $2) order by id desc limit $1", [10, "T1"])).rows;
  assert.equal(ev[0].ok, true);
  assert.equal(typeof ev[0].id, "string");
  // Payouts: register, re-register only when done or stale.
  const register = `insert into vault_payouts (wallet, expected) values ($1, $2)
       on conflict (wallet) do update set expected = $2, paid = 0, landed = 0, registered_at = now(), landed_changed_at = now(), last_paid_at = null, done = false
       where vault_payouts.done
          or greatest(vault_payouts.registered_at, vault_payouts.landed_changed_at, coalesce(vault_payouts.last_paid_at, vault_payouts.registered_at)) < now() - interval '15 minutes'`;
  await pool.query(register, ["W", "100"]);
  await pool.query("update vault_payouts set paid = 40 where wallet = $1", ["W"]);
  await pool.query(register, ["W", "200"]);
  assert.equal((await pool.query("select * from vault_payouts where wallet = $1", ["W"])).rows[0].paid, "40", "a fresh payout isn't reset");
  await pool.query("update vault_payouts set done = true where wallet = $1", ["W"]);
  await pool.query(register, ["W", "200"]);
  const p = (await pool.query("select * from vault_payouts where wallet = $1", ["W"])).rows[0];
  assert.equal(p.expected, "200");
  assert.equal(p.done, false);
  const due = (await pool.query("update vault_payouts set last_checked_at = now() where wallet in (select wallet from vault_payouts where not done order by last_checked_at nulls first limit 20) returning *")).rows;
  assert.equal(due.length, 1);
  // Host credits: greatest → max.
  await pool.query("insert into host_credits (wallet) values ($1) on conflict do nothing", ["H"]);
  assert.equal((await pool.query("update host_credits set used = used + $2, updated_at = now() where wallet = $1 and used + $2 <= $3 returning used", ["H", "30", "50"])).rowCount, 1);
  assert.equal((await pool.query("update host_credits set used = used + $2, updated_at = now() where wallet = $1 and used + $2 <= $3 returning used", ["H", "30", "50"])).rowCount, 0);
  await pool.query("update host_credits set used = greatest(used - $2, 0), updated_at = now() where wallet = $1", ["H", "100"]);
  assert.equal((await pool.query("select used from host_credits where wallet = $1", ["H"])).rows[0].used, "0");
  console.log("ok: spend caps, lease, events, payouts, host credits");

  // The strategies' track record: windowed per-hand results, mean and the sum of squares for the deviation.
  await pool.query(
    "insert into sol_strategies (strategy_id, creator, creator_name, name, version, profile) values ($1, $2, $3, $4, $5, $6)",
    ["S1", "C", "c", "n", 1, { style: "x" }]);
  const sid = (await pool.query(
    `insert into agent_sessions (wallet, agent_pub, table_address, seat, reader_secret, buy_in, stack, last_hand, strategy_id, fee_net_before, fee_high_water)
     values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10) returning id`, ["W1", "A", "T1", 0, Buffer.from([1]), "1000000", "0", "S1", "0", "0"])).rows[0].id;
  const stacks = [1010000, 1000000, 1030000];
  for (let i = 0; i < stacks.length; i++) await pool.query("insert into agent_hands (session_id, hand_no, stack_after) values ($1, $2, $3) on conflict do nothing", [sid, i + 1, stacks[i]]);
  await pool.query("update agent_sessions set ended_at = now(), end_reason = $2, cash_out = $3 where id = $1", [sid, "done", "1030000"]);
  const q = `${consts.get("HANDS_SQL")} select s.*, ${consts.get("TRACK_RECORD_SQL")} ${consts.get("FROM_SQL")} where s.listed group by s.strategy_id`;
  const rec = (await pool.query(q, [])).rows[0];
  const nb = [10000 / 10000, -10000 / 10000, 30000 / 10000]; // per hand, in big blinds (10,000 lamports)
  const mean = nb.reduce((a, b) => a + b) / nb.length;
  const sd = Math.sqrt(nb.reduce((a, b) => a + (b - mean) ** 2, 0) / (nb.length - 1));
  assert.equal(Number(rec.hands), 3);
  assert.ok(Math.abs(Number(rec.mean_bb) - mean) < 1e-9);
  const sdFromSquares = Math.sqrt((Number(rec.ss_bb) - 3 * mean * mean) / 2);
  assert.ok(Math.abs(sdFromSquares - sd) < 1e-9, `sd ${sdFromSquares} vs ${sd}`);
  assert.equal(Number(rec.net), 30000);
  console.log("ok: strategies' track record (window, mean, deviation from squares)");

  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
