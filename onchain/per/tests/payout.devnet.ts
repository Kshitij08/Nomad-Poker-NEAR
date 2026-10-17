// vault_payout_to_owner on devnet (L1): the backend's keeper finishes a withdrawal without the wallet's signature. The
// SOL at a wallet's vault PDA (where MagicBlock's shuttle lands a withdrawal) can only go to that wallet: the keeper
// signs and pays the fee, and can't name any other destination. The landed SOL is simulated with a plain transfer to the
// vault PDA (what the shuttle does); the real exit is covered by the vault suite. Also: a real withdrawal end to end
// (vault_exit, then the keeper pays out). Writes results/payout-<ts>.json.   Run: npx tsx tests/payout.devnet.ts
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { connection, loadKey, programFor } from "../scripts/lib";
import { BN, Suite, sendL1, sleep } from "./helpers";
import { depositToVaultIxs, openVaultAccounts, vaultExitAccounts, vaultOf, walletStateOf } from "../client-web/vault";

const S = new Suite("payout");

async function main() {
  const deployer = loadKey("deployer"), keeper = loadKey("v3-keeper");
  const fund = (to: PublicKey, sol: number) => sendL1(new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [deployer]);
  const payout = (wallet: PublicKey, vault = vaultOf(wallet), signer = keeper) =>
    programFor(signer).methods.vaultPayoutToOwner().accountsPartial({ payer: signer.publicKey, wallet, walletState: walletStateOf(wallet), vault, systemProgram: SystemProgram.programId } as any).rpc();
  const bal = (k: PublicKey) => connection.getBalance(k, "confirmed");

  const owner = Keypair.generate(), other = Keypair.generate();
  await S.ok("fund the owner's and another wallet's vault PDAs (as a landed withdrawal) and the keeper", async () => {
    await fund(owner.publicKey, 0.01);
    await fund(vaultOf(owner.publicKey), 0.02);
    await fund(vaultOf(other.publicKey), 0.01);
    return "funded";
  });

  // ---- the destination is fixed: only the vault's own wallet
  await S.err("the keeper can't pay the owner's vault to the keeper (vault isn't the keeper's: ConstraintSeeds)", "ConstraintSeeds", () => payout(keeper.publicKey, vaultOf(owner.publicKey)));
  await S.err("...nor to another wallet", "ConstraintSeeds", () => payout(other.publicKey, vaultOf(owner.publicKey)));
  await S.err("...nor name a made-up vault", "ConstraintSeeds", () => payout(owner.publicKey, Keypair.generate().publicKey));
  await S.err("nothing at a vault: refused (NothingToCollect)", "NothingToCollect", () => payout(Keypair.generate().publicKey));

  const [o0, v0, k0] = [await bal(owner.publicKey), await bal(vaultOf(owner.publicKey)), await bal(keeper.publicKey)];
  await S.ok("the keeper pays out the owner's vault (no wallet signature)", () => payout(owner.publicKey));
  const [o1, v1, k1] = [await bal(owner.publicKey), await bal(vaultOf(owner.publicKey)), await bal(keeper.publicKey)];
  S.check("the owner received exactly what was at the vault", o1 - o0 === v0 && v1 === 0, { received: o1 - o0, atVault: v0, vaultAfter: v1 });
  S.check("the keeper received nothing and paid only the fee", k0 - k1 > 0 && k0 - k1 <= 10_000, { keeperSpent: k0 - k1 });
  await S.err("paying it out again: nothing left (NothingToCollect)", "NothingToCollect", () => payout(owner.publicKey));
  await S.ok("any key may send it (the money still goes only to the owner): the other wallet's vault, signed by the deployer", async () => {
    const before = await bal(other.publicKey);
    await payout(other.publicKey, vaultOf(other.publicKey), deployer);
    const after = await bal(other.publicKey);
    if (after - before !== 0.01 * LAMPORTS_PER_SOL) throw new Error(`other got ${after - before}`);
    return "ok";
  });

  // ---- a real withdrawal: deposit, vault_exit (the wallet signs on L1), the shuttle lands it, the keeper pays out
  {
    const w = Keypair.generate();
    await fund(w.publicKey, 0.06);
    await S.ok("a wallet opens its vault and deposits 0.02 SOL", async () => {
      await sendL1(new Transaction().add(await programFor(w).methods.openVault().accountsPartial(openVaultAccounts(w.publicKey)).instruction()), [w]);
      return sendL1(new Transaction().add(...depositToVaultIxs(w.publicKey, 20_000_000n)), [w]);
    });
    await sleep(15_000);
    const shuttle = Math.floor(Math.random() * 2 ** 32);
    await S.ok("the wallet takes 0.02 SOL out of the rollup (vault_exit, wallet-signed on L1)", async () =>
      sendL1(new Transaction().add(await programFor(w).methods.vaultExit(shuttle, BN(20_000_000n)).accountsPartial(vaultExitAccounts(w.publicKey, shuttle) as any).instruction()), [w]));
    let landed = 0;
    for (let i = 0; i < 36 && landed === 0; i++) { await sleep(5000); landed = await bal(vaultOf(w.publicKey)); }
    S.check("the withdrawal landed at the vault PDA", landed > 0, { landed });
    const before = await bal(w.publicKey);
    await S.ok("the keeper finishes it (vault_payout_to_owner)", () => payout(w.publicKey));
    const after = await bal(w.publicKey);
    S.check("the wallet received what landed, without signing", after - before === landed, { received: after - before, landed });
  }

  S.finish({ owner: owner.publicKey.toBase58(), keeper: keeper.publicKey.toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
