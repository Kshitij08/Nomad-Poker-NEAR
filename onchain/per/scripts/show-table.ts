// Shows a table's public state from the rollup. Usage: npx tsx scripts/show-table.ts <table address>
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import idl from "../idl/poker_per.json";

async function main() {
  const conn = new Connection("https://devnet-tee.magicblock.app", "confirmed");
  const coder = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(anchor.web3.Keypair.generate()), {})).coder.accounts as any;
  const t = coder.decode("table", (await conn.getAccountInfo(new PublicKey(process.argv[2])))!.data);
  const now = Math.floor(Date.now() / 1000);
  console.log({
    status: t.status, kind: t.kind, maxSeats: t.maxSeats, seatMask: t.seatMask.toString(2), handNo: t.handNo.toString(), handState: t.handState,
    startRequestedFor: t.startRequestedFor.toString(), idleFor: now - Number(t.idleSince), dealtMask: t.dealtMask.toString(2), creator: t.creator.toBase58(),
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
