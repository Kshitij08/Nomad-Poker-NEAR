#!/usr/bin/env node
// Soak test: runs N backed sessions of agent pools through the feeder (no playback pauses), then reconciles from the
// contract's own views that every yoctoNEAR is accounted for: pool values, the 8% pro and 2% platform fees, and that
// agent sessions take no rake. Writes reports/soak-report.md.
//
//   node scripts/soak.mjs [--sessions 3] [--hands 50] [--agents nomad-a,nomad-b,nomad-c,nomad-d] [--buy-in auto]
//
// Environment: as the feeder (FEEDER_CREDENTIALS_DIR or NEAR_CREDENTIALS_DIR for the operator's key,
// OUTLAYER_KEYS_FILE), plus TABLE and RPC.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TABLE, FEEDER_CREDS, EXPLORER, view, near, env, keyOf } from "./lib.mjs";
import { OutlayerClient } from "../feeder/src/outlayer.mjs";
import { TableClient } from "../feeder/src/table.mjs";
import { loadPoker } from "../feeder/src/poker.mjs";
import { SessionFeeder, MemoryStore } from "../feeder/src/feeder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: { sessions: { type: "string", default: "3" }, hands: { type: "string", default: "50" }, agents: { type: "string", default: "nomad-a,nomad-b,nomad-c,nomad-d" }, "buy-in": { type: "string", default: "auto" }, "table-id": { type: "string" } } });
const OWNER = env.OWNER ?? "nomad-poker.testnet";
const OPERATOR = env.OPERATOR ?? "feeder.nomad-poker.testnet";
const agents = a.agents.split(",").map((s) => s.trim());
const SESSIONS = Number(a.sessions);
const HANDS = Number(a.hands);

// ---------------------------------------------------------------------------- snapshot from views
async function snapshot() {
  const cfg = await view("get_vault_config");
  const cards = Object.fromEntries((await view("list_agents", { limit: 100 })).map((c) => [c.agent.id, c]));
  const pros = [...new Set(agents.map((id) => cards[id].agent.owner))];
  const earnings = {};
  for (const acct of [...pros, cfg.platform]) earnings[acct] = BigInt(await view("get_earnings", { account: acct }));
  const pools = {};
  for (const id of agents) {
    const p = await view("get_pool", { agent_id: id });
    pools[id] = { value: BigInt(p.value), shares: BigInt(p.shares), fees_paid: BigInt(p.fees_paid), at_table: BigInt(p.at_table), price: BigInt(p.price), hwm: BigInt(p.hwm_price), sessions: p.sessions };
  }
  return { cfg, cards, pros, earnings, pools };
}

const before = await snapshot();
const chip = BigInt(before.cfg.chip_yocto);
// Buy-in: 15% of the smallest pool (the per-session cap is 25%), so later sessions still fit after a loss.
const smallest = agents.map((id) => before.pools[id].value).reduce((m, v) => (v < m ? v : m));
const buyIn = a["buy-in"] === "auto" ? Number((smallest * 15n) / 100n / chip) : Number(a["buy-in"]);
for (const id of agents) {
  const l = before.cards[id].limits;
  if (!l.accepts_sessions) throw new Error(`${id}'s pool is past its loss limit; pick other agents`);
}
console.log(`soak: ${SESSIONS} sessions x up to ${HANDS} hands, ${agents.join(", ")}, buy-in ${buyIn} chips (${near(BigInt(buyIn) * chip)} NEAR)`);

// ---------------------------------------------------------------------------- run
const keys = JSON.parse(await readFile(env.OUTLAYER_KEYS_FILE ?? join(homedir(), ".outlayer", "testnet", "payment-keys.json"), "utf8"));
const dealer = new OutlayerClient({ api: env.OUTLAYER_API, project: env.PROJECT ?? "nomad-poker.testnet/nomad-dealer", paymentKey: keys[`testnet:${OWNER}:payment-key:${env.KEY_NONCE ?? 1}`] });
const table = new TableClient({ rpc: env.RPC, contractId: TABLE, operator: OPERATOR, operatorKey: await keyOf(OPERATOR, FEEDER_CREDS) });
const poker = await loadPoker(env.POKER_WASM ?? join(HERE, "..", "poker-wasm", "target", "wasm32-unknown-unknown", "release", "poker_wasm.wasm"));
const feeder = new SessionFeeder({
  tableId: a["table-id"] ?? `soak${Date.now().toString(36).slice(-5)}`,
  backed: { seats: agents.map((agent_id) => ({ backer: null, agent_id })), buyIn },
  hands: HANDS,
  ahead: 1,
  dealer,
  table,
  poker,
  store: new MemoryStore(),
  pace: () => 0,
});
const sessions = [];
const t0 = Date.now();
feeder.on("fetching", (e) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s asking the dealer for ${e.id}`));
feeder.on("retry", (e) => console.log(`  retry ${e.what} #${e.attempt}: ${e.error}`));
feeder.on("ready", (s) => {
  sessions.push(s);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s.id}: ${s.hands.length} hands, dealer ${(s.fetchedMs / 1000).toFixed(0)}s, settled ${s.settleTx}`);
});
await feeder.run({ sessions: SESSIONS });
const runSecs = (Date.now() - t0) / 1000;
const after = await snapshot();

// ---------------------------------------------------------------------------- reconcile
const checks = [];
const check = (what, ok, detail) => {
  checks.push({ what, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${detail}`);
};
const sum = (xs) => xs.reduce((x, y) => x + y, 0n);
const perPool = Object.fromEntries(agents.map((id) => [id, { buyIn: 0n, cashOut: 0n, toBackers: 0n, pro: 0n, platform: 0n, moves: 0n }]));
const perPro = {};
let platformFees = 0n;
let hands = 0;
for (const s of sessions) {
  hands += s.hands.length;
  const seats = s.payouts.seats;
  const bi = sum(seats.map((p) => BigInt(p.buy_in)));
  const co = sum(seats.map((p) => BigInt(p.cash_out)));
  check(`${s.id}: chips conserved, no rake`, bi === co, `bought in ${near(bi)}, cashed out ${near(co)} NEAR over ${s.hands.length} hands`);
  for (const p of seats) {
    const [b, c, pf, plf, tb] = [p.buy_in, p.cash_out, p.pro_fee, p.platform_fee, p.to_backer].map(BigInt);
    const gain = c > b ? c - b : 0n;
    // pro = floor(base * 8%), platform = floor(base * 2%) for one fee base no larger than the gain.
    const lo = [pf * 125n, plf * 500n].reduce((x, y) => (x > y ? x : y));
    const hi = [(pf + 1n) * 125n, (plf + 1n) * 500n].reduce((x, y) => (x < y ? x : y));
    const splitOk = tb + pf + plf === c && lo < hi && lo <= gain;
    check(`${s.id} ${p.agent}: 90/8/2 split`, splitOk, `cash-out ${near(c)} = backers ${near(tb)} + pro ${near(pf)} + platform ${near(plf)}; gain ${near(gain)}`);
    const acc = perPool[p.agent];
    acc.buyIn += b;
    acc.cashOut += c;
    acc.toBackers += tb;
    acc.pro += pf;
    acc.platform += plf;
    for (const m of p.pool_moves ?? []) acc.moves += BigInt(m.joined ?? 0) - BigInt(m.paid ?? 0) - BigInt(m.refunded ?? 0);
    perPro[p.pro] = (perPro[p.pro] ?? 0n) + pf;
    platformFees += plf;
  }
}
for (const id of agents) {
  const x = perPool[id];
  const want = before.pools[id].value + x.toBackers - x.buyIn + x.moves;
  check(`pool ${id}: value`, after.pools[id].value === want, `${near(before.pools[id].value)} + returned ${near(x.toBackers)} - staked ${near(x.buyIn)} = ${near(want)}; contract says ${near(after.pools[id].value)}`);
  const fees = after.pools[id].fees_paid - before.pools[id].fees_paid;
  check(`pool ${id}: fees paid`, fees === x.pro + x.platform, `contract ${near(fees)} = pro ${near(x.pro)} + platform ${near(x.platform)}`);
  check(`pool ${id}: nothing left at the table`, after.pools[id].at_table === 0n, `at_table ${near(after.pools[id].at_table)}`);
}
for (const pro of after.pros) {
  const d = after.earnings[pro] - (before.earnings[pro] ?? 0n);
  check(`pro ${pro}: earnings`, d === (perPro[pro] ?? 0n), `+${near(d)} NEAR on the contract; 8% fees in payouts ${near(perPro[pro] ?? 0n)}`);
}
const plat = before.cfg.platform;
const dPlat = after.earnings[plat] - before.earnings[plat];
check(`platform ${plat}: earnings`, dPlat === platformFees, `+${near(dPlat)} NEAR on the contract; 2% fees in payouts ${near(platformFees)}`);
const totalPools = sum(agents.map((id) => after.pools[id].value - before.pools[id].value));
const totalEarn = sum(Object.keys(after.earnings).map((k) => after.earnings[k] - (before.earnings[k] ?? 0n)));
const totalMoves = sum(agents.map((id) => perPool[id].moves));
check("money only moves", totalPools + totalEarn === totalMoves, `pools ${near(totalPools)} + fee earnings ${near(totalEarn)} = ${near(totalPools + totalEarn)} (joins minus leaves ${near(totalMoves)})`);
const proFees = sum(Object.values(perPro));
check("fees are 8% and 2% of the same base", proFees === 4n * platformFees || (proFees >= 4n * platformFees && proFees - 4n * platformFees < 4n * BigInt(sessions.length * agents.length)), `pro ${near(proFees)}, platform ${near(platformFees)} (ratio ${platformFees ? (Number(proFees) / Number(platformFees)).toFixed(4) : "n/a"}, rounding down per seat)`);

// ---------------------------------------------------------------------------- report
const ok = checks.every((c) => c.ok);
const esc = (s) => String(s).replace(/\|/g, "\\|");
const md = `# Soak report: table.nomad-poker.testnet

Run ${new Date().toISOString()} against \`${TABLE}\` (agents v2). Script: \`near/scripts/soak.mjs\`.

**${sessions.length} sessions, ${hands} hands, ${runSecs.toFixed(0)} s. Reconciliation: ${checks.filter((c) => c.ok).length} of ${checks.length} checks pass${ok ? "" : " — SOME FAILED"}.**

Setup: the pools of ${agents.map((x) => `\`${x}\``).join(", ")} (four different pros), each staking ${buyIn} chips
(${near(BigInt(buyIn) * chip)} NEAR, 15% of the smallest pool) per session, up to ${HANDS} hands, blinds 1/2. Sessions are
opened by the feeder's function-call key, played by the OutLayer dealer (seated from the deck proof, actions attested)
and settled on the contract. Every number below comes from the contract's views (\`get_pool\`, \`get_earnings\`,
\`list_agents\`) before and after, and from the payouts the contract returned when it settled each session.

## Sessions

| Session | Hands | Seat order | Results (chips) | Dealer wait | Settlement |
| --- | --- | --- | --- | --- | --- |
${sessions.map((s) => `| ${s.id} | ${s.hands.length} | ${s.payouts.seats.map((p) => p.agent).join(", ")} | ${s.payouts.seats.map((p) => `${p.agent} ${((Number(BigInt(p.cash_out) - BigInt(p.buy_in)) / Number(chip)) >= 0 ? "+" : "")}${Number(BigInt(p.cash_out) - BigInt(p.buy_in)) / Number(chip)}`).join(", ")} | ${(s.fetchedMs / 1000).toFixed(0)} s | ${s.settleTx ? `[${s.settleTx.slice(0, 8)}…](${EXPLORER}${s.settleTx})` : "?"} |`).join("\n")}

## Pools (NEAR)

| Pool | Pro | Before | Staked | Returned to backers | Pro fee 8% | Platform fee 2% | After (contract) | Drawdown after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${agents.map((id) => `| ${id} | ${after.cards[id].agent.owner} | ${near(before.pools[id].value)} | ${near(perPool[id].buyIn)} | ${near(perPool[id].toBackers)} | ${near(perPool[id].pro)} | ${near(perPool[id].platform)} | ${near(after.pools[id].value)} | ${(after.cards[id].limits.drawdown_bps / 100).toFixed(2)}% |`).join("\n")}

Fee earnings on the contract: ${Object.keys(after.earnings).map((k) => `\`${k}\` ${near(before.earnings[k] ?? 0n)} → ${near(after.earnings[k])}`).join("; ")}.

Rake: agent sessions take none. Every session's cash-outs equal its buy-ins exactly; the only charges are the
performance fees (8% pro, 2% platform) on gains above each pool's high-water mark.

## Listing after the run

${agents.map((id) => `- \`${id}\`: strategy v${after.cards[id].listing.strategy_version}, ${after.cards[id].listing.sessions} sessions / ${after.cards[id].listing.hands} hands under it, ${after.cards[id].listing.qualified ? "qualified (open to new backers)" : "not yet qualified"}`).join("\n")}

## Checks

| Check | Result | Detail |
| --- | --- | --- |
${checks.map((c) => `| ${esc(c.what)} | ${c.ok ? "ok" : "**FAIL**"} | ${esc(c.detail)} |`).join("\n")}
`;
await mkdir(join(HERE, "reports"), { recursive: true });
await writeFile(join(HERE, "reports", "soak-report.md"), md);
console.log(`\n${hands} hands in ${sessions.length} sessions; ${checks.filter((c) => c.ok).length}/${checks.length} checks pass; wrote scripts/reports/soak-report.md`);
if (!ok) process.exitCode = 1;
