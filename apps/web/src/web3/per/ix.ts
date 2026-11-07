/**
 * Instructions a client sends to a poker-per table. Port of Per/Core/PerIx.cs: account lists come from the IDL
 * (order, writable, signer, fixed addresses); this file only supplies the per-table ones.
 */
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { IDS } from '../config';
import { u32le } from '../lib/bytes';
import { ataOf, PerIds, type PerTableAddresses } from './addresses';
import { perIdl } from './types';

/**
 * Resolves an IDL account list: fixed addresses from the IDL, the rest from `named`. An Anchor optional account
 * that's absent is passed as the program id (PerIx.Build / PerVault.Build).
 */
export function buildPerIx(name: string, args: Record<string, unknown>, named: Record<string, PublicKey>, optionalAbsent: string[] = []): TransactionInstruction {
  const keys: AccountMeta[] = [];
  for (const a of perIdl.ixAccounts(name)) {
    if (optionalAbsent.includes(a.name)) {
      keys.push({ pubkey: PerIds.program, isSigner: false, isWritable: false });
      continue;
    }
    const key = a.addr ? new PublicKey(a.addr) : named[a.name];
    if (!key) throw new Error(`no address for account '${a.name}'`);
    keys.push({ pubkey: key, isSigner: !!a.s, isWritable: !!a.w });
  }
  return new TransactionInstruction({ programId: PerIds.program, keys, data: toBuffer(perIdl.encodeIx(name, args)) });
}

/** web3.js wants a Buffer-ish; a Uint8Array subclass works at runtime, typed as Buffer for its signature. */
export const toBuffer = (b: Uint8Array): Buffer => b as unknown as Buffer;

const handAccounts = (t: PerTableAddresses): Record<string, PublicKey> => ({
  'hand.table': t.table, 'hand.ledger': t.ledger, 'hand.deck': t.deck, 'hand.record': t.record, 'hand.log': t.log,
});

export const PerIx = {
  /** Sit down (or rebuy) with `amount` base units of wSOL; `reader` is the seat's session key (pre-M9 wallet buy-in). */
  buyIn: (t: PerTableAddresses, player: PublicKey, seat: number, amount: bigint, reader: PublicKey) =>
    buildPerIx('buy_in', { seat, amount, reader: reader.toBytes() }, {
      player, config: t.config, table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
      hand: t.hand(seat), hand_permission: t.handPermission(seat), player_token: ataOf(player), escrow: t.escrow,
    }, ['invites']),

  cashOut: (t: PerTableAddresses, player: PublicKey, seat: number) =>
    buildPerIx('cash_out', { seat }, {
      player, table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission, hand: t.hand(seat),
      hand_permission: t.handPermission(seat), player_token: ataOf(player), escrow: t.escrow,
    }),

  /** `signer` is the seat's wallet or its session (reader) key. */
  commitSeed: (t: PerTableAddresses, signer: PublicKey, seat: number, seed: Uint8Array) =>
    buildPerIx('commit_seed', { seat, seed }, { player: signer, table: t.table, deck: t.deck, hand: t.hand(seat) }),

  /** M10: take back this seat's committed seed and mark it sitting out (between hands). */
  sitOut: (t: PerTableAddresses, signer: PublicKey, seat: number) =>
    buildPerIx('sit_out', { seat }, { player: signer, table: t.table, deck: t.deck, ledger: t.ledger, hand: t.hand(seat) }),

  /** M10: clear this seat's sitting-out mark (any time). */
  sitIn: (t: PerTableAddresses, signer: PublicKey, seat: number) =>
    buildPerIx('sit_in', { seat }, { player: signer, table: t.table, ledger: t.ledger, hand: t.hand(seat) }),

  /** M10: the host's Start round. */
  requestStart: (t: PerTableAddresses, signer: PublicKey) =>
    buildPerIx('request_start', {}, { player: signer, table: t.table, ledger: t.ledger }),

  startHand: (t: PerTableAddresses, payer: PublicKey) =>
    buildPerIx('start_hand', {}, { payer, config: t.config, table: t.table, deck: t.deck, ledger: t.ledger, program_identity: t.vrfIdentity }),

  /** `kind` is the engine action (Fold..AllIn); for Bet/Raise `amount` is the total the seat's bet becomes. */
  act: (t: PerTableAddresses, signer: PublicKey, seat: number, kind: number, amount: bigint) =>
    buildPerIx('act', { seat, kind, amount }, { ...handAccounts(t), signer }),

  timeout: (t: PerTableAddresses, signer: PublicKey) => buildPerIx('timeout', {}, { ...handAccounts(t), signer }),

  tick: (t: PerTableAddresses) => buildPerIx('tick', {}, { ...handAccounts(t), log_permission: t.logPermission }),

  /** Compute budget for an instruction that may run a showdown (as the keeper sets for `tick`). */
  PLAY_CU: 1_400_000,
  computeLimit(units: number): TransactionInstruction {
    const d = new Uint8Array(5);
    d[0] = 2;
    d.set(u32le(units), 1);
    return new TransactionInstruction({ programId: new PublicKey(IDS.computeBudget), keys: [], data: toBuffer(d) });
  },

  /** The program's error for a rollup error code (the rollup returns no logs). */
  errorText: (code: number) => perIdl.errorText(code),
};
