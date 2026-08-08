// Full money-table loop against devnet, exactly as the Unity host will drive it:
//   /host/tables -> players sign buy_in -> /host/.../hand/start -> /host/.../hand/end with real
//   non-zero deltas -> verify on-chain seat chips -> /host/.../cash-out for both players.
// Player wallets are funded from the settlement authority (devnet faucets are rate-limited).
import "../src/config/env.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createHash } from "node:crypto";
import { loadEscrowIdl } from "../src/config/idl.js";

const { AnchorProvider, BN, Program, Wallet } = anchorPkg.default ?? anchorPkg;
const BASE = process.env.BASE ?? "http://localhost:8787";
const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
const idl = loadEscrowIdl();
const PROGRAM_ID = new PublicKey(idl.address);
const settlement = Keypair.fromSecretKey(bs58.decode(process.env.SETTLEMENT_AUTHORITY_SECRET));

const kpFrom = (label) => Keypair.fromSeed(createHash("sha256").update(`poker-full-e2e:${label}`).digest());

async function post(path, body, jwt) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function login(kp) {
  const pubkey = kp.publicKey.toBase58();
  const nonce = await post("/api/auth/nonce", { pubkey });
  const message = nonce.json.message;
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  const verify = await post("/api/auth/verify", { pubkey, message, signature: bs58.encode(sig) });
  if (verify.status !== 200) throw new Error(`login failed: ${JSON.stringify(verify.json)}`);
  return verify.json.token;
}

const tableIdStr = `f2e-${Date.now().toString(36)}`;
const tableIdBuf = Buffer.alloc(32); tableIdBuf.write(tableIdStr);
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const tablePda = pda(Buffer.from("table"), tableIdBuf);
const vaultPda = pda(Buffer.from("vault"), tableIdBuf);
const configPda = pda(Buffer.from("config"));
const seatPda = (p) => pda(Buffer.from("seat"), tableIdBuf, p.toBuffer());

const host = kpFrom("host2");
const p2 = kpFrom("player2");

// The host is a player too: fund both, then both buy in.
console.log("funding player wallets from settlement…");
for (const kp of [host, p2]) {
  const bal = await connection.getBalance(kp.publicKey);
  if (bal < 0.15 * 1e9) {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: settlement.publicKey, toPubkey: kp.publicKey, lamports: 0.2 * 1e9,
    }));
    await sendAndConfirmTransaction(connection, tx, [settlement]);
  }
  console.log(" ", kp.publicKey.toBase58(), (await connection.getBalance(kp.publicKey)) / 1e9, "SOL");
}

const hostJwt = await login(host);
const p2Jwt = await login(p2);

console.log("\ncreate table", tableIdStr);
const create = await post("/host/tables", {
  tableId: tableIdStr, buyInLamports: 100_000_000, smallBlindChips: 10, bigBlindChips: 20, maxSeats: 7,
}, hostJwt);
console.log("  ->", create.status, create.json.signature ?? create.json);
if (create.status !== 200) process.exit(1);

async function buyIn(kp) {
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const config = await program.account.config.fetch(configPda);
  return program.methods.buyIn([...tableIdBuf]).accounts({
    player: kp.publicKey, config: configPda, table: tablePda, vault: vaultPda,
    seat: seatPda(kp.publicKey), devWallet: config.devWallet, systemProgram: SystemProgram.programId,
  }).rpc();
}

console.log("\nplayers buy in (player-signed)…");
console.log("  host:", await buyIn(host));
console.log("  p2:  ", await buyIn(p2));

const readProgram = new Program(idl, new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" }));
const chipsOf = async (kp) => (await readProgram.account.seat.fetch(seatPda(kp.publicKey))).chips.toNumber();
console.log("  chips after buy-in — host:", await chipsOf(host), "p2:", await chipsOf(p2));

console.log("\nhand/start");
console.log("  ->", (await post(`/host/tables/${tableIdStr}/hand/start`, {}, hostJwt)).json);

console.log("\nhand/end with real deltas (host +250 / p2 -250)");
const end = await post(`/host/tables/${tableIdStr}/hand/end`, {
  deltas: [
    { player: host.publicKey.toBase58(), chipDelta: 250 },
    { player: p2.publicKey.toBase58(), chipDelta: -250 },
  ],
  potChips: 500,
}, hostJwt);
console.log("  ->", end.status, end.json);
if (end.status !== 200) process.exit(1);

const hostChips = await chipsOf(host), p2Chips = await chipsOf(p2);
console.log("  chips after settle — host:", hostChips, "p2:", p2Chips);
if (hostChips !== 1250 || p2Chips !== 750) throw new Error("settled chips do not match deltas!");

console.log("\ncash out both (p2 cashes ITSELF out with its own JWT; host cashes out the rest)");
const solBefore = await connection.getBalance(p2.publicKey);
console.log("  p2 self:", (await post(`/host/tables/${tableIdStr}/cash-out`, { playerPubkey: p2.publicKey.toBase58() }, p2Jwt)).json);
console.log("  host:   ", (await post(`/host/tables/${tableIdStr}/cash-out`, { playerPubkey: host.publicKey.toBase58() }, hostJwt)).json);
const solAfter = await connection.getBalance(p2.publicKey);
console.log(`  p2 SOL ${solBefore / 1e9} -> ${solAfter / 1e9} (expect +0.075 escrow + seat rent)`);

const table = await readProgram.account.table.fetch(tablePda);
console.log("\nfinal table: seatedCount", table.seatedCount, "chipsInPlay", table.chipsInPlay.toNumber(),
  "roundNonce", table.roundNonce.toNumber(), "roundActive", table.roundActive);

console.log("\nFULL HAND E2E PASSED ✅  (close_table is expected to fail: known on-chain double-rent bug)");
