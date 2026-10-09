// M9 game vault: addresses, the play-key message the wallet signs, and instruction builders. Shared by
// the devnet suites (tests/vault.devnet.ts) and the web pages. Mirrors programs/poker-per/src/
// instructions/vault.rs; the message text must match `play_key_message` byte for byte.
import { Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as sdk from "@magicblock-labs/ephemeral-rollups-sdk";

const s: any = sdk;
export const PROGRAM_ID = new PublicKey("7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv");
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const ESPL = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
export const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM: PublicKey = s.PERMISSION_PROGRAM_ID;
/** The client asks for 7 days; the program accepts up to 30. */
export const PLAY_KEY_DAYS = 1;

/** M10: the wallet's state (play-key set, which vault is current); may not exist (both 0). */
export const walletStateOf = (wallet: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("wallet"), wallet.toBuffer()], PROGRAM_ID)[0];
/** A vault seed (M10): all zeros (or none) = the wallet's first vault, the M9 address; a fresh vault has 8 random bytes. */
export type VaultSeed = Uint8Array | number[] | null | undefined;
const seedBytes = (seed: VaultSeed) => (!seed || Array.from(seed).every((b) => b === 0) ? Buffer.alloc(0) : Buffer.from(Array.from(seed)));
/** Reads (key set, vault seed) from a WalletState account's data (8 + 32 + 4 + 8 bytes); none = (0, zeros). */
export const decodeWalletState = (data: Buffer | null | undefined) => data && data.length >= 52
  ? { keySet: data.readUInt32LE(40), vaultSeed: Array.from(data.subarray(44, 52)) }
  : { keySet: 0, vaultSeed: [0, 0, 0, 0, 0, 0, 0, 0] };
export const vaultOf = (wallet: PublicKey, seed?: VaultSeed) => PublicKey.findProgramAddressSync([Buffer.from("vault"), wallet.toBuffer(), seedBytes(seed)], PROGRAM_ID)[0];
export const vaultTokenOf = (wallet: PublicKey, seed?: VaultSeed) => getAssociatedTokenAddressSync(NATIVE_MINT, vaultOf(wallet, seed), true);
export const walletTokenOf = (wallet: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, wallet);

/** `keySet` (M10): the wallet's current play-key set; 0 keeps the M9 wording. */
export function playKeyMessage(key: PublicKey, expires: number | bigint, keySet = 0): Buffer {
  return Buffer.from(`Nomad Poker private tables
Allow play key ${key.toBase58()} to use my game balance until ${expires.toString()} (unix time). It can buy in to tables (where chips can be lost), leave them, and send money only back to this wallet.${keySet ? ` Key set ${keySet}.` : ""}`, "utf8");
}

/** The Ed25519 check that must sit right before every play-key instruction. */
export const proofIx = (wallet: PublicKey, message: Buffer, signature: Uint8Array) =>
  Ed25519Program.createInstructionWithPublicKey({ publicKey: wallet.toBytes(), message, signature });

/** Accounts of `open_vault` (L1), in the order the IDL lists them. */
export function openVaultAccounts(wallet: PublicKey, seed?: VaultSeed) {
  const vault = vaultOf(wallet, seed);
  const vaultEata = PublicKey.findProgramAddressSync([vault.toBuffer(), NATIVE_MINT.toBuffer()], ESPL)[0];
  const permission: PublicKey = s.permissionPdaFromAccount(vaultEata);
  const dlp = (tag: string, k: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), k.toBuffer()], DLP)[0];
  return {
    wallet, walletState: walletStateOf(wallet), vault, mint: NATIVE_MINT, vaultToken: vaultTokenOf(wallet, seed), vaultEata,
    vaultBuffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), vaultEata.toBuffer()], ESPL)[0],
    vaultDelegationRecord: dlp("delegation", vaultEata), vaultDelegationMetadata: dlp("delegation-metadata", vaultEata),
    vaultPermission: permission,
    vaultPermissionBuffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), permission.toBuffer()], PERMISSION_PROGRAM)[0],
    vaultPermissionDelegationRecord: dlp("delegation", permission), vaultPermissionDelegationMetadata: dlp("delegation-metadata", permission),
    esplProgram: ESPL, delegationProgram: DLP, permissionProgram: PERMISSION_PROGRAM, validator: TEE_VALIDATOR,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}

/**
 * Deposit `lamports` of SOL from the wallet into its game vault in the rollup (L1; previews cleanly):
 * wrap into the wallet's wSOL account, then MagicBlock's shuttle merge with the vault's account as the
 * destination. The vault must be open (`open_vault`, which can go in an earlier transaction).
 */
export function depositToVaultIxs(wallet: PublicKey, lamports: bigint, shuttleId = Math.floor(Math.random() * 2 ** 32), seed?: VaultSeed): TransactionInstruction[] {
  const walletAta = walletTokenOf(wallet);
  const [shuttleEata] = s.deriveShuttleEphemeralAta(wallet, NATIVE_MINT, shuttleId);
  const [shuttleAta] = s.deriveShuttleAta(shuttleEata, NATIVE_MINT);
  const shuttleWalletAta = s.deriveShuttleWalletAta(NATIVE_MINT, shuttleEata);
  return [
    createAssociatedTokenAccountIdempotentInstruction(wallet, walletAta, wallet, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: walletAta, lamports: Number(lamports) }),
    createSyncNativeInstruction(walletAta),
    s.setupAndDelegateShuttleEphemeralAtaWithMergeIx(wallet, shuttleEata, shuttleAta, wallet, walletAta, vaultTokenOf(wallet, seed), shuttleWalletAta, NATIVE_MINT, shuttleId, lamports, TEE_VALIDATOR),
  ];
}

/**
 * M10 (review H1): accounts of `vault_exit`, MagicBlock's shuttle withdrawal with the vault as the owner. It takes the
 * game balance to the vault's wSOL account on Solana without the wallet's own rollup account, which an outsider can
 * block for good. `vault_payout` then moves it to the wallet.
 */
export function vaultExitAccounts(wallet: PublicKey, shuttleId: number, seed?: VaultSeed) {
  const vault = vaultOf(wallet, seed);
  const [shuttleEata] = s.deriveShuttleEphemeralAta(vault, NATIVE_MINT, shuttleId);
  const [shuttleAta] = s.deriveShuttleAta(shuttleEata, NATIVE_MINT);
  const dlp = (tag: string, k: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), k.toBuffer()], DLP)[0];
  return {
    wallet, walletState: walletStateOf(wallet), vault, vaultToken: vaultTokenOf(wallet, seed), rentPda: s.deriveRentPda()[0],
    shuttleEata, shuttleAta, shuttleWalletAta: s.deriveShuttleWalletAta(NATIVE_MINT, shuttleEata),
    shuttleBuffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), shuttleAta.toBuffer()], ESPL)[0],
    shuttleDelegationRecord: dlp("delegation", shuttleAta), shuttleDelegationMetadata: dlp("delegation-metadata", shuttleAta),
    mint: NATIVE_MINT, esplProgram: ESPL, delegationProgram: DLP,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}

/** Makes sure the wallet's own wSOL account exists in the rollup (needed before a vault withdrawal lands there). */
export async function ensureWalletInRollupIxs(wallet: PublicKey): Promise<TransactionInstruction[]> {
  return s.delegateSpl(wallet, NATIVE_MINT, 0n, { validator: TEE_VALIDATOR, initAtasIfMissing: true, payer: wallet });
}

/** MagicBlock's withdrawal of the wallet's own rollup wSOL to Solana (L1; previews cleanly). */
export async function withdrawToWalletIxs(wallet: PublicKey, lamports: bigint): Promise<TransactionInstruction[]> {
  return s.withdrawSpl(wallet, NATIVE_MINT, lamports, { validator: TEE_VALIDATOR, initAtasIfMissing: true, payer: wallet });
}

export { SYSVAR_INSTRUCTIONS_PUBKEY };
