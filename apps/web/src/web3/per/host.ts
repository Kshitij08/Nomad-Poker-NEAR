/**
 * M9b: hosting a table from the game. Port of Per/Core/PerHost.cs. The host's wallet signs only Solana transactions
 * it can preview: create + hand over to the rollup (one transaction) and reclaiming the rent. Opening, the invite
 * list (private, in the rollup since M9c) and closing run in the rollup, signed by the host's play key (see PerVault).
 * Mirrors per/tests/host.devnet.ts and per/tests/invites.devnet.ts.
 */
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { bytesEq, concat, randomBytes, u64le, utf8 } from '../lib/bytes';
import { ataOf, findPda, perConfigAddress, permissionOf, PerIds, type PerTableAddresses } from './addresses';
import { buildPerIx, PerIx } from './ix';
import { BUY_IN_CAP, LAMPORTS_PER_DOLLAR, STAKES, stakeMaxBuyIn, stakeMinBuyIn } from './money';
import type { Invites, TableParams } from './types';
import { vaultTokenOf, walletStateOf, type PlayKey } from './vault';

const dlp = (tag: string, account: PublicKey) => findPda(PerIds.delegationProgram, utf8(tag), account.toBytes());
const bufferOf = (account: PublicKey, ownerProgram: PublicKey) => findPda(ownerProgram, utf8('buffer'), account.toBytes());

function tableAddress(creator: PublicKey, id: bigint): PublicKey {
  return findPda(PerIds.program, utf8('table'), creator.toBytes(), u64le(id));
}
const escapePayer = (table: PublicKey): PublicKey => findPda(PerIds.program, utf8('escape-payer'), table.toBytes());
const invitesAddress = (table: PublicKey): PublicKey => findPda(PerIds.program, utf8('invites'), table.toBytes());
const privateInvitesAddress = (table: PublicKey): PublicKey => findPda(PerIds.program, utf8('invites_p'), table.toBytes());

/** sha256(table, wallet): how a wallet appears in a table's invite list. */
const inviteHash = (table: PublicKey, wallet: PublicKey): Uint8Array => sha256(concat(table.toBytes(), wallet.toBytes()));
/** The private list's 16-byte entry for a wallet: the first half of inviteHash. */
const privateInviteEntry = (table: PublicKey, wallet: PublicKey): Uint8Array => inviteHash(table, wallet).slice(0, 16);

function setInvitesKeyed(t: PerTableAddresses, hostKey: PlayKey, wallets: readonly PublicKey[] | null, codeHash: Uint8Array | null): TransactionInstruction {
  const entries = wallets ? wallets.map((w) => privateInviteEntry(t.table, w)) : null;
  const inv = privateInvitesAddress(t.table);
  return buildPerIx('set_invites_keyed', { expires: hostKey.expires, hashes: entries, codeHash }, {
    play_key: hostKey.key.publicKey, table: t.table, invites: inv, invites_permission: permissionOf(inv),
    legacy_invites: invitesAddress(t.table), wallet_state: walletStateOf(hostKey.wallet),
  });
}

export const PerHost = {
  /** The game shows SOL amounts in "$" at this scale: $1 = 0.0001 SOL (devnet play money). */
  LAMPORTS_PER_DOLLAR,
  /** The program's buy-in cap (config max_buy_in: 1 SOL). */
  BUY_IN_CAP,
  /** The stake levels (lamports): Micro $1/$2 … Elite $100/$250. Buy-ins run from the tier's minimum to 100 BB (capped). */
  STAKES,
  minBuyIn: stakeMinBuyIn,
  maxBuyIn: stakeMaxBuyIn,
  /** Hosted tables have 2 to 8 seats. */
  MIN_SEATS: 2,
  MAX_SEATS: 8,
  /** The program's limit on invites per table. */
  MAX_INVITES: 16,
  /** create_table's compute varies with the id (M3); the delegation adds ~66k. */
  CREATE_AND_DELEGATE_CU: 500_000,

  /** A random u64 (8 random bytes, little-endian, as BitConverter.ToUInt64). */
  newTableId(): bigint {
    return new DataView(randomBytes(8).buffer).getBigUint64(0, true);
  },

  tableAddress,
  escapePayer,
  /** A pre-M9c table's L1 invite list. */
  invitesAddress,
  /** M9c: the table's private invite list in the rollup (nobody can read it). */
  privateInvitesAddress,

  /** A new invite link's secret code (16 random bytes). */
  newInviteCode: (): Uint8Array => randomBytes(16),

  /** sha256("invite-code", table, code): what the private list stores for the link. */
  inviteCodeHash(table: PublicKey, code: Uint8Array): Uint8Array {
    if (code.length < 16) throw new Error('an invite code is 16 bytes');
    return sha256(concat(utf8('invite-code'), table.toBytes(), code.subarray(0, 16)));
  },

  privateInviteEntry,
  inviteHash,

  isInvited(inv: Invites | null, table: PublicKey, wallet: PublicKey): boolean {
    if (!inv) return false;
    const h = inviteHash(table, wallet);
    for (let i = 0; i < inv.count && i < inv.hashes.length; i++) if (bytesEq(inv.hashes[i]!.subarray(0, 32), h)) return true;
    return false;
  },

  /** L1, one transaction signed by the host: create the table (and its escrow) and hand it to the rollup. */
  createAndDelegate(creator: PublicKey, id: bigint, p: TableParams): TransactionInstruction[] {
    const table = tableAddress(creator, id);
    const escrowEata = findPda(PerIds.esplProgram, table.toBytes(), PerIds.nativeMint.toBytes());
    const escrowPermission = permissionOf(escrowEata);
    const create = buildPerIx('create_table', { tableId: id, params: p }, {
      creator, config: perConfigAddress(), table, escrow: ataOf(table), escrow_eata: escrowEata,
      escrow_buffer: bufferOf(escrowEata, PerIds.esplProgram), escrow_delegation_record: dlp('delegation', escrowEata), escrow_delegation_metadata: dlp('delegation-metadata', escrowEata),
      escrow_permission: escrowPermission, escrow_permission_buffer: bufferOf(escrowPermission, PerIds.permissionProgram),
      escrow_permission_delegation_record: dlp('delegation', escrowPermission), escrow_permission_delegation_metadata: dlp('delegation-metadata', escrowPermission),
    });
    const handOver = buildPerIx('delegate_table', { tableId: id, creator: creator.toBytes() }, {
      payer: creator, buffer_table: bufferOf(table, PerIds.program), delegation_record_table: dlp('delegation', table),
      delegation_metadata_table: dlp('delegation-metadata', table), table, escape_payer: escapePayer(table),
    });
    return [PerIx.computeLimit(PerHost.CREATE_AND_DELEGATE_CU), create, handOver];
  },

  /** L1, signed by the host: replace the table's (pre-M9c) invite list (up to 16 wallets). */
  setInvites(creator: PublicKey, id: bigint, wallets: readonly PublicKey[]): TransactionInstruction {
    const table = tableAddress(creator, id);
    return buildPerIx('set_invites', { tableId: id, hashes: wallets.map((w) => inviteHash(table, w)) }, {
      creator, table, invites: invitesAddress(table),
    });
  },

  /**
   * Rollup, signed by the host's play key (its check right before): set the table's private invite list. `wallets`
   * null keeps the list; `codeHash` null keeps the link, all zeros removes it. The first call for a table must pass
   * both null: it only creates the list (see setInvitesKeyedSteps).
   */
  setInvitesKeyed,

  /**
   * The two play-key transactions that set a private list: create it (empty, harmless if it exists), then the data.
   * The TEE withholds a transaction touching a permissioned account whose permission doesn't exist yet.
   */
  setInvitesKeyedSteps: (t: PerTableAddresses, hostKey: PlayKey, wallets: readonly PublicKey[] | null, codeHash: Uint8Array | null): TransactionInstruction[] =>
    [setInvitesKeyed(t, hostKey, null, null), setInvitesKeyed(t, hostKey, wallets, codeHash)],

  /** L1, signed by the host: close a pre-M9c table's L1 invite list and take its rent back. */
  closeInvites(creator: PublicKey, id: bigint): TransactionInstruction {
    const table = tableAddress(creator, id);
    return buildPerIx('close_invites', { tableId: id }, { creator, table, invites: invitesAddress(table) });
  },

  /** Rollup, permissionless: create the table's private accounts. `payer` only signs. */
  open: (t: PerTableAddresses, payer: PublicKey): TransactionInstruction =>
    buildPerIx('open_table', {}, {
      payer, table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
      deck: t.deck, deck_permission: permissionOf(t.deck), record: t.record, log: t.log, log_permission: t.logPermission,
    }),

  /**
   * Rollup: close an empty table with the host's play key (its check right before). Unpaid rake goes to `devWallet`'s
   * wSOL account; any leftover to the host's game balance. `hostHasVault`: name the host's vault only if it exists (an
   * absent optional account is fine; a named one that doesn't exist fails the close).
   */
  closeKeyed(t: PerTableAddresses, hostKey: PlayKey, devWallet: PublicKey, hostHasVault = true): TransactionInstruction {
    const named: Record<string, PublicKey> = {
      signer: hostKey.key.publicKey, config: t.config, table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
      deck: t.deck, escrow: t.escrow, creator_vault_token: vaultTokenOf(hostKey.wallet), wallet_state: walletStateOf(hostKey.wallet),
      dev_token: ataOf(devWallet), record: t.record, log: t.log, log_permission: t.logPermission,
      magic_fee_vault: findPda(PerIds.delegationProgram, utf8('magic-fee-vault'), PerIds.teeValidator.toBytes()),
    };
    const args = { expires: hostKey.expires };
    return hostHasVault ? buildPerIx('close_table_keyed', args, named) : buildPerIx('close_table_keyed', args, named, ['creator_vault_token']);
  },

  /** L1, signed by the host once the closed table is back on Solana: return its rent. */
  reclaim(creator: PublicKey, id: bigint): TransactionInstruction {
    const table = tableAddress(creator, id);
    return buildPerIx('reclaim_table', { tableId: id }, { creator, table, escape_payer: escapePayer(table) });
  },
};
