// What do different logins get back for a table's transactions in the TEE? Lists the table's
// signatures (it's public) and, for the VRF fulfillment and a commit_seed, shows what each login
// receives: found or not, instruction data lengths, and whether a given byte string appears.
// Usage: npx tsx scripts/probe-tx-visibility.ts <table> [hex to look for]
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { loadKey, teeConnection, TEE_URL } from "./lib";
import { connUrl, readerFor } from "../tests/helpers";

const VRF = "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz";
const rpc = async (url: string, method: string, params: any[]) => (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8).toString("hex");

async function main() {
  const table = new PublicKey(process.argv[2]);
  const needle = process.argv[3] ? Buffer.from(process.argv[3], "hex") : null;
  const p1 = loadKey("p1"), p3 = loadKey("p3"), deployer = loadKey("deployer");
  const logins: Record<string, string> = {
    deployer: connUrl(await teeConnection(deployer)), p1Wallet: connUrl(await teeConnection(p1)), outsider: connUrl(await teeConnection(p3)), noLogin: TEE_URL,
  };
  const sigs = (await rpc(logins.deployer, "getSignaturesForAddress", [table.toBase58(), { limit: 100 }])).result ?? [];
  console.log("signatures for the table (deployer login):", sigs.length);
  const kinds: Record<string, string> = { [disc("commit_seed")]: "commit_seed", [disc("deal")]: "deal", [disc("start_hand")]: "start_hand" };
  const shown = new Set<string>();
  for (const s of sigs) {
    const full = await rpc(logins.deployer, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
    const msg = full.result?.transaction?.message;
    if (!msg) continue;
    const keys: string[] = msg.accountKeys;
    const isVrf = keys.includes(VRF) && !keys.includes(deployer.publicKey.toBase58()) && !keys.includes(p1.publicKey.toBase58());
    const kind = isVrf ? "vrf-fulfillment" : (msg.instructions ?? []).map((i: any) => kinds[Buffer.from(require("bs58").decode(i.data)).subarray(0, 8).toString("hex")]).find(Boolean);
    if (!kind || shown.has(kind)) continue;
    shown.add(kind);
    const out: any = { kind, sig: s.signature.slice(0, 12) };
    for (const [who, url] of Object.entries(logins)) {
      const r = await rpc(url, "getTransaction", [s.signature, { encoding: "base64", maxSupportedTransactionVersion: 0 }]);
      const raw = r.result?.transaction?.[0] ? Buffer.from(r.result.transaction[0], "base64") : null;
      out[who] = r.result ? { bytes: raw?.length, nonZeroBytes: raw ? raw.filter((b) => b !== 0).length : 0, logs: r.result.meta?.logMessages?.length ?? 0, needle: needle ? !!raw?.includes(needle) : undefined } : "not found";
    }
    console.log(JSON.stringify(out));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
