#!/usr/bin/env node
// Rebuilds every pool holding's cost basis from chain history: the contract's own nomad-vault events.
//
//   node scripts/cost-basis-history.mjs [--before <block height>] [--out history.json]
//
// - pool_joined with queued:false: the amount became shares then (deposited).
// - pool_left with queued:false: the amount was paid then (withdrawn).
// - A queued join or leave was applied when its pool's session settled (or was cancelled): session_settled lists
//   it in pool_moves as {joined, shares} (deposited), {left_shares, paid} (withdrawn) or {refunded} (neither).
//   Cancelled sessions log no moves, so a cancel that applied queued moves is reported for a manual look.
// Transactions come from NearBlocks (api-testnet.nearblocks.io/v3); logs from the RPC.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { before: { type: "string" }, out: { type: "string" }, table: { type: "string", default: "table.nomad-poker.testnet" } } });
const TABLE = a.table;
const RPC = process.env.RPC ?? "https://test.rpc.fastnear.com";
const NB = "https://api-testnet.nearblocks.io/v3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, init).catch((e) => ({ ok: false, status: String(e) }));
    if (r.ok) return r.json();
    if (i >= 6) throw new Error(`${url}: ${r.status}`);
    await sleep(2000 * (i + 1));
  }
}

// Every transaction to the table, oldest first.
const txs = [];
let cursor = null;
for (;;) {
  const page = await json(`${NB}/accounts/${TABLE}/txns${cursor ? `?next=${cursor}` : ""}`);
  for (const t of page.data ?? []) txs.push(t);
  cursor = page.meta?.next_page ?? null;
  if (!cursor || !(page.data ?? []).length) break;
  await sleep(500);
}
txs.sort((x, y) => Number(BigInt(x.block_timestamp) - BigInt(y.block_timestamp)));
const methods = new Set(["join_pool", "leave_pool", "submit_session", "cancel_session"]);
const relevant = txs.filter((t) => t.receiver_account_id === TABLE && t.outcomes?.status && (t.actions ?? []).some((x) => methods.has(x.method)) && (!a.before || Number(t.block.block_height) < Number(a.before)));
console.error(`${txs.length} transactions to ${TABLE}; ${relevant.length} joins, leaves and settlements to read`);

const flows = {}; // "account:agent" -> { deposited, withdrawn, events: [] }
const at = (who, agent) => (flows[`${who}:${agent}`] ??= { account: who, agent_id: agent, deposited: 0n, withdrawn: 0n, events: [] });
const warnings = [];
for (const t of relevant) {
  const st = await json(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: t.transaction_hash, sender_account_id: t.signer_account_id, wait_until: "NONE" } }) });
  if (!st.result) throw new Error(`no status for ${t.transaction_hash}: ${JSON.stringify(st.error).slice(0, 200)}`);
  const logs = st.result.receipts_outcome.flatMap((r) => r.outcome.logs);
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    const e = JSON.parse(l.slice(11));
    if (e.standard !== "nomad-vault") continue;
    const d = e.data[0];
    const when = { tx: t.transaction_hash, block: t.block.block_height };
    if (e.event === "pool_joined" && d.result?.queued === false) {
      at(d.account, d.agent).deposited += BigInt(d.amount);
      at(d.account, d.agent).events.push({ ...when, joined: d.amount });
    } else if (e.event === "pool_left" && d.result?.queued === false) {
      at(d.account, d.agent).withdrawn += BigInt(d.result.paid);
      at(d.account, d.agent).events.push({ ...when, paid: d.result.paid });
    } else if (e.event === "session_settled") {
      for (const seat of d.seats ?? []) {
        for (const m of seat.pool_moves ?? []) {
          if (m.joined) (at(m.account, seat.agent).deposited += BigInt(m.joined), at(m.account, seat.agent).events.push({ ...when, joined: m.joined, queued: true }));
          if (m.paid) (at(m.account, seat.agent).withdrawn += BigInt(m.paid), at(m.account, seat.agent).events.push({ ...when, paid: m.paid, queued: true }));
        }
      }
    } else if (e.event === "session_cancelled") {
      warnings.push(`session ${d.session_id} was cancelled in ${t.transaction_hash}: any queued pool moves it applied are not logged; check by hand`);
    }
  }
  await sleep(150);
}

const out = Object.values(flows).map((f) => ({ ...f, deposited: f.deposited.toString(), withdrawn: f.withdrawn.toString() }));
console.log(JSON.stringify({ table: TABLE, read_at: new Date().toISOString(), last_tx: txs.at(-1)?.transaction_hash, holdings: out, warnings }, null, 2));
if (a.out) await writeFile(a.out, JSON.stringify({ holdings: out, warnings }, null, 2));
