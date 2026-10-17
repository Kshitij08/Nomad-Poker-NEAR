// Agents v2 on SOL: the runner's copy of the program's fee rule (AgentState::settle, instructions/agent.rs) and its
// reading of the v2 Agent record, checked at the byte offsets the program pins (record_layout). No network, no database.
// Run: node --import tsx test/solStrategies.test.ts
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";

// agents.ts reads its settings at import; none of them is used here.
const dummyKey = () => JSON.stringify(Array.from(Keypair.generate().secretKey));
Object.assign(process.env, { DATABASE_URL: "postgres://unused", KEEPER_SECRET_KEY: dummyKey(), AUDITOR_SECRET_KEY: dummyKey(), ARCHIVE_KEY_HEX: "00".repeat(32), ADMIN_TOKEN: "unused" });

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("PASS ", name); };

async function main() {
  const { settleSol, NO_TERMS, qualifies, LISTING } = await import("../src/solStrategies");
  const { decodeHostTab } = await import("../src/hostFees");
  const { decodeAgentState, checkSettings } = await import("../src/agents");
  const creator = Keypair.generate().publicKey;
  const terms = { creator, creatorFeeBps: 800, platformFeeBps: 200 };

  await t("fees: 8% / 2% of new profit only, high-water mark (same cases as the program's unit tests)", () => {
    let net = 0n, hw = 0n;
    const session = (buyIn: bigint, cashOut: bigint) => { const f = settleSol(terms, net, hw, buyIn, cashOut); net += cashOut - buyIn; hw = f.highWater; return f; };
    assert.deepEqual(session(10_000n, 11_000n), { profit: 1_000n, creatorFee: 80n, platformFee: 20n, highWater: 1_000n });
    assert.equal(session(10_000n, 9_000n).profit, 0n);
    assert.equal(session(10_000n, 11_000n).profit, 0n); // back to the peak: nothing new
    assert.deepEqual(session(10_000n, 10_500n), { profit: 500n, creatorFee: 40n, platformFee: 10n, highWater: 1_500n });
  });

  await t("fees: a copier who lost first pays nothing until it's won back", () => {
    assert.equal(settleSol(terms, -1_000n, 0n, 10_000n, 10_900n).profit, 0n);
    assert.equal(settleSol(terms, -1_000n, 0n, 10_000n, 12_000n).profit, 1_000n);
  });

  await t("fees: own strategy (no creator) pays nothing", () => {
    assert.equal(settleSol(NO_TERMS, 0n, 0n, 10_000n, 50_000n).creatorFee, 0n);
  });

  await t("decodeAgentState reads the v2 record at the offsets the program's record_layout test pins", async () => {
    const k = () => Keypair.generate().publicKey;
    const rec = { wallet: k(), agent: k(), table: k(), reader: k() };
    const data = Buffer.alloc(254);
    rec.wallet.toBuffer().copy(data, 8); rec.agent.toBuffer().copy(data, 40);
    data.writeBigInt64LE(1_900_000_000n, 72); data.writeUInt32LE(3, 80); data.writeBigUInt64LE(50_000_000n, 84); data.writeBigUInt64LE(10_000_000n, 92);
    rec.table.toBuffer().copy(data, 100); data[132] = 4; rec.reader.toBuffer().copy(data, 133); data[165] = 253;
    creator.toBuffer().copy(data, 166); data.writeUInt16LE(800, 198); data.writeUInt16LE(200, 200);
    data.writeBigUInt64LE(10_000_000n, 202); data.writeBigUInt64LE(70_000_000n, 210); data.writeBigUInt64LE(71_500_000n, 218);
    data.writeBigInt64LE(1_500_000n, 226);
    const d = decodeAgentState(data)!;
    assert.ok(d, "decoded");
    assert.ok(d.wallet.equals(rec.wallet) && d.agent.equals(rec.agent) && d.table.equals(rec.table) && d.reader.equals(rec.reader));
    assert.equal(d.expires, 1_900_000_000); assert.equal(d.keySet, 3); assert.equal(d.seat, 4);
    assert.equal(d.stake, 50_000_000n); assert.equal(d.committed, 10_000_000n);
    assert.ok(d.terms.creator.equals(creator)); assert.equal(d.terms.creatorFeeBps, 800); assert.equal(d.terms.platformFeeBps, 200);
    assert.equal(d.seatIn, 10_000_000n); assert.equal(d.netIn, 70_000_000n); assert.equal(d.netOut, 71_500_000n); assert.equal(d.highWater, 1_500_000n);
    assert.equal(decodeAgentState(data.subarray(0, data.length - 1)), null, "a short (v1) record isn't read as v2");
  });

  await t("agent_set's IDL takes the fee terms; the record's seeds are agent2", () => {
    const idl = require("../src/shared/poker_per.json");
    const ix = idl.instructions.find((i: any) => i.name === "agent_set");
    assert.deepEqual(ix.args.map((a: any) => a.name), ["expires", "agent", "until", "stake", "terms"]);
    const seeds = ix.accounts.find((a: any) => a.name === "agent_state").pda.seeds[0].value;
    assert.equal(Buffer.from(seeds).toString(), "agent2");
    const cash = idl.instructions.find((i: any) => i.name === "agent_cash_out").accounts.map((a: any) => a.name);
    for (const name of ["config", "creator_wallet_state", "creator_vault_token", "treasury_wallet_state", "treasury_vault_token"]) assert.ok(cash.includes(name), name);
    // Every way out of an Agent's seat pays the share: agent_cash_out (any key once the Agent is stopped) is the only one.
    assert.deepEqual(idl.instructions.find((i: any) => i.name === "agent_cash_out").args.map((a: any) => a.name), ["seat"]);
    assert.ok(idl.instructions.some((i: any) => i.name === "vault_payout_to_owner"), "vault_payout_to_owner");
    for (const ix of ["pay_host_fee", "agent_pay_host_fee", "set_fees"]) assert.ok(idl.instructions.some((i: any) => i.name === ix), ix);
    const cfg = idl.types.find((t: any) => t.name === "Config").type.fields.map((f: any) => f.name);
    for (const f of ["agent_fee_bps", "creator_fee_bps", "host_wallet", "max_host_fee"]) assert.ok(cfg.includes(f), f);
    const table = idl.types.find((t: any) => t.name === "Table").type.fields.map((f: any) => f.name);
    assert.ok(table.includes("agent_mask"), "agent_mask");
  });

  await t("checkSettings keeps a strategy id and refuses a malformed one", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    assert.equal(checkSettings({ stake: 10_000_000, strategyId: id }).strategyId, id);
    assert.throws(() => checkSettings({ stake: 10_000_000, strategyId: "x'; drop table agents" }));
    assert.equal(checkSettings({ stake: 10_000_000 }).strategyId, undefined);
  });

  await t("listing: others see and copy a strategy only after the minimum hands and a profit (defaults 100, 1 lamport)", () => {
    assert.equal(LISTING.minHands, 100); assert.equal(LISTING.minNet, 1);
    assert.equal(qualifies(99, 5_000_000), false);
    assert.equal(qualifies(100, 0), false);
    assert.equal(qualifies(100, 1), true);
    assert.equal(qualifies(5_000, -1), false);
  });

  await t("decodeHostTab reads what a wallet has paid in hosting fees (none = 0)", () => {
    const d = Buffer.alloc(8 + 32 + 8 + 1);
    d.writeBigUInt64LE(17_000_000n, 40);
    assert.equal(decodeHostTab(d), 17_000_000n);
    assert.equal(decodeHostTab(null), 0n);
  });

  console.log(`\n${n} passed`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL ", e); process.exit(1); });
