#!/usr/bin/env node
// Attack report: scripted attempts by the feeder's limited key, the operator account, a pro and a stranger to take
// pool money, call owner-only methods, break the session rules or settle a session with a forged proof or edited
// actions. Each must be refused. Writes reports/attack-report.md with the method, the refusal and the transaction.
//
//   node scripts/attack-report.mjs
//
// Environment: NEAR_CREDENTIALS_DIR (the WSL testnet keychain), FEEDER_CREDENTIALS_DIR (the feeder's function-call
// key only), OUTLAYER_KEYS_FILE (payment key of OWNER for one dealer call), TABLE, RPC.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TABLE, CREDS, FEEDER_CREDS, EXPLORER, account, attempt, view, near, env } from "./lib.mjs";
import { OutlayerClient } from "../feeder/src/outlayer.mjs";
import { loadPoker } from "../feeder/src/poker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = env.OWNER ?? "nomad-poker.testnet";
const OPERATOR = "feeder.nomad-poker.testnet";
const NEAR = 10n ** 24n;

const feederKey = await account(OPERATOR, FEEDER_CREDS); // function-call key: session methods only
const operator = await account(OPERATOR).catch(() => null); // its full-access key, kept off the feeder (NEAR_CREDENTIALS_DIR)
const pro = await account("pro.nomad-poker.testnet");
const proB = await account("pro-b.nomad-poker.testnet");
const stranger = await account("stranger.nomad-poker.testnet");

const rows = [];
const setup = [];
let n = 0;
async function expectRefused(who, what, acct, method, args, opts = {}, check = null) {
  const r = await attempt(acct, method, args, opts);
  // A call that returns {"ok": false} changed nothing (submit_session reports a wrong answer that way).
  const returnedNo = r.value && r.value.ok === false;
  let refused = Boolean(r.failure) || returnedNo;
  let message = r.failure ?? (returnedNo ? `returned ok:false: ${r.value.error}` : `ACCEPTED: ${JSON.stringify(r.value)}`);
  if (refused && check) {
    const extra = await check();
    if (extra) message += ` (${extra})`;
  }
  rows.push({ n: ++n, who, what, method, refused, message, tx: r.tx, stage: r.stage });
  console.log(`${refused ? "refused " : "ACCEPTED"} #${n} ${who}: ${what} -> ${message.slice(0, 140)}`);
  return r;
}
async function step(what, acct, method, args, opts = {}) {
  const r = await attempt(acct, method, args, opts);
  setup.push({ what, method, ok: !r.failure, message: r.failure ?? JSON.stringify(r.value ?? null).slice(0, 160), tx: r.tx });
  console.log(`setup: ${what} -> ${r.failure ? "FAILED " + r.failure : "ok"}`);
  if (r.failure) throw new Error(`setup step failed: ${what}: ${r.failure}`);
  return r;
}

const pools = Object.fromEntries((await view("list_agents", { limit: 50 })).map((c) => [c.agent.id, c]));
const poolValue = async (id) => BigInt((await view("get_pool", { agent_id: id }))?.value ?? 0);
const unchanged = (id, before) => async () => ((await poolValue(id)) === before ? `pool ${id} still ${near(before)} NEAR` : `POOL ${id} CHANGED`);

// ---------------------------------------------------------------------------- the feeder's limited key
const aValue = await poolValue("nomad-a");
await expectRefused("feeder key", "take pool money: leave nomad-a's pool", feederKey, "leave_pool", { agent_id: "nomad-a", shares: "1" }, {}, unchanged("nomad-a", aValue));
await expectRefused("feeder key", "withdraw a backer's position", feederKey, "withdraw", { agent_id: "nomad-a", amount: "1" });
await expectRefused("feeder key", "claim the platform's fee earnings", feederKey, "claim_earnings", {});
await expectRefused("feeder key", "make itself the vault's fee recipient (owner only)", feederKey, "set_vault_config", { chip_yocto: "1000000000000000000000", pro_bps: 800, platform_bps: 200, platform: OPERATOR });
await expectRefused("feeder key", "attach NEAR to a session call", feederKey, "open_session", { session_id: "atk-dep", stacks: ["100", "100"], profiles: [{ tight: 1, aggro: 1 }, { tight: 1, aggro: 1 }], button: 0, sb: "1", bb: "2", hands: 1 }, { deposit: 1n });

// ---------------------------------------------------------------------------- the operator account itself
if (operator) {
  await expectRefused("operator account", "name another operator (owner only)", operator, "set_operator", { operator: "stranger.nomad-poker.testnet" });
  await expectRefused("operator account", "redirect platform fees to itself (owner only)", operator, "set_vault_config", { chip_yocto: "1000000000000000000000", pro_bps: 800, platform_bps: 200, platform: OPERATOR });
  await expectRefused("operator account", "lift every pool's loss limit (owner only)", operator, "set_default_pool_loss_limit", { loss_limit_bps: 10000 });
  await expectRefused("operator account", "point the table at another dealer (owner only)", operator, "set_project", { project_id: "stranger.nomad-poker.testnet/rogue" });
  await expectRefused("operator account", "drop the listing rules (owner only)", operator, "set_listing_rules", { min_sessions: 0, min_hands: "0" });
  await expectRefused("operator account", "cancel a settled session to unlock its buy-ins again", operator, "cancel_session", { session_id: "v2live-0" });
}

// ---------------------------------------------------------------------------- a pro
const bValue = await poolValue("nomad-b");
await expectRefused("pro (pro-b)", "take backers' money: leave its own agent's pool without shares", proB, "leave_pool", { agent_id: "nomad-b", shares: "1000000000000000000000" }, {}, unchanged("nomad-b", bValue));
await expectRefused("pro (pro-b)", "withdraw from a position it does not have", proB, "withdraw", { agent_id: "nomad-b", amount: "1000000000000000000000" });
await expectRefused("pro (pro-b)", "risk more than 50% of the pool per session", proB, "set_pool_risk", { agent_id: "nomad-b", max_buy_in_bps: 6000 });
await expectRefused("pro (pro-b)", "loosen its pool's loss limit past the owner's default", proB, "set_pool_loss_limit", { agent_id: "nomad-b", loss_limit_bps: 9000 });
await expectRefused("pro (pro-b)", "change another pro's strategy", proB, "update_agent", { agent_id: "nomad-a", profile: { fold_below: 10, raise_above: 45, aggression: 95, bluff_chance: 25, raise_size: 120 } });
await expectRefused("pro (pro-b)", "take over another pro's agent", proB, "transfer_agent", { agent_id: "nomad-a", new_owner: "pro-b.nomad-poker.testnet" });
await expectRefused("pro (pro-b)", "claim fees it did not earn", proB, "claim_earnings", {});

// ---------------------------------------------------------------------------- a stranger
await expectRefused("stranger", "leave a pool it never joined", stranger, "leave_pool", { agent_id: "nomad-a", shares: "1" }, {}, unchanged("nomad-a", aValue));
await expectRefused("stranger", "claim the platform's fees", stranger, "claim_earnings", {});
await expectRefused("stranger", "make itself operator", stranger, "set_operator", { operator: "stranger.nomad-poker.testnet" });
await expectRefused("stranger", "open a session that locks pool money", stranger, "open_backed_session", { session_id: "atk-s1", seats: [{ agent_id: "nomad-a" }, { agent_id: "nomad-c" }], buy_in_chips: "10", button: 0, sb: "1", bb: "2", hands: 3 });
await expectRefused("stranger", "join nomad-e's pool before its strategy has a track record", stranger, "join_pool", { agent_id: "nomad-e" }, { deposit: NEAR / 20n });
await expectRefused("stranger", "back nomad-e before it qualifies", stranger, "back", { agent_id: "nomad-e", loss_limit: null }, { deposit: NEAR / 20n });

// ---------------------------------------------------------------------------- session rules, opened by the feeder
await expectRefused("feeder key", "self-play: seat nomad-a and nomad-e, both pro.nomad-poker.testnet's", feederKey, "open_backed_session", { session_id: "atk-self", seats: [{ agent_id: "nomad-a" }, { agent_id: "nomad-e" }], buy_in_chips: "10", button: 0, sb: "1", bb: "2", hands: 3 });
// The deepest drawdown among the pools; its pro tightens the loss limit below it, the feeder tries to seat it.
const limits = await Promise.all(["nomad-a", "nomad-b", "nomad-c", "nomad-d"].map(async (id) => ({ id, ...(await view("get_pool_limits", { agent_id: id })) })));
const deep = limits.sort((x, y) => y.drawdown_bps - x.drawdown_bps)[0];
const proOf = { "nomad-a": pro, "nomad-b": proB, "nomad-c": await account("pro-c.nomad-poker.testnet"), "nomad-d": await account("pro-d.nomad-poker.testnet") };
const partner = deep.id === "nomad-c" ? "nomad-d" : "nomad-c";
if (deep.drawdown_bps >= 2) {
  const tight = Math.max(1, deep.drawdown_bps - 1);
  await step(`${deep.id}'s pro sets its pool loss limit to ${tight} bps (drawdown ${deep.drawdown_bps} bps)`, proOf[deep.id], "set_pool_loss_limit", { agent_id: deep.id, loss_limit_bps: tight });
  await expectRefused("feeder key", `seat ${deep.id}'s pool, now ${(deep.drawdown_bps / 100).toFixed(2)}% below its high-water mark, past its loss limit`, feederKey, "open_backed_session", { session_id: "atk-loss", seats: [{ agent_id: deep.id }, { agent_id: partner }], buy_in_chips: "10", button: 0, sb: "1", bb: "2", hands: 3 });
  await step(`${deep.id}'s pro clears its own limit again (the default applies)`, proOf[deep.id], "set_pool_loss_limit", { agent_id: deep.id, loss_limit_bps: null });
}
const cValue = await poolValue("nomad-c");
await expectRefused("feeder key", "stake more than 25% of nomad-c's pool in one session", feederKey, "open_backed_session", { session_id: "atk-risk", seats: [{ agent_id: "nomad-c" }, { agent_id: "nomad-a" }], buy_in_chips: String(Number(cValue / 10n ** 21n) / 4 + 5 | 0), button: 0, sb: "1", bb: "2", hands: 3 });

// ---------------------------------------------------------------------------- forged and edited answers
// A real backed session: the feeder opens it, the dealer plays it on OutLayer, then a stranger submits wrong
// answers (anyone may submit; a wrong answer must change nothing), and finally the real one settles it.
const sid = `atk-${Date.now().toString(36)}`;
const recorded = (await step(`feeder opens backed session ${sid} (pools of nomad-a and nomad-c, 10 chips, 4 hands)`, feederKey, "open_backed_session", { session_id: sid, seats: [{ agent_id: "nomad-a" }, { agent_id: "nomad-c" }], buy_in_chips: "10", button: 0, sb: "1", bb: "2", hands: 4 }, { gas: "100" })).value;
const keys = JSON.parse(await readFile(env.OUTLAYER_KEYS_FILE ?? join(homedir(), ".outlayer", "testnet", "payment-keys.json"), "utf8"));
const dealer = new OutlayerClient({ api: env.OUTLAYER_API, project: env.PROJECT ?? "nomad-poker.testnet/nomad-dealer", paymentKey: keys[`testnet:${OWNER}:payment-key:${env.KEY_NONCE ?? 1}`] });
console.log(`asking the dealer for ${sid} (OutLayer's queue can take minutes)...`);
const t0 = Date.now();
const answer = (await dealer.run(recorded)).output;
if (!answer?.ok) throw new Error(`dealer refused: ${JSON.stringify(answer)}`);
setup.push({ what: `dealer answered ${sid} in ${((Date.now() - t0) / 1000).toFixed(0)}s with an attested action list`, method: "OutLayer", ok: true, message: answer.attest_alpha, tx: null });
const real = { session_id: sid, alpha: answer.alpha, signature_hex: answer.signature_hex, actions: answer.actions, attest_alpha: answer.attest_alpha, attest_signature_hex: answer.attest_signature_hex };
const stillPending = async () => ((await view("get_session", { session_id: sid }))?.status === "Pending" ? "session still pending, buy-ins still locked" : "SESSION CHANGED");

const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
await expectRefused("stranger", "forged deck proof (one hex digit of the signature changed)", stranger, "submit_session", { ...real, signature_hex: flip(real.signature_hex) }, { gas: "300" }, stillPending);
const other = await view("get_session_record", { session_id: "v2live-0" });
await expectRefused("stranger", "a real proof from another session (v2live-0)", stranger, "submit_session", { ...real, alpha: other.alpha, signature_hex: other.signature_hex }, { gas: "300" }, stillPending);
await expectRefused("stranger", "an illegal edit: one more action after the last hand", stranger, "submit_session", { ...real, actions: real.actions + ",c" }, { gas: "300" }, stillPending);

// A legal edit: change one action so the whole session still replays under the betting rules.
const poker = await loadPoker(env.POKER_WASM ?? join(HERE, "..", "poker-wasm", "target", "wasm32-unknown-unknown", "release", "poker_wasm.wasm"));
const order = poker.seatOrder(real.signature_hex, 2);
const replayOk = (actions) => {
  try {
    poker.replay({ signature_hex: real.signature_hex, stacks: order.map((i) => recorded.stacks[i]), button: 0, sb: 1, bb: 2, hands: 4, actions });
    return true;
  } catch {
    return false;
  }
};
const acts = real.actions.split(/([,;])/);
let legal = null;
for (let i = 0; i < acts.length && !legal; i += 2) {
  for (const alt of ["c", "f", "r4", "r6"]) {
    if (alt === acts[i]) continue;
    const tryActs = [...acts];
    tryActs[i] = alt;
    if (replayOk(tryActs.join(""))) {
      legal = { text: tryActs.join(""), at: i / 2, from: acts[i], to: alt };
      break;
    }
  }
}
if (legal) {
  await expectRefused("stranger", `a legal edit: action ${legal.at} "${legal.from}" -> "${legal.to}" (still replays under the rules), with the real attestation`, stranger, "submit_session", { ...real, actions: legal.text }, { gas: "300" }, stillPending);
}
await expectRefused("stranger", "the real actions without the dealer's attestation", stranger, "submit_session", { ...real, attest_alpha: null, attest_signature_hex: null }, { gas: "300" }, stillPending);
await expectRefused("stranger", "the real actions with an attestation signed for other actions", stranger, "submit_session", { ...real, attest_alpha: real.attest_alpha.replace(/act-[0-9a-f]{4}/, "act-0000") }, { gas: "300" }, stillPending);
const settled = await step(`control: the real, attested answer settles ${sid}`, stranger, "submit_session", real, { gas: "300" });
if (settled.value?.ok !== true) throw new Error(`the real answer was refused: ${JSON.stringify(settled.value)}`);

// ---------------------------------------------------------------------------- report
const all = rows.every((r) => r.refused);
const link = (tx) => (tx ? `[${tx.slice(0, 8)}…](${EXPLORER}${tx})` : "none: refused before it became a transaction");
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = `# Attack report: table.nomad-poker.testnet

Run ${new Date().toISOString()} against \`${TABLE}\` (agents v2). Script: \`near/scripts/attack-report.mjs\`.

**Result: ${rows.filter((r) => r.refused).length} of ${rows.length} attempts refused${all ? "" : " — SOME WERE ACCEPTED"}.**

Who attacks:

- **feeder key**: the feeder's only key, a function-call key on \`${OPERATOR}\` limited to \`open_backed_session\`,
  \`open_session\`, \`submit_session\` and \`cancel_session\` on the table, with no deposit allowed. Calls to any other
  method are refused by NEAR itself before they become a transaction.
- **operator account**: \`${OPERATOR}\` signing with its full-access key (which the feeder does not hold), to show
  the contract refuses the operator role on every owner-only method.
- **pro**: \`pro-b.nomad-poker.testnet\`, the pro of nomad-b.
- **stranger**: \`stranger.nomad-poker.testnet\`, no role at all.

A \`submit_session\` with a wrong answer does not fail the transaction: the contract returns \`{"ok": false, "error"}\`
and changes nothing; the report checks the session is still pending afterwards.

| # | Who | Attempt | Method | Refused | Refusal | Transaction |
| --- | --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r.n} | ${r.who} | ${esc(r.what)} | \`${r.method}\` | ${r.refused ? "yes" : "**NO**"} | ${esc(r.message)} | ${link(r.tx)} |`).join("\n")}

Setup and control steps (these are meant to succeed):

| Step | Method | Result | Transaction |
| --- | --- | --- | --- |
${setup.map((s) => `| ${esc(s.what)} | \`${s.method}\` | ${s.ok ? "ok" : "failed"}: ${esc(s.message).slice(0, 160)} | ${link(s.tx)} |`).join("\n")}
`;
await mkdir(join(HERE, "reports"), { recursive: true });
await writeFile(join(HERE, "reports", "attack-report.md"), md);
console.log(`\n${rows.filter((r) => r.refused).length}/${rows.length} refused; wrote scripts/reports/attack-report.md`);
if (!all) process.exitCode = 1;
