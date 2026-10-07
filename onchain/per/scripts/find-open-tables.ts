// Lists every poker-per table currently inside the TEE rollup that isn't CLOSED, with its escrow
// balance and its ledger's size (via the deployer's login, then leak 2 as a fallback) so tables
// left on an old ledger layout can be found before an upgrade changes it.
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { loadKey, programFor, teeConnection, TEE_URL, PROGRAM_ID } from "./lib";

const rpc = async (method: string, params: any[]) => (await fetch(TEE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as Promise<any>;
async function sizeViaSimulate(acct: PublicKey): Promise<number> {
  const s = Keypair.generate();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: s.publicKey, toPubkey: s.publicKey, lamports: 0 }));
  tx.feePayer = s.publicKey; tx.recentBlockhash = (await rpc("getLatestBlockhash", [])).result.value.blockhash;
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const sim = await rpc("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [acct.toBase58()] } }]);
  const a = sim.result?.value?.accounts?.[0];
  return a ? Buffer.from(a.data[0], "base64").length : -1;
}

async function main() {
  const deployer = loadKey("deployer");
  const er = await teeConnection(deployer);
  const coder = programFor(deployer).coder.accounts as any;
  const disc = coder.memcmp("table");
  const accts = await er.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: disc.bytes } }] });
  console.log(`tables in the rollup: ${accts.length}`);
  for (const { pubkey, account } of accts) {
    let t: any;
    try { t = coder.decode("table", account.data); } catch {
      // A pre-M3 table (old layout): report only whether its escrow still holds anything.
      let b = "none";
      try { b = (await er.getTokenAccountBalance(getAssociatedTokenAddressSync(NATIVE_MINT, pubkey, true))).value.amount; } catch { /* no escrow */ }
      console.log(JSON.stringify({ table: pubkey.toBase58(), layout: `pre-M3 (${account.data.length} B)`, escrow: b }));
      continue;
    }
    if (t.status === 2) continue;
    const ledger = PublicKey.findProgramAddressSync([Buffer.from("ledger"), pubkey.toBuffer()], PROGRAM_ID)[0];
    const escrow = getAssociatedTokenAddressSync(NATIVE_MINT, pubkey, true);
    let bal = "?";
    try { bal = (await er.getTokenAccountBalance(escrow)).value.amount; } catch { bal = "none"; }
    console.log(JSON.stringify({ table: pubkey.toBase58(), status: t.status, version: t.version, seatMask: t.seatMask, escrow: bal, ledgerBytes: await sizeViaSimulate(ledger) }));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
