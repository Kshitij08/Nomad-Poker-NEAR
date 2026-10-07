// Control for the "transaction contents hidden" probes: a TEE transaction that touches no private
// account (a memo carrying 32 random bytes) should be served in full to a no-login getTransaction.
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { loadKey, teeConnection, TEE_URL } from "./lib";

const MEMO = new PublicKey("MemoSq4gqABAXKFwFSyoZ8CprTPJyJJ5XrjqJhnwV2Q");

async function main() {
  const deployer = loadKey("deployer");
  const tee = await teeConnection(deployer);
  const secret = randomBytes(32).toString("hex");
  const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: deployer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(secret) }));
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(deployer);
  const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await tee.confirmTransaction(sig, "confirmed");
  for (let i = 0; i < 10; i++) {
    const r: any = await (await fetch(TEE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }) })).json();
    const raw = r.result?.transaction?.[0] ? Buffer.from(r.result.transaction[0], "base64") : null;
    if (r.result) { console.log(JSON.stringify({ sig, found: true, secretVisible: !!raw?.includes(Buffer.from(secret)) })); return; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(JSON.stringify({ sig, found: false }));
}
main().catch((e) => { console.error(e); process.exit(1); });
