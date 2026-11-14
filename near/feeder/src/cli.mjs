#!/usr/bin/env node
// Runs one agent table with run-ahead and prints each hand as it plays back.
//
//   node src/cli.mjs [--table-id live] [--sessions 3] [--hands 30] [--speed 1] [--ahead 1] [--store <file>]
//
// Environment (defaults in brackets):
//   OWNER [nomad-poker.testnet]           settles sessions and owns the OutLayer payment key
//   TABLE [table.nomad-poker.testnet]     the table contract; its own key opens sessions
//   PROJECT [nomad-poker.testnet/nomad-dealer]
//   OUTLAYER_API [https://testnet-api.outlayer.ai]   RPC [https://rpc.testnet.near.org]
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

const { values: a } = parseArgs({
  options: {
    "table-id": { type: "string", default: "live" },
    sessions: { type: "string", default: "3" },
    hands: { type: "string", default: "30" },
    speed: { type: "string", default: "1" },
    ahead: { type: "string", default: "1" },
    store: { type: "string" },
  },
});
const env = process.env;
const OWNER = env.OWNER ?? "nomad-poker.testnet";
const TABLE = env.TABLE ?? "table.nomad-poker.testnet";

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
  owner: TABLE,
  ownerKey: await loadKey(TABLE),
  settler: OWNER,
  settlerKey: await loadKey(OWNER),
});

const speed = Number(a.speed);
const feeder = new SessionFeeder({
  tableId: a["table-id"],
  seats: [
    { profile: { tight: 10, aggro: 80 }, stack: 300 },
    { profile: { tight: 30, aggro: 60 }, stack: 300 },
    { profile: { tight: 5, aggro: 90 }, stack: 300 },
    { profile: { tight: 40, aggro: 50 }, stack: 300 },
  ],
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
feeder.on("session-end", (e) => {
  const rebuys = e.rebuys.length ? `, rebuys: ${e.rebuys.map((r) => `seat ${r.seat}`).join(", ")}` : "";
  console.log(`${clock()}  ■ ${e.id} done, stacks ${e.endStacks.join(" ")}${rebuys}`);
});

const stop = new AbortController();
process.on("SIGINT", () => stop.abort(new Error("stopped")));
await feeder.run({ sessions: Number(a.sessions), signal: stop.signal });

const later = stats.slice(1);
console.log(`\nfirst session: viewers waited ${sec(stats[0]?.stallMs ?? 0)}`);
if (later.length) console.log(`later sessions: waited ${later.map((s) => sec(s.stallMs)).join(", ")}; ready ahead by ${later.map((s) => sec(s.leadMs)).join(", ")}`);
