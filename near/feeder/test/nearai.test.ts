import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sealStrategy, recoverSigner, profileFromResponse, verifyNearAiProof, type NearAiProof } from "../src/nearai.ts";

test("sealing matches the dealer's Rust code byte for byte", () => {
  // poker-core's only_the_dealer_opens_a_private_strategy_and_only_for_its_agent (dealer key [5;32], eph secret [6;32]).
  const pk = "50a61409b1ddd0325e9b16b700e719e9772c07000b1bd7786e907c653d20495d";
  const s = sealStrategy("play tight early, loosen up when ahead", pk, "nomad-b", new Uint8Array(32).fill(6));
  assert.equal(s.eph, "f5b2d6e60f9477e310c2982daaa6c9136c108a1777c5947e448fa37d68174557");
  assert.equal(s.ct, "6773898ba2ae3129ea9a1fa7a4287c72d79f78a800db4fdd01f4764cee4dde633eb1e68dfdbd2e723fcd94b7bb54480cb2976e8c7ad8");
  assert.throws(() => sealStrategy("x".repeat(1001), pk, "nomad-b"), /1 to 1000/);
});

// A real NEAR AI Cloud completion (Qwen3.6 in a TEE, 15 Nov 2026) and its signature, fetched from /v1/signature.
const reply = readFileSync(new URL("./near-ai-reply.json", import.meta.url), "utf8");
const real: NearAiProof = {
  seat: 1,
  agent_id: "nomad-b",
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  chat_id: "bb788370cc354bbea59543f8aef836f0",
  response: reply,
  signature_text: "Qwen/Qwen3.6-35B-A3B-FP8:7466b8c38f99c7efe0872f469fb73c476df2482b9db6aa971fc2d5334cb7c27a:49a0f5a22be6b0249f11e81cc72293d0587dc775cd7f14fa66eb666c7cd4f35e",
  signature: "0xa84542cb7518545aa87ec7d19fc467accd285d40f85a8dc37f3592efd3d2130044a0dae04331e4a6c466d9e1f385238768fb350f72be3d0121a78c33b14ce6a81b",
  signing_address: "0xfdbd7952498b333206f360d71d97a1e0961e8ddf",
  profile: { fold_below: 35, raise_above: 58, aggression: 55, bluff_chance: 3, raise_size: 60, position_weight: 0 },
};

test("a real NEAR AI signature verifies, and any change to it does not", () => {
  assert.equal(recoverSigner(real.signature_text, real.signature), real.signing_address);
  assert.deepEqual(profileFromResponse(reply).aggression, 55);
  const ok = verifyNearAiProof(real, [real.signing_address]);
  assert.ok(ok.ok, JSON.stringify(ok.checks));
  const bad = (p: Partial<NearAiProof>, signers: string[] | null = null) => verifyNearAiProof({ ...real, ...p }, signers).checks.filter((c) => !c.ok).map((c) => c.what);
  assert.deepEqual(bad({ response: reply.replace('\\"aggression\\":55', '\\"aggression\\":95') }), ["signed text names this reply", "reply says exactly the profile played"]);
  assert.deepEqual(bad({ profile: { ...real.profile, aggression: 95 } }), ["reply says exactly the profile played"]);
  assert.deepEqual(bad({ signing_address: "0x" + "11".repeat(20) }), ["signature recovers to the model's signing address"]);
  assert.deepEqual(bad({}, ["0x" + "22".repeat(20)]), ["signing address is attested on this table"]);
  assert.deepEqual(bad({ model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }), ["signed text names this model"]);
});

test("replies are read the way the contract reads them", () => {
  const r = (content: string) => JSON.stringify({ id: "x", choices: [{ message: { content } }] });
  assert.deepEqual(profileFromResponse(r("```json\n{\"fold_below\":0.3,\"raise_above\":0.6,\"aggression\":0.5,\"bluff_chance\":0.02,\"raise_size\":0.8}\n```")).raise_size, 80);
  const p = profileFromResponse(r('{"fold_below":99,"raise_above":5,"aggression":50,"bluff_chance":90,"raise_size":500}'));
  assert.deepEqual([p.fold_below, p.raise_above, p.aggression, p.bluff_chance, p.raise_size], [55, 45, 50, 25, 120]);
  assert.throws(() => profileFromResponse(JSON.stringify({ choices: [{ message: { content: "{}", reasoning_content: "the owner said" } }] })), /reasoning/);
});
