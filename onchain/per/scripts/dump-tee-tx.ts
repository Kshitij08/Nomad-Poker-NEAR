// Dumps a table's transactions as the TEE RPC returns them with no login: per instruction, the
// program and the first bytes of its data. Usage: npx tsx scripts/dump-tee-tx.ts <table> [login: p1|none]
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadKey, teeConnection, TEE_URL } from "./lib";
import { connUrl } from "../tests/helpers";

async function main() {
  const table = new PublicKey(process.argv[2]);
  const url = process.argv[3] === "p1" ? connUrl(await teeConnection(loadKey("p1"))) : process.argv[3] === "deployer" ? connUrl(await teeConnection(loadKey("deployer"))) : TEE_URL;
  const rpc = async (method: string, params: any[]) => (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
  const sigs = (await rpc("getSignaturesForAddress", [table.toBase58(), { limit: 100 }])).result ?? [];
  for (const s of sigs.reverse()) {
    const tx = (await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }])).result;
    const msg = tx?.transaction?.message;
    if (!msg) { console.log(s.signature.slice(0, 10), "no tx"); continue; }
    const ixs = (msg.instructions ?? []).map((ix: any) => {
      const d = Buffer.from(bs58.decode(ix.data));
      return `${String(msg.accountKeys[ix.programIdIndex]).slice(0, 6)}:${d.length}B:${d.subarray(0, 12).toString("hex")}`;
    });
    console.log(s.signature.slice(0, 10), `keys=${msg.accountKeys.length}`, ixs.join(" | "), `logs=${tx.meta?.logMessages?.length ?? "-"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
