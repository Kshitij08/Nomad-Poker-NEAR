// Calls the backend's ONCHAIN Quick Play route (/quickplay/onchain) as a throwaway wallet, twice at the same stake:
// the first finds or hosts a table, the second should get the same one (no second table hosted).
// Usage: npx tsx scripts/probe-quickplay.ts <backendUrl> [stakeLevel]
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

const [url, level = "0"] = process.argv.slice(2);
const wallet = Keypair.generate(), key = Keypair.generate();
const expires = Math.floor(Date.now() / 1000) + 3600;
const keyMsg = Buffer.from(`Nomad Poker private tables
Allow play key ${key.publicKey.toBase58()} to use my game balance until ${expires} (unix time). It can buy in to tables (where chips can be lost), leave them, and send money only back to this wallet.`, "utf8");
const walletSig = Buffer.from(nacl.sign.detached(keyMsg, wallet.secretKey)).toString("base64");

async function call(path: string, body: object) {
  const ts = Math.floor(Date.now() / 1000), data = JSON.stringify(body);
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(`nomad-agent|${path}|${ts}|${data}`, "utf8"), key.secretKey)).toString("base64");
  const res = await fetch(url.replace(/\/$/, "") + path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), playKey: key.publicKey.toBase58(), expires, keySet: 0, walletSig, ts, data, sig }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const t0 = Date.now();
  const a = await call("/quickplay/onchain", { stake: Number(level) });
  console.log("first ", a.status, JSON.stringify(a.body), `${Date.now() - t0} ms`);
  const b = await call("/quickplay/onchain", { stake: Number(level) });
  console.log("second", b.status, JSON.stringify(b.body));
  console.log(a.body.table && a.body.table === b.body.table ? "same table: ok" : "DIFFERENT or missing table");
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
