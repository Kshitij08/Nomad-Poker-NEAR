// What can be checked from outside after a play session: each wallet's devnet SOL and wSOL account,
// and the table's public state (seats taken, hands, money moves).
// Stacks and rollup balances are private by design: only the seat's own key (the game) and the
// wallet's own login (rollup-wallet page) can read them.
//   npx tsx scripts/m8-check-balances.ts <table> <wallet> [<wallet>...]
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import fs from "fs";
import { connection, loadKey, programOn, teeConnection } from "./lib";
import { tokenOf } from "../tests/helpers";

const [tableArg, ...wallets] = process.argv.slice(2);

(async () => {
  const deployer = loadKey("deployer");
  const tee = await teeConnection(deployer);
  const prog = programOn(tee, deployer);
  const table = new PublicKey(tableArg);
  const t: any = await (prog.account as any).table.fetch(table);
  const sol = (n: number | bigint) => Number(n) / LAMPORTS_PER_SOL;
  const out: any = {
    table: {
      address: table.toBase58(), handNo: t.handNo.toString(), handState: t.handState,
      seatsTaken: [...Array(t.maxSeats).keys()].filter((i) => (t.seatMask >> i) & 1),
      moneyMoves: t.ledgerSeq.toString(), ledgerHash: Buffer.from(t.ledgerHash).toString("hex"),
    },
    wallets: [] as any[],
  };
  for (const w of wallets) {
    const k = new PublicKey(w), ata = tokenOf(k);
    const l1Ata = await connection.getAccountInfo(ata);
    const teeAta = await tee.getTokenAccountBalance(ata).then((b) => b.value.uiAmountString, (e) => `unreadable: ${String(e.message ?? e).slice(0, 80)}`);
    out.wallets.push({
      wallet: w,
      devnetSol: sol(await connection.getBalance(k)),
      wsolAccount: ata.toBase58(),
      wsolOnDevnet: l1Ata ? (await connection.getTokenAccountBalance(ata)).value.uiAmountString : "no account",
      rollupBalanceSeenByAnotherLogin: teeAta,
    });
  }
  fs.writeFileSync(`results/m8-balances-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
