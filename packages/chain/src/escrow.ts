import { address, findProgramAddress, seed, type Address } from './pubkey';
import type { Instruction } from './transaction';

/**
 * The poker-escrow program's settlement-authority instructions (onchain/idl/poker_escrow.json), for the game server
 * hosting SOL tables (docs/phase-6-design.md). The player's own instructions (buy_in, rebuy, request_leave) stay in the
 * web client, signed by their wallet. Discriminators and account order come from the IDL; a test keeps them in step.
 */

export const ESCROW_PROGRAM_ID = 'GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo';
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

const DISCRIMINATORS = {
  create_table: [214, 142, 131, 250, 242, 83, 135, 185],
  begin_round: [209, 88, 27, 188, 15, 243, 202, 186],
  settle_round: [40, 101, 18, 1, 31, 129, 52, 77],
  cash_out: [1, 110, 57, 58, 159, 157, 243, 192],
  close_table: [149, 214, 44, 14, 190, 244, 132, 48],
} as const;
export type EscrowInstruction = keyof typeof DISCRIMINATORS;
export const escrowDiscriminators: Readonly<Record<EscrowInstruction, readonly number[]>> = DISCRIMINATORS;

/** At most this many chip deltas in one settle_round (the program's limit). */
export const MAX_DELTAS = 9;

/** UTF-8 of the table id in a zero-padded 32-byte field (PokerChain.TableIdToBytes). */
export function tableIdBytes(tableId: string): Uint8Array {
  const raw = new TextEncoder().encode(tableId);
  if (raw.length > 32) throw new Error(`table id over 32 bytes: ${tableId}`);
  const out = new Uint8Array(32);
  out.set(raw);
  return out;
}

class Writer {
  private readonly parts: number[] = [];
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]!);
    return this;
  }
  u8(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`u8 out of range: ${n}`);
    this.parts.push(n);
    return this;
  }
  u32(n: number): this {
    for (let i = 0; i < 4; i++) this.parts.push((n >>> (8 * i)) & 0xff);
    return this;
  }
  u64(v: bigint): this {
    if (v < 0n || v >= 1n << 64n) throw new Error(`u64 out of range: ${v}`);
    return this.le64(v);
  }
  i64(v: bigint): this {
    if (v < -(1n << 63n) || v >= 1n << 63n) throw new Error(`i64 out of range: ${v}`);
    return this.le64(BigInt.asUintN(64, v));
  }
  private le64(v: bigint): this {
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn));
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface ChipDelta {
  player: Address;
  chipDelta: bigint;
}

/** PDAs and instruction builders for one deployment of the program. */
export class EscrowAuthority {
  readonly programId: Address;

  constructor(programId: string = ESCROW_PROGRAM_ID, readonly authority: Address) {
    this.programId = address(programId);
  }

  config(): Address {
    return findProgramAddress([seed('config')], this.programId)[0];
  }
  table(tableId: string): Address {
    return findProgramAddress([seed('table'), tableIdBytes(tableId)], this.programId)[0];
  }
  vault(tableId: string): Address {
    return findProgramAddress([seed('vault'), tableIdBytes(tableId)], this.programId)[0];
  }
  seat(tableId: string, player: Address): Address {
    return findProgramAddress([seed('seat'), tableIdBytes(tableId), player], this.programId)[0];
  }

  private ix(keys: Instruction['keys'], data: Uint8Array): Instruction {
    return { programId: this.programId, keys, data };
  }

  /** The game server opens a table; it becomes the table's settlement authority and pays its rent. */
  createTable(tableId: string, host: Address, buyInLamports: bigint, smallBlindChips: bigint, bigBlindChips: bigint, maxSeats: number): Instruction {
    const data = new Writer().bytes(DISCRIMINATORS.create_table).bytes(tableIdBytes(tableId)).bytes(host).u64(buyInLamports).u64(smallBlindChips).u64(bigBlindChips).u8(maxSeats).done();
    return this.ix([
      { pubkey: this.authority, isSigner: true, isWritable: true },
      { pubkey: this.config(), isSigner: false, isWritable: false },
      { pubkey: this.table(tableId), isSigner: false, isWritable: true },
      { pubkey: this.vault(tableId), isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ], data);
  }

  beginRound(tableId: string): Instruction {
    return this.ix([
      { pubkey: this.authority, isSigner: true, isWritable: false },
      { pubkey: this.table(tableId), isSigner: false, isWritable: true },
    ], new Writer().bytes(DISCRIMINATORS.begin_round).bytes(tableIdBytes(tableId)).done());
  }

  /**
   * A hand's chip changes (zero sum, ≤ MAX_DELTAS); each player's seat PDA rides as a writable remaining account, in
   * delta order. `pendingOnly` adds the seats of players with a mid-hand buy-in and no delta: the program moves every
   * listed seat's pending chips into play and refuses to settle while any pending chips are left over.
   */
  settleRound(tableId: string, nonce: bigint, deltas: ChipDelta[], pendingOnly: Address[] = []): Instruction {
    if (deltas.length > MAX_DELTAS) throw new Error(`at most ${MAX_DELTAS} deltas`);
    if (deltas.reduce((s, d) => s + d.chipDelta, 0n) !== 0n) throw new Error('deltas must sum to zero');
    const w = new Writer().bytes(DISCRIMINATORS.settle_round).bytes(tableIdBytes(tableId)).u64(nonce).u32(deltas.length);
    for (const d of deltas) w.bytes(d.player).i64(d.chipDelta);
    return this.ix([
      { pubkey: this.authority, isSigner: true, isWritable: false },
      { pubkey: this.table(tableId), isSigner: false, isWritable: true },
      { pubkey: this.vault(tableId), isSigner: false, isWritable: false },
      ...deltas.map((d) => ({ pubkey: this.seat(tableId, d.player), isSigner: false, isWritable: true })),
      ...pendingOnly.map((p) => ({ pubkey: this.seat(tableId, p), isSigner: false, isWritable: true })),
    ], w.done());
  }

  /** Pays a seat out to the player's wallet (the authority may do it for them). */
  cashOut(tableId: string, player: Address): Instruction {
    return this.ix([
      { pubkey: this.authority, isSigner: true, isWritable: true },
      { pubkey: this.table(tableId), isSigner: false, isWritable: true },
      { pubkey: this.vault(tableId), isSigner: false, isWritable: true },
      { pubkey: this.seat(tableId, player), isSigner: false, isWritable: true },
      { pubkey: player, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ], new Writer().bytes(DISCRIMINATORS.cash_out).bytes(tableIdBytes(tableId)).done());
  }

  closeTable(tableId: string): Instruction {
    return this.ix([
      { pubkey: this.authority, isSigner: true, isWritable: true },
      { pubkey: this.table(tableId), isSigner: false, isWritable: true },
      { pubkey: this.vault(tableId), isSigner: false, isWritable: true },
    ], new Writer().bytes(DISCRIMINATORS.close_table).bytes(tableIdBytes(tableId)).done());
  }
}
