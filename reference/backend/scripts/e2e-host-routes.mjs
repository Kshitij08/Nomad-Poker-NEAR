// Throwaway E2E for the /host/* routes against a locally running backend (devnet).
// Flow: SIWS login -> create table -> hand/start (x2, idempotent) -> hand/end (empty deltas)
//       -> non-host 403 -> close table.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createHash } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8787";

function keypairFrom(label) {
  const seed = createHash("sha256").update(`poker-host-e2e:${label}`).digest();
  return nacl.sign.keyPair.fromSeed(seed);
}

async function post(path, body, jwt) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function login(kp) {
  const pubkey = bs58.encode(kp.publicKey);
  const nonce = await post("/api/auth/nonce", { pubkey });
  if (nonce.status !== 200) throw new Error(`nonce failed: ${JSON.stringify(nonce.json)}`);
  const message = nonce.json.message;
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  const verify = await post("/api/auth/verify", { pubkey, message, signature: bs58.encode(sig) });
  if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.json)}`);
  return { pubkey, jwt: verify.json.token };
}

const host = await login(keypairFrom("host"));
console.log("host logged in:", host.pubkey);

const intro = await post("/api/auth/introspect", { token: host.jwt });
console.log("introspect:", intro.status, intro.json);
if (intro.json.pubkey !== host.pubkey) throw new Error("introspect pubkey mismatch");

const tableId = `e2e-${Date.now().toString(36)}`;
console.log("creating table", tableId, "…");
const create = await post("/host/tables", {
  tableId, buyInLamports: 100_000_000, smallBlindChips: 10, bigBlindChips: 20, maxSeats: 7,
}, host.jwt);
console.log("create:", create.status, create.json);
if (create.status !== 200) throw new Error("create_table failed");

const start1 = await post(`/host/tables/${tableId}/hand/start`, {}, host.jwt);
console.log("hand/start #1:", start1.status, start1.json);
if (start1.status !== 200 || start1.json.alreadyActive) throw new Error("hand/start failed");

const start2 = await post(`/host/tables/${tableId}/hand/start`, {}, host.jwt);
console.log("hand/start #2 (idempotent):", start2.status, start2.json);
if (!start2.json.alreadyActive) throw new Error("expected alreadyActive on second start");

const end = await post(`/host/tables/${tableId}/hand/end`, { deltas: [], potChips: 0 }, host.jwt);
console.log("hand/end (empty deltas):", end.status, end.json);
if (end.status !== 200) throw new Error("hand/end failed");

const stranger = await login(keypairFrom("stranger"));
const forbidden = await post(`/host/tables/${tableId}/hand/start`, {}, stranger.jwt);
console.log("non-host hand/start:", forbidden.status, forbidden.json);
if (forbidden.status !== 403) throw new Error("expected 403 for non-host");

// close_table recovers table + vault PDA rent once seated_count and pending deposits are zero.
const close = await post(`/host/tables/${tableId}/close`, {}, host.jwt);
if (close.status === 200) {
  console.log("close:", close.status, close.json);
} else {
  console.log("close:", close.status, close.json);
  throw new Error("close_table failed");
}

console.log("\nE2E PASSED ✅");
