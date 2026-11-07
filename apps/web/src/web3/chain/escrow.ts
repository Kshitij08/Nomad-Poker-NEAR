/**
 * The poker-escrow program (money tables): PDAs, account decoders and the three player instructions. Ports of
 * Chain/PokerEscrowProgram.cs, Chain/AccountDecoder.cs, Chain/PokerChainModels.cs and the pure parts of
 * Chain/PokerChain.cs. Instruction data comes from shared/idl/poker_escrow.json (src/data/web3-escrow-idl.json); the
 * account layouts are decoded by the IDL coder and checked against AccountDecoder's offsets in the tests.
 *
 * Building is separate from sending: `buildBuyIn` & co. return unsigned transactions; only `ChainService` (on a
 * player's button) ever hands one to the wallet.
 */
import { PublicKey, Transaction, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import idl from '../../data/web3-escrow-idl.json';
import { IDS } from '../config';
import { utf8 } from '../lib/bytes';
import { IdlCoder, type SlimIdl } from '../lib/idl';
import { toBuffer } from '../per/ix';

export const escrowIdl = new IdlCoder(idl as unknown as SlimIdl);

/** 1 chip = 100,000 lamports (0.1 SOL = 1,000 chips). */
export const LAMPORTS_PER_CHIP = 100_000n;
export const chipsToLamports = (chips: bigint): bigint => chips * LAMPORTS_PER_CHIP;
export const lamportsToChips = (lamports: bigint): bigint => lamports / LAMPORTS_PER_CHIP;

export enum SeatStatus { Active = 0, Leaving = 1 }

export interface ChainConfig {
  programId: string;
  settlementAuthority: string;
  rpcUrl: string;
}

export interface TxResult {
  success: boolean;
  signature: string | null;
  error?: string | null;
}

export interface BuyInQuote {
  buyInLamports: bigint;
  rakeLamports: bigint;
  totalLamports: bigint;
  chips: bigint;
}

export interface TableState {
  tableId: string;
  host: string;
  settlementAuthority: string;
  buyInLamports: bigint;
  rakeBps: number;
  smallBlindChips: bigint;
  bigBlindChips: bigint;
  maxSeats: number;
  seatedCount: number;
  chipsInPlay: bigint;
  roundNonce: bigint;
  roundActive: boolean;
  pendingChipsInPlay: bigint;
}

export interface SeatState {
  table: string;
  player: string;
  chips: bigint;
  depositedLamports: bigint;
  rakePaidLamports: bigint;
  status: SeatStatus;
  /** Escrowed mid-round; becomes active chips at settle_round. */
  pendingChips: bigint;
}
export const seatTotalChips = (s: SeatState): bigint => s.chips + s.pendingChips;

export interface TableAddresses {
  tablePda: string;
  vaultPda: string;
  seatPda: string;
}

export function quoteBuyIn(buyInLamports: bigint, rakeBps: number): BuyInQuote {
  const rake = (buyInLamports * BigInt(rakeBps)) / 10_000n;
  return { buyInLamports, rakeLamports: rake, totalLamports: buyInLamports + rake, chips: lamportsToChips(buyInLamports) };
}

/** UTF-8 of the id in a zero-padded 32-byte field (PokerChain.TableIdToBytes). */
export function tableIdToBytes(tableId: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(utf8(tableId).subarray(0, 32));
  return out;
}

/** The program id in use: the compile-time devnet id until the backend's /api/config says otherwise. */
export class EscrowProgram {
  programId = new PublicKey(IDS.escrowProgram);

  setProgramId(base58: string | null | undefined): void {
    if (base58 && base58 !== this.programId.toBase58()) this.programId = new PublicKey(base58);
  }

  private pda(...seeds: Uint8Array[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }
  deriveConfig = () => this.pda(utf8('config'));
  deriveTable = (tableId: Uint8Array) => this.pda(utf8('table'), tableId);
  deriveVault = (tableId: Uint8Array) => this.pda(utf8('vault'), tableId);
  deriveSeat = (tableId: Uint8Array, player: PublicKey) => this.pda(utf8('seat'), tableId, player.toBytes());

  addresses(tableId: string, player: PublicKey): TableAddresses {
    const id = tableIdToBytes(tableId);
    return { tablePda: this.deriveTable(id).toBase58(), vaultPda: this.deriveVault(id).toBase58(), seatPda: this.deriveSeat(id, player).toBase58() };
  }

  /** buy_in / rebuy accounts: player (signer), config, table, vault, seat, dev wallet, system program. */
  private playerIx(name: 'buy_in' | 'rebuy', args: Record<string, unknown>, player: PublicKey, tableId: string, devWallet: PublicKey): TransactionInstruction {
    const id = tableIdToBytes(tableId);
    const keys: AccountMeta[] = [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: this.deriveConfig(), isSigner: false, isWritable: false },
      { pubkey: this.deriveTable(id), isSigner: false, isWritable: true },
      { pubkey: this.deriveVault(id), isSigner: false, isWritable: true },
      { pubkey: this.deriveSeat(id, player), isSigner: false, isWritable: true },
      { pubkey: devWallet, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(IDS.systemProgram), isSigner: false, isWritable: false },
    ];
    return new TransactionInstruction({ programId: this.programId, keys, data: toBuffer(escrowIdl.encodeIx(name, { tableId: id, ...args })) });
  }

  buyInIx(player: PublicKey, tableId: string, devWallet: PublicKey): TransactionInstruction {
    return this.playerIx('buy_in', {}, player, tableId, devWallet);
  }

  rebuyIx(player: PublicKey, tableId: string, buyInLamports: bigint, devWallet: PublicKey): TransactionInstruction {
    return this.playerIx('rebuy', { buyInLamports }, player, tableId, devWallet);
  }

  requestLeaveIx(player: PublicKey, tableId: string): TransactionInstruction {
    const id = tableIdToBytes(tableId);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: player, isSigner: true, isWritable: true },
        { pubkey: this.deriveSeat(id, player), isSigner: false, isWritable: true },
      ],
      data: toBuffer(escrowIdl.encodeIx('request_leave', { tableId: id })),
    });
  }

  /** An unsigned single-instruction transaction with the player as fee payer. */
  static tx(ix: TransactionInstruction, feePayer: PublicKey, recentBlockhash: string): Transaction {
    return new Transaction({ feePayer, recentBlockhash }).add(ix);
  }
}

// ---- decoders (AccountDecoder)

export function decodeConfigDevWallet(data: Uint8Array): PublicKey {
  const c = escrowIdl.decodeAccount<{ devWallet: Uint8Array }>('Config', data);
  if (!c) throw new Error('not an escrow Config account');
  return new PublicKey(c.devWallet);
}

export function decodeTable(tableId: string, data: Uint8Array): TableState {
  const t = escrowIdl.decodeAccount<Record<string, any>>('Table', data);
  if (!t) throw new Error(`Table '${tableId}' not found on chain.`);
  return {
    tableId,
    host: new PublicKey(t.host).toBase58(),
    settlementAuthority: new PublicKey(t.settlementAuthority).toBase58(),
    buyInLamports: t.buyInLamports,
    rakeBps: t.rakeBps,
    smallBlindChips: t.smallBlindChips,
    bigBlindChips: t.bigBlindChips,
    maxSeats: t.maxSeats,
    seatedCount: t.seatedCount,
    chipsInPlay: t.chipsInPlay,
    roundNonce: t.roundNonce,
    roundActive: t.roundActive,
    pendingChipsInPlay: t.pendingChipsInPlay,
  };
}

export function decodeSeat(data: Uint8Array): SeatState {
  const s = escrowIdl.decodeAccount<Record<string, any>>('Seat', data);
  if (!s) throw new Error('not an escrow Seat account');
  return {
    table: new PublicKey(s.table).toBase58(),
    player: new PublicKey(s.player).toBase58(),
    chips: s.chips,
    depositedLamports: s.depositedLamports,
    rakePaidLamports: s.rakePaidLamports,
    status: s.status as SeatStatus,
    pendingChips: s.pendingChips,
  };
}
