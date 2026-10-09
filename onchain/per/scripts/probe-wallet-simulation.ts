// Why does Phantom say "Failed to simulate" on buy-in and cash-out? Phantom simulates every transaction
// it signs against Solana devnet itself, but these transactions run in the TEE rollup. Builds the same
// buy_in a player sends and simulates it on both, and shows who owns the table's accounts on each.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import { CONFIG_PDA, connection, loadKey, programFor, programOn, teeConnection } from "./lib";
import { BN, handOf, rollup, sendL1, tableApi, tokenOf } from "../tests/helpers";

const TABLE = process.argv[2] ?? "BPPXRXZw98sEyR4mxGwDWHvLLUjUW3U8ZAV15LFgR2bj";

(async () => {
  const rows: any[] = await (await fetch("https://poker-per-api-production.up.railway.app/tables")).json();
  const row = rows.find((r) => r.address === TABLE);
  if (!row) throw new Error("table not in the lobby");
  const player = Keypair.generate();
  // Funded on devnet like a real player, so the fee payer isn't what fails.
  await sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: loadKey("deployer").publicKey, toPubkey: player.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL })), [loadKey("deployer")]);
  // tableApi only needs the creator's public key for addresses.
  const T = tableApi({ publicKey: new PublicKey(row.creator) } as Keypair, BigInt(row.tableId));
  const hand = handOf(T.table, 5);
  const build = (prog: any): Promise<Transaction> => prog.methods.buyIn(5, BN(2_000_000n), Keypair.generate().publicKey).accountsPartial({
    player: player.publicKey, config: CONFIG_PDA, table: T.table, ledger: T.ledger, ledgerPermission: permissionPdaFromAccount(T.ledger),
    hand, handPermission: permissionPdaFromAccount(hand), invites: null, playerToken: tokenOf(player.publicKey), escrow: T.escrow, rollup,
  }).transaction();

  const tee = await teeConnection(player);
  const out: any = { table: TABLE, player: player.publicKey.toBase58() };
  for (const [name, conn, prog] of [["devnet (where Phantom simulates)", connection, programFor(player)], ["TEE rollup (where the game sends it)", tee, programOn(tee, player)]] as const) {
    const tx = await build(prog);
    tx.feePayer = player.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx).catch((e: any) => ({ value: { err: String(e?.message ?? e), logs: [] as string[] } }));
    const owner = async (k: PublicKey) => (await conn.getAccountInfo(k).catch(() => null))?.owner.toBase58() ?? "missing";
    out[name] = { err: sim.value.err, lastLogs: (sim.value.logs ?? []).slice(-4), tableOwner: await owner(T.table), escrowOwner: await owner(T.escrow) };
  }
  fs.writeFileSync(`results/wallet-simulation-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
