/**
 * Addresses for one poker-per table: the program's PDAs, MagicBlock's permission PDAs and the wSOL token accounts.
 * Port of Per/Core/PerAddresses.cs (PerIds + PerTableAddresses).
 */
import { PublicKey } from '@solana/web3.js';
import { IDS } from '../config';
import { utf8 } from '../lib/bytes';

/** PerIds. `program` is the test or live program (config.perProgram), set once by the web3 module's install. */
export const PerIds = {
  program: new PublicKey(IDS.perTestProgram),
  teeValidator: new PublicKey(IDS.teeValidator),
  permissionProgram: new PublicKey(IDS.permissionProgram),
  delegationProgram: new PublicKey(IDS.delegationProgram),
  esplProgram: new PublicKey(IDS.esplProgram),
  tokenProgram: new PublicKey(IDS.tokenProgram),
  associatedTokenProgram: new PublicKey(IDS.associatedTokenProgram),
  nativeMint: new PublicKey(IDS.nativeMint),
  systemProgram: new PublicKey(IDS.systemProgram),
};

export function setPerProgram(id: string): void {
  PerIds.program = new PublicKey(id);
}

/** PublicKey.TryFindProgramAddress (throws when no bump works, as the C# does). */
export function findPda(program: PublicKey, ...seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}

/** MagicBlock's permission PDA for an account: ["permission:", account] under the permission program. */
export const permissionOf = (account: PublicKey): PublicKey => findPda(PerIds.permissionProgram, utf8('permission:'), account.toBytes());

/** Associated token account (classic SPL Token program). */
export const ataOf = (owner: PublicKey, mint: PublicKey = PerIds.nativeMint): PublicKey =>
  findPda(PerIds.associatedTokenProgram, owner.toBytes(), PerIds.tokenProgram.toBytes(), mint.toBytes());

/** Every address a client needs for one table (PerTableAddresses). */
export class PerTableAddresses {
  readonly ledger: PublicKey;
  readonly deck: PublicKey;
  readonly record: PublicKey;
  readonly log: PublicKey;
  readonly escrow: PublicKey;
  readonly ledgerPermission: PublicKey;
  readonly logPermission: PublicKey;
  readonly config: PublicKey;
  readonly vrfIdentity: PublicKey;

  constructor(readonly table: PublicKey) {
    const pda = (tag: string) => findPda(PerIds.program, utf8(tag), table.toBytes());
    this.ledger = pda('ledger');
    this.deck = pda('deck');
    this.record = pda('record');
    this.log = pda('log');
    this.escrow = ataOf(table);
    this.ledgerPermission = permissionOf(this.ledger);
    this.logPermission = permissionOf(this.log);
    this.config = perConfigAddress();
    this.vrfIdentity = findPda(PerIds.program, utf8('identity'));
  }

  hand(seat: number): PublicKey {
    return findPda(PerIds.program, utf8('hand'), this.table.toBytes(), Uint8Array.of(seat));
  }

  handPermission(seat: number): PublicKey {
    return permissionOf(this.hand(seat));
  }
}

export const perConfigAddress = (): PublicKey => findPda(PerIds.program, utf8('config'));
