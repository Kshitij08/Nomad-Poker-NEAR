#!/usr/bin/env node
// Runs one agent table with run-ahead and prints each hand as it plays back.
//
//   node src/cli.mjs [--table-id live] [--sessions 3] [--hands 30] [--speed 1] [--ahead 1] [--store <file>]
//
// Environment (defaults in brackets):
//   OWNER [nomad-poker.testnet]           owns the OutLayer payment key (its key is not needed)
//   TABLE [table.nomad-poker.testnet]     the table contract
//   OPERATOR [feeder.nomad-poker.testnet] opens and settles sessions: the account the owner named with set_operator.
//                                         Its key in NEAR_CREDENTIALS_DIR may be a function-call key limited to
//                                         open_backed_session, open_session, submit_session, cancel_session.
//   PROJECT [nomad-poker.testnet/nomad-dealer]
//   OUTLAYER_API [https://testnet-api.outlayer.ai]   RPC [https://test.rpc.fastnear.com]
//   NEAR_CREDENTIALS_DIR [~/.near-credentials/testnet]   keys saved by near-cli
//   PAYMENT_KEY, or OUTLAYER_KEYS_FILE [~/.outlayer/testnet/payment-keys.json] + KEY_NONCE [1]
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadPoker } from "./poker.mjs";
import { OutlayerClient } from "./outlayer.mjs";
import { TableClient, loadKey } from "./table.mjs";
import { SessionFeeder, FileStore, humanPace } from "./feeder.mjs";
import { PRESETS } from "./profiles.mjs";

const { values: a } = parseArgs({
  options: {
    "table-id": { type: "string", default: "live" },
    sessions: { type: "string", default: "3" },
    hands: { type: "string", default: "30" },
    speed: { type: "string", default: "1" },
    ahead: { type: "string", default: "1" },
    store: { type: "string" },
    // Backed table: comma-separated agent ids, all backed by --backer, each seat buying in --buy-in chips.
    agents: { type: "string" },
    backer: { type: "string" },
    // Seat each agent's pool instead of one backer's position.
    pool: { type: "boolean", default: false },
    "buy-in": { type: "string", default: "100" },
  },
});
const env = process.env;
const OWNER = env.OWNER ?? "nomad-poker.testnet";
const TABLE = env.TABLE ?? "table.nomad-poker.testnet";
const OPERATOR = env.OPERATOR ?? "feeder.nomad-poker.testnet";

async function paymentKey() {
  if (env.PAYMENT_KEY) return env.PAYMENT_KEY;
  const file = env.OUTLAYER_KEYS_FILE ?? join(homedir(), ".outlayer", "testnet", "payment-keys.json");
  const keys = JSON.parse(await readFile(file, "utf8"));
  const k = keys[`testnet:${OWNER}:payment-key:${env.KEY_NONCE ?? 1}`];
  if (!k) throw new Error(`no payment key ${env.KEY_NONCE ?? 1} for ${OWNER} in ${file}`);
  return k;
}

const poker = await loadPoker();
const dealer = new OutlayerClient({ api: env.OUTLAYER_API, project: env.PROJECT ?? "nomad-poker.testnet/nomad-dealer", paymentKey: await paymentKey() });
const table = new TableClient({
  rpc: env.RPC,
  contractId: TABLE,
  operator: OPERATOR,
  operatorKey: await loadKey(OPERATOR),
});

const speed = Number(a.speed);
const backed = a.agents
  ? { seats: a.agents.split(",").map((agent_id) => ({ backer: a.pool ? null : a.backer ?? OWNER, agent_id: agent_id.trim() })), buyIn: Number(a["buy-in"]) }
  : null;
const feeder = new SessionFeeder({
  tableId: a["table-id"],
  backed,
  // An unbacked demo table: the app's four playstyles (v2 profiles, in hundredths).
  seats: PRESETS.map((profile) => ({ profile, stack: 300 })),
  hands: Number(a.hands),
  ahead: Number(a.ahead),
  dealer,
  table,
  poker,
  store: new FileStore(a.store ?? `feeder-state-${a["table-id"]}.json`),
  pace: (h) => humanPace(h) / speed,
});

const t0 = Date.now();
const clock = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const signed = (n) => (n > 0 ? `+${n}` : String(n)).padStart(5);
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const stats = [];

feeder.on("fetching", (e) => console.log(`${clock()}  ⇢ asking the dealer for ${e.id} (stacks ${e.stacks.join(" ")})`));
feeder.on("retry", (e) => console.log(`${clock()}  ↻ ${e.what}, attempt ${e.attempt}: ${e.error}`));
feeder.on("ready", (s) => console.log(`${clock()}  ✓ ${s.id} ready: ${s.hands.length} hands; dealer answered in ${sec(s.fetchedMs)} (ran ${s.runMs} ms), settled in ${sec(s.settleMs)}`));
feeder.on("session", (s) => {
  stats.push(s);
  const wait = s.stallMs > 500 ? `playback WAITED ${sec(s.stallMs)}` : `ready ${sec(s.leadMs)} before needed`;
  console.log(`${clock()}  ▶ playing ${s.id}: ${wait}`);
});
feeder.on("hand", (h) => {
  const deltas = h.deltas.map(signed).join("");
  console.log(`${clock()}      ${h.session} #${String(h.index).padEnd(3)} btn ${h.button}  board ${h.board.join(" ")}  ${h.actions.padEnd(30).slice(0, 30)} ${deltas}`);
});
const nearOf = (yocto) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4);
feeder.on("ready", (s) => {
  for (const p of s.payouts?.seats ?? []) {
    const result = (BigInt(p.cash_out) - BigInt(p.buy_in)) / 10n ** 18n;
    console.log(`${clock()}      paid ${p.agent} (${p.backer ? `backer ${p.backer}` : "pool"}): bought in ${nearOf(p.buy_in)}, cashed out ${nearOf(p.cash_out)} NEAR (${Number(result) / 1e6 >= 0 ? "+" : ""}${(Number(result) / 1e6).toFixed(4)}); pro ${nearOf(p.pro_fee)}, platform ${nearOf(p.platform_fee)}, backer ${nearOf(p.to_backer)}`);
    for (const m of p.pool_moves ?? []) console.log(`${clock()}        pool: ${JSON.stringify(m)}`);
  }
});
feeder.on("ready", (s) => {
  for (const p of s.nearAi ?? []) console.log(`${clock()}      NEAR AI: ${p.agent_id} played ${JSON.stringify({ fold_below: p.profile.fold_below, raise_above: p.profile.raise_above, aggression: p.profile.aggression, bluff_chance: p.profile.bluff_chance, raise_size: p.profile.raise_size, position_weight: p.profile.position_weight })}, chosen by ${p.model} (chat ${p.chat_id}, signer ${p.signing_address})`);
  for (const e of s.nearAiErrors ?? []) console.log(`${clock()}      NEAR AI: ${e.agent_id} played its fallback profile: ${e.error}`);
});
feeder.on("session-end", (e) => {
  const rebuys = e.rebuys.length ? `, rebuys: ${e.rebuys.map((r) => `seat ${r.seat}`).join(", ")}` : "";
  console.log(`${clock()}  ■ ${e.id} done, stacks ${e.endStacks.join(" ")}${rebuys}`);
});

const stop = new AbortController();
process.on("SIGINT", () => stop.abort(new Error("stopped")));
try {
  await feeder.run({ sessions: Number(a.sessions), signal: stop.signal });
} catch (e) {
  const reason = String(e.message ?? e).replace(/^.*Contract panicked: /s, "").split("\n")[0];
  console.log(`\n${clock()}  ■ table stopped: ${reason}`);
  process.exitCode = 1;
}

const later = stats.slice(1);
console.log(`\nfirst session: viewers waited ${sec(stats[0]?.stallMs ?? 0)}`);
if (later.length) console.log(`later sessions: waited ${later.map((s) => sec(s.stallMs)).join(", ")}; ready ahead by ${later.map((s) => sec(s.leadMs)).join(", ")}`);
