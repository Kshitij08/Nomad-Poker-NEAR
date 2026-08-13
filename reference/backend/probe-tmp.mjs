import { Connection, PublicKey } from "@solana/web3.js";

const RPC = "https://rpc.magicblock.app/devnet/";
const PID = new PublicKey("GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo");
const ids = ["x2c-739fb29f627b4c5e8d3abbea", "x2c-332ddf7664014f538d6873a7"];
const c = new Connection(RPC, "confirmed");

const idBuf = (s) => { const b = Buffer.alloc(32); b.write(s); return b; };

for (const id of ids) {
  const buf = idBuf(id);
  const [tablePda] = PublicKey.findProgramAddressSync([Buffer.from("table"), buf], PID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), buf], PID);
  const info = await c.getAccountInfo(tablePda);
  if (!info) { console.log(`${id}: table account gone (closed/swept)\n`); continue; }
  const d = info.data;
  const table = {
    chipsInPlay: d.readBigUInt64LE(132),
    roundNonce: d.readBigUInt64LE(140),
    roundActive: d[148] === 1,
    lastSettlementTs: d.readBigInt64LE(149),
    pendingChipsInPlay: d.readBigUInt64LE(157),
    seatedCount: d[131],
  };
  const vaultLamports = (await c.getAccountInfo(vaultPda))?.lamports ?? 0;
  console.log(id, { ...table, vaultLamports });

  // seats for this table
  const seats = await c.getProgramAccounts(PID, {
    filters: [{ memcmp: { offset: 8, bytes: tablePda.toBase58() } }],
  });
  for (const { pubkey, account } of seats) {
    const s = account.data;
    // 8 disc | table 32 | player 32 | chips 8 | deposited 8 | rake 8 | status 1 | last_active 8 | pending 8 | bump 1
    console.log("   seat", new PublicKey(s.subarray(40, 72)).toBase58(),
      "chips", s.readBigUInt64LE(72),
      "pending", s.readBigUInt64LE(105),
      "pda", pubkey.toBase58());
  }
  console.log();
}
