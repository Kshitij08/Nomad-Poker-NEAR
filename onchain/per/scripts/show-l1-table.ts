// What Solana itself holds for a table (its last commit from the rollup). Usage: npx tsx scripts/show-l1-table.ts <table>
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import idl from "../idl/poker_per.json";

async function main() {
  const l1 = new Connection("https://api.devnet.solana.com", "confirmed");
  const coder = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(l1, new anchor.Wallet(anchor.web3.Keypair.generate()), {})).coder.accounts as any;
  const key = new PublicKey(process.argv[2]);
  const info = await l1.getAccountInfo(key);
  if (!info) { console.log("not on Solana"); return; }
  const t = coder.decode("table", info.data);
  const sigs = await l1.getSignaturesForAddress(key, { limit: 5 });
  console.log({
    owner: info.owner.toBase58(), handNo: t.handNo.toString(), lastCommit: new Date(Number(t.lastCommitTs) * 1000).toISOString(),
    lastRecordHand: t.lastRecord.handNo.toString(), lastRecordDealtMask: t.lastRecord.dealtMask,
    recentSolanaTxs: sigs.map((s) => `${s.signature} ${new Date((s.blockTime ?? 0) * 1000).toISOString()}`),
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
