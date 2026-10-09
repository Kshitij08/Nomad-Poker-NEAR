// A table's money moves as the TEE shows them: every buy_in / cash_out (and anything else that touched
// the table) with its time, signers, decoded arguments, result and the program's own log lines.
//   npx tsx scripts/table-money-history.ts <table> [limit]
import { PublicKey } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import bs58 from "bs58";
import fs from "fs";
import { idl, loadKey, PROGRAM_ID, teeConnection } from "./lib";
import { connUrl } from "../tests/helpers";

(async () => {
  const table = new PublicKey(process.argv[2]);
  const limit = Number(process.argv[3] ?? 400);
  const url = connUrl(await teeConnection(loadKey("deployer")));
  const rpc = async (method: string, params: any[]) => (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
  const coder = new BorshInstructionCoder(idl);
  const sigs: any[] = [];
  let before: string | undefined;
  while (sigs.length < limit) {
    const page = (await rpc("getSignaturesForAddress", [table.toBase58(), { limit: 100, before }])).result ?? [];
    if (!page.length) break;
    sigs.push(...page); before = page[page.length - 1].signature;
  }
  const rows: any[] = [];
  for (const s of sigs.reverse()) {
    const tx = (await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }])).result;
    const msg = tx?.transaction?.message;
    if (!msg) { rows.push({ sig: s.signature, time: s.blockTime, note: "transaction not returned" }); continue; }
    const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
    for (const ix of msg.instructions) {
      if (msg.accountKeys[ix.programIdIndex] !== PROGRAM_ID.toBase58()) continue;
      const d = coder.decode(Buffer.from(bs58.decode(ix.data)));
      if (!d || !["buy_in", "cash_out", "buyIn", "cashOut", "close_table", "closeTable"].includes(d.name)) continue;
      rows.push({
        time: new Date((tx.blockTime ?? s.blockTime) * 1000).toISOString(), sig: s.signature, ix: d.name,
        args: JSON.parse(JSON.stringify(d.data)), signers, err: tx.meta?.err ?? null,
        logs: (tx.meta?.logMessages ?? []).filter((l: string) => l.startsWith("Program log:") && !l.includes("Instruction:")).slice(0, 6),
      });
    }
  }
  fs.writeFileSync(`results/money-history-${table.toBase58().slice(0, 4)}-${Date.now()}.json`, JSON.stringify(rows, null, 1));
  console.log(JSON.stringify(rows, null, 1));
  console.error(`${sigs.length} transactions scanned, ${rows.length} money moves`);
})().catch((e) => { console.error(e); process.exit(1); });
