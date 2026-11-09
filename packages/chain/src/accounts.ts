import { address, toBase58, type Address } from './pubkey';
import type { Instruction } from './transaction';

/**
 * poker-escrow account layouts (programs/poker-escrow/src/state.rs, Anchor: 8-byte discriminator, then Borsh) and the
 * program's units. 1 chip = 100,000 lamports, so a 1,000-chip buy-in is 0.1 SOL.
 */

export const LAMPORTS_PER_CHIP = 100_000n;
/** A seat may be cashed out during an active round once this long has passed since the last settlement. */
export const STALE_ROUND_SECS = 600;
export const SEAT_ACCOUNT_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 1;

/** Program error codes (onchain/idl/poker_escrow.json). */
export const EscrowError = {
  TableFull: 6002,
  RoundInProgress: 6003,
  SettlementNotZeroSum: 6004,
  StaleSettlement: 6005,
  VaultInvariant: 6008,
  Unauthorized: 6009,
  TableNotEmpty: 6010,
  SeatNotInSettlement: 6014,
} as const;

export interface TableAccount {
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
  lastSettlementTs: number;
  pendingChipsInPlay: bigint;
}

export interface SeatAccount {
  table: string;
  player: string;
  chips: bigint;
  depositedLamports: bigint;
  rakePaidLamports: bigint;
  leaving: boolean;
  lastActiveTs: number;
  pendingChips: bigint;
}

class Reader {
  private o = 8; // past the Anchor discriminator
  constructor(private readonly d: Uint8Array) {}
  key(): string {
    const k = toBase58(this.d.slice(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  skip(n: number): void {
    this.o += n;
  }
  u8(): number {
    return this.d[this.o++]!;
  }
  u16(): number {
    const v = this.d[this.o]! | (this.d[this.o + 1]! << 8);
    this.o += 2;
    return v;
  }
  u64(): bigint {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.d[this.o + i]!);
    this.o += 8;
    return v;
  }
  i64(): number {
    return Number(BigInt.asIntN(64, this.u64()));
  }
}

export function decodeTable(data: Uint8Array): TableAccount {
  const r = new Reader(data);
  const host = r.key();
  const settlementAuthority = r.key();
  r.skip(32); // table_id
  return {
    host,
    settlementAuthority,
    buyInLamports: r.u64(),
    rakeBps: r.u16(),
    smallBlindChips: r.u64(),
    bigBlindChips: r.u64(),
    maxSeats: r.u8(),
    seatedCount: r.u8(),
    chipsInPlay: r.u64(),
    roundNonce: r.u64(),
    roundActive: r.u8() === 1,
    lastSettlementTs: r.i64(),
    pendingChipsInPlay: r.u64(),
  };
}

export function decodeSeat(data: Uint8Array): SeatAccount {
  const r = new Reader(data);
  return {
    table: r.key(),
    player: r.key(),
    chips: r.u64(),
    depositedLamports: r.u64(),
    rakePaidLamports: r.u64(),
    leaving: r.u8() === 1,
    lastActiveTs: r.i64(),
    pendingChips: r.u64(),
  };
}

/** The rake a buy-in pays on top (programs/poker-escrow compute_rake: floor(lamports × bps / 10,000)). */
export const rakeLamports = (buyInLamports: bigint, rakeBps: number): bigint => (buyInLamports * BigInt(rakeBps)) / 10_000n;

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

/** SystemProgram.transfer. */
export function systemTransfer(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  data[0] = 2; // Transfer
  for (let i = 0n; i < 8n; i++) data[4 + Number(i)] = Number((lamports >> (8n * i)) & 0xffn);
  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** The program error code inside an RPC error message ("custom program error: 0x1773"), or null. */
export function programErrorCode(message: string): number | null {
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(message) ?? /"Custom":\s*(\d+)/.exec(message);
  if (!m) return null;
  return m[0].startsWith('custom') ? parseInt(m[1]!, 16) : Number(m[1]);
}
