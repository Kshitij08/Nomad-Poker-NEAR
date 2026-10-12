// Lists the backend's lobby tables with their on-chain state (public data). Usage: npx tsx scripts/list-tables.ts
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import idl from "../idl/poker_per.json";

async function main() {
  const conn = new Connection("https://devnet-tee.magicblock.app", "confirmed");
  const coder = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(conn, new anchor.Wallet(anchor.web3.Keypair.generate()), {})).coder.accounts as any;
  const list = await (await fetch("https://poker-per-api-production.up.railway.app/tables")).json();
  const now = Math.floor(Date.now() / 1000);
  for (const row of list) {
    const info = await conn.getAccountInfo(new PublicKey(row.address));
    if (!info) { console.log(row.address.slice(0, 8), "not in rollup"); continue; }
    const t = coder.decode("table", info.data);
    const h = (s: number) => (s / 3600).toFixed(1) + " h";
    console.log([row.address, t.creator.toBase58().slice(0, 6), `seats ${t.seatMask.toString(2).split("").filter((c: string) => c === "1").length}/${t.maxSeats}`,
      `hand ${t.handNo}`, `started ${Number(t.startRequestedFor) !== 0}`, `idle ${h(now - Number(t.idleSince))}`, `activity ${h(now - Number(t.lastActivityTs))} ago`].join("  "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
