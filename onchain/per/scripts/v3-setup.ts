// One-time setup of the new internal test program (4A3DZW5z…, the repo IDL's id) after it's deployed: its config, the
// Agent sponsor, the fees (copy shares and table hosting), and the test keeper. Never touches the live program
// (7q2vxh2…): it refuses to run against it. Prints the plan only, unless run with --go (each step is skipped when done).
//   npx tsx scripts/v3-setup.ts          (plan, balances, nothing sent)
//   npx tsx scripts/v3-setup.ts --go     (does it; needs the user's OK)
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { CONFIG_PDA, PROGRAM_ID, connection, loadKey, programFor } from "./lib";
import { sendL1 } from "../tests/helpers";
import { openVaultAccounts } from "../client-web/vault";

const LIVE = "7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];

/** The test infrastructure's settings. */
const SETTINGS = {
  rakeBps: 500,
  maxBuyIn: 1_000_000_000n,       // 1 SOL, as the live program
  sponsorLamports: 50_000_000n,   // pays Agent records' and host tabs' rent in the rollup (about 0.00001 SOL each)
  platformFeeBps: 200,            // Nomad's share of copiers' new profit
  creatorFeeBps: 800,             // every creator's share
  maxHostFee: 0n,                 // hosting fees off: Quick Play stays free on devnet (the user's call, 17 Oct)
  keeperSol: 1.5,                 // tables cost the keeper 0.030 SOL each until reclaimed (0.013 back); plus commits
};

async function main() {
  const go = process.argv.includes("--go");
  if (PROGRAM_ID.toBase58() === LIVE) throw new Error("the repo's IDL names the live program: this script is for the new test program only");
  const deployer = loadKey("deployer"), keeper = loadKey("v3-keeper"), auditor = loadKey("v3-auditor");
  const l1 = programFor(deployer);
  const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0];
  const deployed = !!(await connection.getAccountInfo(PROGRAM_ID));
  const config: any = await (l1.account as any).config.fetchNullable(CONFIG_PDA);
  const sponsor = pda(Buffer.from("agent-sponsor"));
  const sponsorInfo = await connection.getAccountInfo(sponsor);
  const keeperVault = await connection.getAccountInfo(openVaultAccounts(keeper.publicKey).vaultEata);
  const deployerVault = await connection.getAccountInfo(openVaultAccounts(deployer.publicKey).vaultEata);
  const keeperSol = (await connection.getBalance(keeper.publicKey)) / LAMPORTS_PER_SOL;
  const state = {
    program: PROGRAM_ID.toBase58(), deployed, deployer: deployer.publicKey.toBase58(), deployerSol: (await connection.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL,
    keeper: keeper.publicKey.toBase58(), keeperSol, auditor: auditor.publicKey.toBase58(),
    config: config ? { admin: config.admin.toBase58(), devWallet: config.devWallet.toBase58(), auditor: config.auditor.toBase58(), hostWallet: config.hostWallet.toBase58(), maxHostFee: config.maxHostFee.toString() } : null,
    sponsor: sponsorInfo ? `exists (owner ${sponsorInfo.owner.toBase58().slice(0, 6)}…)` : "missing",
    keeperVault: keeperVault ? "open" : "not open", treasuryVault: deployerVault ? "open" : "not open",
  };
  console.log(JSON.stringify(state, null, 2));
  const steps: [string, boolean, () => Promise<unknown>][] = [
    ["initialize_config (deployer = upgrade authority = admin; dev_wallet = deployer)", !config, () => l1.methods.initializeConfig({
      devWallet: deployer.publicKey, rakeBps: SETTINGS.rakeBps, maxBuyIn: new anchor.BN(SETTINGS.maxBuyIn.toString()), paused: false, escapeIdleSecs: 0,
    }).accountsPartial({ authority: deployer.publicKey, config: CONFIG_PDA, program: PROGRAM_ID, programData }).rpc()],
    ["set_auditor (v3-auditor)", !config || !config.auditor.equals(auditor.publicKey), () => l1.methods.setAuditor(auditor.publicKey).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc()],
    ["set_fees (2% Nomad, 8% creator, hosting fees off)", !config || config.agentFeeBps !== SETTINGS.platformFeeBps || config.creatorFeeBps !== SETTINGS.creatorFeeBps, () => l1.methods.setFees({
      platformFeeBps: SETTINGS.platformFeeBps, creatorFeeBps: SETTINGS.creatorFeeBps, hostWallet: PublicKey.default, maxHostFee: new anchor.BN(SETTINGS.maxHostFee.toString()),
    }).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA }).rpc()],
    ["create + delegate the Agent sponsor (0.05 SOL)", !sponsorInfo, async () => {
      await l1.methods.createAgentSponsor(new anchor.BN(SETTINGS.sponsorLamports.toString())).accountsPartial({ admin: deployer.publicKey, config: CONFIG_PDA, sponsor }).rpc();
      const dlp = (tag: string) => PublicKey.findProgramAddressSync([Buffer.from(tag), sponsor.toBuffer()], DLP)[0];
      return l1.methods.delegateAgentSponsor().accountsPartial({
        admin: deployer.publicKey, config: CONFIG_PDA, sponsor, validator: TEE_VALIDATOR, bufferSponsor: PublicKey.findProgramAddressSync([Buffer.from("buffer"), sponsor.toBuffer()], PROGRAM_ID)[0],
        delegationRecordSponsor: dlp("delegation"), delegationMetadataSponsor: dlp("delegation-metadata"),
      } as any).rpc();
    }],
    [`fund the v3 keeper to ${SETTINGS.keeperSol} SOL`, keeperSol < SETTINGS.keeperSol - 0.01, () => sendL1(new Transaction().add(SystemProgram.transfer({
      fromPubkey: deployer.publicKey, toPubkey: keeper.publicKey, lamports: Math.round((SETTINGS.keeperSol - keeperSol) * LAMPORTS_PER_SOL) })), [deployer])],
    ["open the keeper's game balance (it would receive hosting fees, if they're ever turned on)", !keeperVault, async () => sendL1(new Transaction().add(
      await programFor(keeper).methods.openVault().accountsPartial(openVaultAccounts(keeper.publicKey)).instruction()), [keeper])],
    ["open the treasury's game balance (dev_wallet = deployer: receives Nomad's copy share)", !deployerVault, async () => sendL1(new Transaction().add(
      await programFor(deployer).methods.openVault().accountsPartial(openVaultAccounts(deployer.publicKey)).instruction()), [deployer])],
  ];
  if (!deployed) { console.log("\nthe program isn't deployed yet: deploy it first (per/ops/deploy-new-program.sh)"); if (go) return; }
  for (const [name, todo, run] of steps) {
    if (!todo) { console.log(`done already: ${name}`); continue; }
    if (!go) { console.log(`to do: ${name}`); continue; }
    console.log(`doing: ${name}`);
    console.log("  ", await run());
  }
  if (!go) console.log("\nnothing sent (plan only). Run with --go to do it.");
}
main().catch((e) => { console.error(e); process.exit(1); });
