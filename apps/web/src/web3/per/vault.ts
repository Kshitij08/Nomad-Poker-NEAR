/**
 * M9: the game vault and play keys (programs/poker-per/src/instructions/vault.rs). The wallet signs only Solana
 * transactions it can preview (open_vault, MagicBlock's deposit and withdrawal) and one message per play key;
 * inside the rollup the play key (or the seat's table key) signs. Port of Per/Core/PerVault.cs (mirrors
 * per/client-web/vault.ts); the message must match the program's byte for byte.
 */
import { Keypair, PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { IDS } from '../config';
import { concat, isZero, randomBytes, u16le, u32le, u64le, utf8 } from '../lib/bytes';
import { ataOf, findPda, permissionOf, PerIds, type PerTableAddresses } from './addresses';
import { buildPerIx, PerIx, toBuffer } from './ix';

const ED25519 = new PublicKey(IDS.ed25519Program);
const SYSTEM = new PublicKey(IDS.systemProgram);

/** How long a play key's authorization lasts (the program allows up to 30 days). */
export const PLAY_KEY_DAYS = 1;

// ---- M10: the wallet's state on L1 (play-key set, which vault is current), cached per wallet once read.
const FIRST_VAULT = new Uint8Array(8);
const states = new Map<string, { keySet: number; seed: Uint8Array }>();

export const walletStateOf = (wallet: PublicKey): PublicKey => findPda(PerIds.program, utf8('wallet'), wallet.toBytes());

/** (key set, vault seed) from a WalletState account's data (8 + 32 + 4 + 8 bytes); none = (0, zeros). */
export function decodeWalletState(data: Uint8Array | null | undefined): { keySet: number; seed: Uint8Array } {
  if (!data || data.length < 52) return { keySet: 0, seed: FIRST_VAULT };
  return { keySet: new DataView(data.buffer, data.byteOffset).getUint32(40, true), seed: data.slice(44, 52) };
}
export const setWalletState = (wallet: PublicKey, keySet: number, seed: Uint8Array | null): void => {
  states.set(wallet.toBase58(), { keySet, seed: seed ?? FIRST_VAULT });
};
export const walletStateCached = (wallet: PublicKey): { keySet: number; seed: Uint8Array } =>
  states.get(wallet.toBase58()) ?? { keySet: 0, seed: FIRST_VAULT };

/** The wallet's current vault: the first one has the M9 address; a fresh one (M10) adds its random seed. */
export function vaultOf(wallet: PublicKey, seed: Uint8Array | null = walletStateCached(wallet).seed): PublicKey {
  return !seed || isZero(seed)
    ? findPda(PerIds.program, utf8('vault'), wallet.toBytes())
    : findPda(PerIds.program, utf8('vault'), wallet.toBytes(), seed);
}
export const newVaultSeed = (): Uint8Array => randomBytes(8);
export const vaultTokenOf = (wallet: PublicKey): PublicKey => ataOf(vaultOf(wallet));
export const walletTokenOf = (wallet: PublicKey): PublicKey => ataOf(wallet);
/** MagicBlock's ephemeral token account for an owner: [owner, mint] under their token program. */
export const eataOf = (owner: PublicKey): PublicKey => findPda(PerIds.esplProgram, owner.toBytes(), PerIds.nativeMint.toBytes());

/** The text the wallet signs to authorize `key` until `expires` (unix seconds). */
export function playKeyMessage(key: PublicKey, expires: bigint | number, keySet = 0): Uint8Array {
  return utf8(
    `Nomad Poker private tables\nAllow play key ${key.toBase58()} to use my game balance until ${expires.toString()} (unix time). It can buy in to tables (where chips can be lost), leave them, and send money only back to this wallet.${keySet === 0 ? '' : ` Key set ${keySet}.`}`,
  );
}

/** Solana's Ed25519 signature check of `message` by `wallet`, everything inside this one instruction. */
export function ed25519Check(wallet: PublicKey, message: Uint8Array, signature: Uint8Array): TransactionInstruction {
  const header = 16;
  const pkOff = header;
  const sigOff = pkOff + 32;
  const msgOff = sigOff + 64;
  const data = new Uint8Array(msgOff + message.length);
  data[0] = 1; // one signature
  const put = (at: number, v: number) => data.set(u16le(v), at);
  put(2, sigOff); put(4, 0xffff); put(6, pkOff); put(8, 0xffff); put(10, msgOff); put(12, message.length); put(14, 0xffff);
  data.set(wallet.toBytes(), pkOff);
  data.set(signature, sigOff);
  data.set(message, msgOff);
  return new TransactionInstruction({ programId: ED25519, keys: [], data: toBuffer(data) });
}

/** A play key with the wallet's signed authorization. */
export class PlayKey {
  constructor(
    readonly key: Keypair,
    readonly wallet: PublicKey,
    readonly expires: bigint,
    readonly signature: Uint8Array,
    /** The wallet's play-key set the signed message names (M10). */
    readonly keySet: number,
  ) {}
  check(): TransactionInstruction {
    return ed25519Check(this.wallet, playKeyMessage(this.key.publicKey, this.expires, this.keySet), this.signature);
  }
}

const dlp = (tag: string, account: PublicKey) => findPda(PerIds.delegationProgram, utf8(tag), account.toBytes());
const bufferOf = (account: PublicKey, ownerProgram: PublicKey) => findPda(ownerProgram, utf8('buffer'), account.toBytes());

export const PerVault = {
  /** Compute for a transaction with `open_vault` (130k–160k units depending on PDA searches). */
  OPEN_VAULT_CU: 400_000,
  openVaultBudget: () => PerIx.computeLimit(PerVault.OPEN_VAULT_CU),

  /** L1, signed by the wallet: creates and hands the vault to the rollup. Idempotent. */
  openVault(wallet: PublicKey, seed: Uint8Array | null = null): TransactionInstruction {
    const vault = seed === null ? vaultOf(wallet) : vaultOf(wallet, seed);
    const eata = eataOf(vault);
    const permission = permissionOf(eata);
    return buildPerIx('open_vault', {}, {
      wallet, wallet_state: walletStateOf(wallet), vault, vault_token: ataOf(vault), vault_eata: eata,
      vault_buffer: bufferOf(eata, PerIds.esplProgram), vault_delegation_record: dlp('delegation', eata), vault_delegation_metadata: dlp('delegation-metadata', eata),
      vault_permission: permission, vault_permission_buffer: bufferOf(permission, PerIds.permissionProgram),
      vault_permission_delegation_record: dlp('delegation', permission), vault_permission_delegation_metadata: dlp('delegation-metadata', permission),
    });
  },

  /** `invites`: the table's invite list for an invite-only table, else null. `code`: the invite link's secret (16 bytes). */
  buyIn(t: PerTableAddresses, p: PlayKey, seat: number, amount: bigint, reader: PublicKey, invites: PublicKey | null = null, code: Uint8Array | null = null): TransactionInstruction {
    const named: Record<string, PublicKey> = {
      play_key: p.key.publicKey, wallet: p.wallet, wallet_state: walletStateOf(p.wallet), vault: vaultOf(p.wallet), vault_token: vaultTokenOf(p.wallet),
      config: t.config, table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
      hand: t.hand(seat), hand_permission: t.handPermission(seat), escrow: t.escrow,
    };
    const args = { seat, amount, reader: reader.toBytes(), expires: p.expires };
    if (code) {
      if (!invites) throw new Error('an invite code needs the table\'s invite list');
      return buildPerIx('vault_buy_in_code', { ...args, code }, { ...named, invites });
    }
    if (invites) return buildPerIx('vault_buy_in', args, { ...named, invites });
    return buildPerIx('vault_buy_in', args, named, ['invites']);
  },

  /** `signer` is the seat's table key (`expires` 0) or the wallet's play key (its expiry, with its check before). */
  cashOut: (t: PerTableAddresses, signer: PublicKey, wallet: PublicKey, seat: number, expires: bigint) =>
    buildPerIx('vault_cash_out', { seat, expires }, {
      signer, wallet, wallet_state: walletStateOf(wallet), vault: vaultOf(wallet), vault_token: vaultTokenOf(wallet),
      table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission, hand: t.hand(seat), hand_permission: t.handPermission(seat), escrow: t.escrow,
    }),

  withdraw: (p: PlayKey, amount: bigint) =>
    buildPerIx('vault_withdraw', { amount, expires: p.expires }, {
      play_key: p.key.publicKey, wallet: p.wallet, wallet_state: walletStateOf(p.wallet), vault: vaultOf(p.wallet), vault_token: vaultTokenOf(p.wallet), wallet_token: walletTokenOf(p.wallet),
    }),

  balance: (p: PlayKey) =>
    buildPerIx('vault_balance', { expires: p.expires }, {
      play_key: p.key.publicKey, wallet: p.wallet, wallet_state: walletStateOf(p.wallet), vault: vaultOf(p.wallet), vault_token: vaultTokenOf(p.wallet),
    }),

  /** L1, signed by the wallet (M10): cancel every play key it authorized before. */
  revokePlayKeys: (wallet: PublicKey) => buildPerIx('revoke_play_keys', {}, { wallet, wallet_state: walletStateOf(wallet) }),

  /** Whether the wallet's current vault is blocked (delegated elsewhere, or its permission not public). */
  isBlocked(eataRecord: Uint8Array | null, permission: Uint8Array | null, permissionRecord: Uint8Array | null): boolean {
    const elsewhere = (r: Uint8Array | null) => {
      if (!r || r.length < 40) return false;
      const v = PerIds.teeValidator.toBytes();
      for (let i = 0; i < 32; i++) if (r[8 + i] !== v[i]) return true;
      return false;
    };
    const privateDelegated = !!permissionRecord && !!permission && (permission.length <= 34 || permission[34] !== 0);
    return elsewhere(eataRecord) || elsewhere(permissionRecord) || privateDelegated;
  },

  /** The L1 accounts isBlocked and newVault look at, for the wallet's vault at `seed`. */
  blockAccounts(wallet: PublicKey, seed: Uint8Array) {
    const eata = eataOf(vaultOf(wallet, seed));
    const permission = permissionOf(eata);
    return { eataRecord: dlp('delegation', eata), permission, permissionRecord: dlp('delegation', permission) };
  },

  /** L1, signed by the wallet (M10): replace a blocked vault with a fresh one at `nextSeed`. */
  newVault(wallet: PublicKey, currentSeed: Uint8Array, nextSeed: Uint8Array): TransactionInstruction {
    const b = PerVault.blockAccounts(wallet, currentSeed);
    return buildPerIx('new_vault', { seed: nextSeed }, {
      wallet, wallet_state: walletStateOf(wallet), eata_delegation_record: b.eataRecord, permission: b.permission,
      permission_delegation_record: b.permissionRecord, old_vault_token: ataOf(vaultOf(wallet, currentSeed)),
    });
  },

  /** L1 (M10 review H1): take `lamports` of the game balance to the vault's wSOL account on Solana (shuttle). */
  vaultExit(wallet: PublicKey, lamports: bigint, shuttleId: number): TransactionInstruction {
    const vault = vaultOf(wallet);
    const shuttleEata = findPda(PerIds.esplProgram, vault.toBytes(), PerIds.nativeMint.toBytes(), u32le(shuttleId));
    const shuttleAta = findPda(PerIds.esplProgram, shuttleEata.toBytes(), PerIds.nativeMint.toBytes());
    return buildPerIx('vault_exit', { shuttleId, amount: lamports }, {
      wallet, wallet_state: walletStateOf(wallet), vault, vault_token: vaultTokenOf(wallet),
      rent_pda: findPda(PerIds.esplProgram, utf8('rent')),
      shuttle_eata: shuttleEata, shuttle_ata: shuttleAta, shuttle_wallet_ata: ataOf(shuttleEata),
      shuttle_buffer: bufferOf(shuttleAta, PerIds.esplProgram), shuttle_delegation_record: dlp('delegation', shuttleAta),
      shuttle_delegation_metadata: dlp('delegation-metadata', shuttleAta),
    });
  },

  /** L1: what vaultExit brought goes to the wallet's own wSOL account, then closed so it arrives as SOL. */
  vaultPayout(wallet: PublicKey): TransactionInstruction[] {
    return [
      createAtaIdempotent(wallet, walletTokenOf(wallet), wallet),
      buildPerIx('vault_payout', {}, {
        wallet, wallet_state: walletStateOf(wallet), vault: vaultOf(wallet), vault_token: vaultTokenOf(wallet), wallet_token: walletTokenOf(wallet),
      }),
      rawIx(PerIds.tokenProgram, Uint8Array.of(9), W(walletTokenOf(wallet)), W(wallet), R(wallet, true)), // close: wSOL → SOL
    ];
  },

  newShuttleId: (): number => (crypto.getRandomValues(new Uint32Array(1))[0]! ^ (Date.now() >>> 0)) >>> 0,

  /** L1: wrap `lamports` of SOL and deposit them straight into the game vault (MagicBlock's shuttle merge). */
  deposit(wallet: PublicKey, lamports: bigint, shuttleId: number): TransactionInstruction[] {
    const walletAta = walletTokenOf(wallet);
    const mintVault = findPda(PerIds.esplProgram, PerIds.nativeMint.toBytes());
    const keys = shuttleKeys(wallet, shuttleId);
    keys.push(W(vaultTokenOf(wallet)), R(PerIds.nativeMint), R(PerIds.tokenProgram), R(mintVault), W(walletAta), W(ataOf(mintVault)));
    return [
      createAtaIdempotent(wallet, walletAta, wallet),
      transfer(wallet, walletAta, lamports),
      syncNative(walletAta),
      new TransactionInstruction({ programId: PerIds.esplProgram, keys, data: toBuffer(shuttleData(24, shuttleId, lamports)) }),
    ];
  },

  /** L1: makes sure the wallet's own wSOL account exists in the rollup. Harmless if it exists. */
  ensureWalletInRollup: (wallet: PublicKey): TransactionInstruction[] => [
    createAtaIdempotent(wallet, walletTokenOf(wallet), wallet),
    rawIx(PerIds.esplProgram, Uint8Array.of(0), W(eataOf(wallet)), W(wallet, true), R(wallet), R(PerIds.nativeMint), R(SYSTEM)),
    delegateEata(wallet, eataOf(wallet)),
  ],

  /** L1: MagicBlock's withdrawal of the wallet's rollup wSOL to Solana (it arrives as SOL). */
  withdrawToWallet(wallet: PublicKey, lamports: bigint, shuttleId: number): TransactionInstruction[] {
    const keys = shuttleKeys(wallet, shuttleId);
    keys.push(W(walletTokenOf(wallet)), R(PerIds.nativeMint), R(PerIds.tokenProgram));
    return [...PerVault.ensureWalletInRollup(wallet), new TransactionInstruction({ programId: PerIds.esplProgram, keys, data: toBuffer(shuttleData(26, shuttleId, lamports)) })];
  },
};

// ------------------------------------------------------------------------------ MagicBlock / SPL (L1)

const W = (k: PublicKey, signer = false): AccountMeta => ({ pubkey: k, isSigner: signer, isWritable: true });
const R = (k: PublicKey, signer = false): AccountMeta => ({ pubkey: k, isSigner: signer, isWritable: false });
const rawIx = (program: PublicKey, data: Uint8Array, ...keys: AccountMeta[]) => new TransactionInstruction({ programId: program, keys, data: toBuffer(data) });

const createAtaIdempotent = (payer: PublicKey, ata: PublicKey, owner: PublicKey) =>
  rawIx(PerIds.associatedTokenProgram, Uint8Array.of(1), W(payer, true), W(ata), R(owner), R(PerIds.nativeMint), R(SYSTEM), R(PerIds.tokenProgram));

const transfer = (from: PublicKey, to: PublicKey, lamports: bigint) => rawIx(SYSTEM, concat(u32le(2), u64le(lamports)), W(from, true), W(to));
const syncNative = (account: PublicKey) => rawIx(PerIds.tokenProgram, Uint8Array.of(17), W(account));

function delegateEata(payer: PublicKey, eata: PublicKey): TransactionInstruction {
  return rawIx(PerIds.esplProgram, concat(Uint8Array.of(4), PerIds.teeValidator.toBytes()), W(payer, true), W(eata), R(PerIds.esplProgram), W(bufferOf(eata, PerIds.esplProgram)),
    W(dlp('delegation', eata)), W(dlp('delegation-metadata', eata)), R(PerIds.delegationProgram), R(SYSTEM));
}

function shuttleData(tag: number, shuttleId: number, amount: bigint): Uint8Array {
  return concat(Uint8Array.of(tag), u32le(shuttleId), u64le(amount), PerIds.teeValidator.toBytes());
}

/** The shuttle accounts MagicBlock's deposit and withdrawal share (first 13 keys). */
function shuttleKeys(wallet: PublicKey, shuttleId: number): AccountMeta[] {
  const shuttleEata = findPda(PerIds.esplProgram, wallet.toBytes(), PerIds.nativeMint.toBytes(), u32le(shuttleId));
  const shuttleAta = findPda(PerIds.esplProgram, shuttleEata.toBytes(), PerIds.nativeMint.toBytes());
  const rent = findPda(PerIds.esplProgram, utf8('rent'));
  return [
    W(wallet, true), W(rent), W(shuttleEata), W(shuttleAta), W(ataOf(shuttleEata)), R(wallet, true), R(PerIds.esplProgram),
    W(bufferOf(shuttleAta, PerIds.esplProgram)), W(dlp('delegation', shuttleAta)), W(dlp('delegation-metadata', shuttleAta)),
    R(PerIds.delegationProgram), R(PerIds.associatedTokenProgram), R(SYSTEM),
  ];
}
