import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { PerIds, PerTableAddresses } from '../per/addresses';
import { PerHost } from '../per/host';
import { PerTourney } from '../per/tourney';
import { perIdl, type Entrant, type Ledger, type Tournament } from '../per/types';
import { PlayKey } from '../per/vault';
import { camel, type IdlType } from '../lib/idl';
import { at, expectIdlShape } from './idlShape';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const B = (s: string) => Buffer.from(s, 'utf8');
const le64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const pda = (program: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

const host = key(1).publicKey;
const wallet = key(2).publicKey;
const k = new PlayKey(key(3), wallet, 1_900_000_000n, new Uint8Array(64).fill(1), 2);
const tourney = PerTourney.address(host, 42n);

const entrant = (over: Partial<Entrant>): Entrant => ({
  wallet: new Uint8Array(32), reader: new Uint8Array(32), state: 1, table: 0, seat: 0, place: 0, pad: new Uint8Array(0), ...over,
});

describe('PerTourney rules', () => {
  it('constants from the C#', () => {
    expect([PerTourney.MAX_ENTRANTS, PerTourney.SEATS, PerTourney.MAX_TABLES, PerTourney.NO_TABLE, PerTourney.ENTRANT_PLAYING]).toEqual([30, 8, 5, 255, 1]);
    expect(PerTourney.START_STACK).toBe(5_000n);
    expect([PerTourney.REGISTERING, PerTourney.RUNNING, PerTourney.CANCELLED]).toEqual([0, 2, 5]);
  });

  it('small blinds: the table, then doubling from 1,500 (capped at 40 doublings)', () => {
    expect([0, 1, 5, 9].map(PerTourney.smallBlind)).toEqual([25n, 50n, 300n, 1_500n]);
    expect(PerTourney.smallBlind(-3)).toBe(25n);
    expect(PerTourney.smallBlind(10)).toBe(3_000n);
    expect(PerTourney.smallBlind(12)).toBe(12_000n);
    expect(PerTourney.smallBlind(100)).toBe(1_500n << 40n);
  });

  it('levels', () => {
    expect([0, 1, 2, 9].map(PerTourney.levelSeconds)).toEqual([300n, 480n, 720n, 480n]);
    const t = { runningSince: 1_000n, speed: PerTourney.REGULAR } as Tournament;
    expect(PerTourney.levelAt(t, 1_000 + 959)).toBe(1);
    expect(PerTourney.levelAt(t, 1_000 + 960)).toBe(2);
    expect(PerTourney.levelAt(t, 900)).toBe(0);
    expect(PerTourney.levelAt({ ...t, runningSince: 0n }, 99_999)).toBe(0);
  });

  it('payouts: 5% fee, 60/40 split', () => {
    expect(PerTourney.payouts(1_000_000n, 10, 500_000n)).toEqual({ first: 6_000_000n, second: 4_000_000n, fee: 500_000n });
    // fees 2331, fee floor(2331*500/10000)=116, pool 2215, second floor(2215*40/100)=886
    expect(PerTourney.payouts(333n, 7, 0n)).toEqual({ first: 1_329n, second: 886n, fee: 116n });
    expect([1, 8, 9, 16, 17, 30].map(PerTourney.tablesFor)).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it('names and code hashes', () => {
    const b = PerTourney.nameBytes('Friday Night ♠');
    expect(b.length).toBe(40);
    expect(PerTourney.nameOf({ name: b } as Tournament)).toBe('Friday Night ♠');
    expect(PerTourney.nameOf({ name: PerTourney.nameBytes('x'.repeat(50)) } as Tournament)).toBe('x'.repeat(40));
    const code = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const want = createHash('sha256').update(Buffer.concat([tourney.toBuffer(), code])).digest();
    expect(Buffer.from(PerTourney.codeHash(tourney, code)).equals(want)).toBe(true);
  });

  it('seatsToTake skips other tables, non-players and taken seats', () => {
    const t = {
      count: 4,
      entrants: [entrant({ seat: 3 }), entrant({ seat: 1 }), entrant({ seat: 2, table: 1 }), entrant({ seat: 5, state: 2 }), entrant({ seat: 6 })],
    } as Tournament;
    expect(PerTourney.seatsToTake(t, 0, null)).toEqual([3, 1]);
    const seats = Array.from({ length: 8 }, (_, i) => ({ player: i === 3 ? wallet.toBytes() : new Uint8Array(32), reader: new Uint8Array(32), stack: 0n, deposited: 0n, sittingOut: false }));
    expect(PerTourney.seatsToTake(t, 0, { seats } as Ledger)).toEqual([1]);
  });

  it('decodes a Tournament account', () => {
    expect(PerTourney.decode(null)).toBeNull();
    expect(PerTourney.decode(new Uint8Array(100))).toBeNull();
  });
});

describe('PerTourney instructions', () => {
  it('addresses', () => {
    expect(tourney.equals(pda(PerIds.program, B('tourney'), host.toBytes(), le64(42n)))).toBe(true);
    expect(PerTourney.tableAddress(tourney, 3).equals(pda(PerIds.program, B('table'), tourney.toBytes(), le64(3n)))).toBe(true);
    expect(PerTourney.tableAddress(tourney, 3).equals(PerHost.tableAddress(tourney, 3n))).toBe(true);
  });

  it('createAndDelegate and createTable', () => {
    const p = { name: PerTourney.nameBytes('T'), speed: 1, maxPlayers: 16, entryFee: 1_000_000n, startTs: 1_900_000_000n, codeHash: new Uint8Array(32) };
    const [cu, create, handOver] = PerTourney.createAndDelegate(host, 42n, p);
    expect([...cu!.data]).toEqual([2, 0x80, 0x1a, 0x06, 0x00]); // 400,000
    expectIdlShape(create!, 'create_tournament');
    expectIdlShape(handOver!, 'delegate_tournament');
    expect(at(handOver!, 'delegate_tournament', 'escape_payer').equals(PerHost.escapePayer(tourney))).toBe(true);
    const [ct, dt] = PerTourney.createTable(key(9).publicKey, host, 42n, 2);
    expectIdlShape(ct!, 'create_tourney_table');
    expect(Buffer.from(ct!.data.subarray(8)).equals(Buffer.concat([le64(42n), host.toBuffer(), le64(2n)]))).toBe(true);
    expectIdlShape(dt!, 'delegate_table');
    expect(Buffer.from(dt!.data.subarray(8)).equals(Buffer.concat([le64(2n), tourney.toBuffer()]))).toBe(true);
  });

  it('play-key instructions carry the check first', () => {
    const reader = key(5).publicKey;
    const [check, reg] = PerTourney.register(tourney, k, reader);
    expect(check!.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    expectIdlShape(reg!, 'tourney_register');
    expect(Buffer.from(reg!.data.subarray(8)).equals(Buffer.concat([le64(k.expires), reader.toBuffer(), Buffer.from([0])]))).toBe(true);
    const code = new Uint8Array(16).fill(9);
    expect(Buffer.from(PerTourney.register(tourney, k, reader, code)[1]!.data.subarray(8 + 8 + 32)).equals(Buffer.concat([Buffer.from([1]), code]))).toBe(true);
    expect(at(reg!, 'tourney_register', 'escrow').equals(PerTourney.escrow(tourney))).toBe(true);
    expectIdlShape(PerTourney.fund(tourney, k, 5n)[1]!, 'tourney_fund');
    expectIdlShape(PerTourney.leave(tourney, k)[1]!, 'tourney_leave');
    expectIdlShape(PerTourney.cancel(tourney, k)[1]!, 'tourney_cancel');
  });

  it('anyone instructions', () => {
    expectIdlShape(PerTourney.refund(tourney, wallet), 'tourney_refund');
    expectIdlShape(PerTourney.payout(tourney, wallet, host, key(8).publicKey), 'tourney_payout');
    expectIdlShape(PerTourney.link(tourney, 1), 'tourney_link_table');
    const s = PerTourney.start(tourney, wallet);
    expectIdlShape(s, 'tourney_start');
    expect(at(s, 'tourney_start', 'program_identity').equals(pda(PerIds.program, B('identity')))).toBe(true);
    expectIdlShape(PerTourney.sync(tourney, 1), 'tourney_sync');
  });

  it('seatTable appends each seat\'s hand and permission, sorted', () => {
    const ix = PerTourney.seatTable(tourney, 1, [5, 2]);
    expectIdlShape(ix, 'tourney_seat_table', 4);
    const t = new PerTableAddresses(PerTourney.tableAddress(tourney, 1));
    const extra = ix.keys.slice(-4);
    expect(extra.map((m) => m.pubkey.toBase58())).toEqual([t.hand(2), t.handPermission(2), t.hand(5), t.handPermission(5)].map((x) => x.toBase58()));
    expect(extra.every((m) => m.isWritable && !m.isSigner)).toBe(true);
  });

  it('setReader: optional table accounts are the program id unless seated', () => {
    const reader = key(6).publicKey;
    const loose = PerTourney.setReader(tourney, k, reader, -1, -1);
    expectIdlShape(loose, 'tourney_set_reader');
    for (const a of ['table', 'ledger', 'ledger_permission', 'hand', 'hand_permission']) expect(at(loose, 'tourney_set_reader', a).equals(PerIds.program)).toBe(true);
    const seated = PerTourney.setReader(tourney, k, reader, 2, 4);
    const t = new PerTableAddresses(PerTourney.tableAddress(tourney, 2));
    expect(at(seated, 'tourney_set_reader', 'hand').equals(t.hand(4))).toBe(true);
    expect(at(seated, 'tourney_set_reader', 'ledger_permission').equals(t.ledgerPermission)).toBe(true);
    expect(Buffer.from(seated.data.subarray(8)).equals(Buffer.concat([le64(k.expires), reader.toBuffer()]))).toBe(true);
  });

  it('decode round-trips through the IDL coder', () => {
    const t = defaultOf({ defined: { name: 'Tournament' } }) as Record<string, unknown>;
    t.name = PerTourney.nameBytes('Round trip');
    t.count = 1;
    t.entryFee = 123n;
    const data = perIdl.encodeAccount('Tournament', t);
    const back = PerTourney.decode(data)!;
    expect(PerTourney.nameOf(back)).toBe('Round trip');
    expect(back.entryFee).toBe(123n);
    expect(back.entrants.length).toBe(PerTourney.MAX_ENTRANTS);
    expect(back.tables.length).toBe(PerTourney.MAX_TABLES);
  });
});

/** A zero value for an IDL type (to build golden account data). */
function defaultOf(t: IdlType): unknown {
  if (typeof t === 'string') return ['u64', 'i64'].includes(t) ? 0n : t === 'bool' ? false : t === 'pubkey' ? new Uint8Array(32) : 0;
  if ('array' in t) return t.array[0] === 'u8' ? new Uint8Array(t.array[1]) : Array.from({ length: t.array[1] }, () => defaultOf(t.array[0]));
  if ('vec' in t) return [];
  if ('option' in t) return null;
  const def = perIdl.idl.types[t.defined.name]!;
  if (def.kind === 'enum') return 0;
  return Object.fromEntries(def.fields.map(([f, ft]) => [camel(f), defaultOf(ft)]));
}
