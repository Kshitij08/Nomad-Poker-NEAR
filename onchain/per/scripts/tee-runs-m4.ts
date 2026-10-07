// Which program version does the TEE rollup execute? Simulates commit_seed (new in M4) against a
// table that doesn't exist: the M4 program answers AccountNotInitialized (3012), an older one
// InstructionFallbackNotFound (101). Simulation only; nothing is sent.
// Usage: npx tsx scripts/tee-runs-m4.ts [repeat every N seconds, for M minutes]
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadKey, programOn, teeConnection, PROGRAM_ID } from "./lib";

async function probe() {
  const deployer = loadKey("deployer");
  const er = await teeConnection(deployer);
  const prog = programOn(er, deployer);
  const table = Keypair.generate().publicKey;
  const pda = (s: string, ...k: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(s), ...k], PROGRAM_ID)[0];
  const tx = await prog.methods.commitSeed(0, Array(32).fill(0))
    .accountsPartial({ player: deployer.publicKey, table, deck: pda("deck", table.toBuffer()), hand: pda("hand", table.toBuffer(), Buffer.from([0])) }).transaction();
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  tx.sign(deployer);
  const sim = await er.simulateTransaction(tx);
  const code = (sim.value.err as any)?.InstructionError?.[1]?.Custom;
  return { at: new Date().toISOString(), code, runs: code === 3012 ? "M4" : code === 101 ? "older (no commit_seed)" : JSON.stringify(sim.value.err) };
}

async function main() {
  const every = Number(process.argv[2] ?? 0), minutes = Number(process.argv[3] ?? 0);
  const end = Date.now() + minutes * 60_000;
  do {
    const r = await probe();
    console.log(JSON.stringify(r));
    if (r.code === 3012 || !every) break;
    await new Promise((res) => setTimeout(res, every * 1000));
  } while (Date.now() < end);
}
main().catch((e) => { console.error(e); process.exit(1); });
