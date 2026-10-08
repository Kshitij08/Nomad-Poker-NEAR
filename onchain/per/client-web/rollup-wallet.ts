// Devnet helper page for the M8 test build: move devnet SOL into and out of the TEE rollup with
// Phantom, so a player can buy in at a private table. In-game deposits are M9; this page only uses
// MagicBlock's SDK functions (the same ones per/scripts/topup.ts and the money suite use).
// Bundled to rollup-wallet.js next to rollup-wallet.html in the test deploy.
// Buffer comes from client-web/buffer-shim.ts (esbuild --inject), so it exists before any module runs.
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { delegateSpl, getAuthToken, withdrawSpl } from "@magicblock-labs/ephemeral-rollups-sdk";

const L1 = new Connection("https://api.devnet.solana.com", "confirmed");
const TEE = "https://devnet-tee.magicblock.app";
const VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const $ = (id: string) => document.getElementById(id)!;
const log = (s: string) => { $("log").textContent = s + "\n" + $("log").textContent; };
const phantom = () => (window as any).phantom?.solana ?? (window as any).solana;
let owner: PublicKey | null = null;

async function connect() {
  const p = phantom();
  if (!p?.isPhantom) { log("Phantom isn't installed in this browser."); return; }
  const r = await p.connect();
  owner = new PublicKey(r.publicKey.toString());
  $("who").textContent = owner.toBase58();
  log(`Connected ${owner.toBase58()}. Switch Phantom to devnet (Settings > Developer settings > Testnet mode).`);
  log(`Devnet SOL: ${((await L1.getBalance(owner)) / LAMPORTS_PER_SOL).toFixed(4)}`);
}

async function send(tx: Transaction) {
  tx.feePayer = owner!;
  tx.recentBlockhash = (await L1.getLatestBlockhash()).blockhash;
  const signed = await phantom().signTransaction(tx);
  const sig = await L1.sendRawTransaction(signed.serialize());
  await L1.confirmTransaction(sig, "confirmed");
  return sig;
}

async function deposit() {
  if (!owner) return log("Connect Phantom first.");
  const sol = Number(($("amount") as HTMLInputElement).value);
  const lamports = BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const ixs = await delegateSpl(owner, NATIVE_MINT, lamports, { validator: VALIDATOR, initVaultIfMissing: true, initAtasIfMissing: true, payer: owner });
  const sig = await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: Number(lamports) }), createSyncNativeInstruction(ata), ...ixs));
  log(`Deposited ${sol} SOL into the rollup: https://explorer.solana.com/tx/${sig}?cluster=devnet (takes a few seconds to show there)`);
}

/** The rollup shows a balance only to its owner, so this logs in (Phantom signs a message, no transaction). */
async function balance(): Promise<bigint> {
  if (!owner) { log("Connect Phantom first."); return 0n; }
  const { token } = await getAuthToken(TEE, owner, async (m: Uint8Array) => (await phantom().signMessage(m)).signature);
  const r = await new Connection(`${TEE}?token=${token}`, "confirmed").getTokenAccountBalance(getAssociatedTokenAddressSync(NATIVE_MINT, owner));
  log(`Rollup balance: ${Number(r.value.amount) / LAMPORTS_PER_SOL} SOL`);
  return BigInt(r.value.amount);
}

async function withdrawAll() {
  const amount = await balance();
  if (amount === 0n) return log("Nothing to withdraw.");
  const ixs = await withdrawSpl(owner!, NATIVE_MINT, amount, { validator: VALIDATOR, initAtasIfMissing: true, payer: owner! });
  const sig = await send(new Transaction().add(...ixs));
  log(`Withdrew ${Number(amount) / LAMPORTS_PER_SOL} SOL to your wallet: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

const guard = (f: () => Promise<unknown>) => () => f().catch((e) => log("Error: " + (e?.message ?? e)));
$("connect").onclick = guard(connect);
$("deposit").onclick = guard(deposit);
$("balance").onclick = guard(balance);
$("withdraw").onclick = guard(withdrawAll);
