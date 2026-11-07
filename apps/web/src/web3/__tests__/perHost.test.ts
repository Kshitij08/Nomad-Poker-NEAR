import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { PerIds, PerTableAddresses } from '../per/addresses';
import { PerHost } from '../per/host';
import { PerHostedTables } from '../per/hostedTables';
import { PerInvites } from '../per/invites';
import { STAKES } from '../per/money';
import { PlayKey } from '../per/vault';
import { at, expectIdlShape } from './idlShape';
import { installMemoryStorage } from './memoryStorage';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const B = (s: string) => Buffer.from(s, 'utf8');
const le64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const sha = (...parts: Uint8Array[]) => new Uint8Array(createHash('sha256').update(Buffer.concat(parts)).digest());
const pda = (program: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

const creator = key(1).publicKey;
const wallet = key(2).publicKey;
const hostKp = key(3);
const playKey = new PlayKey(hostKp, creator, 1_800_000_000n, new Uint8Array(64).fill(7), 0);
const id = 0x0123456789abcdefn;

describe('PerHost', () => {
  it('derives the C# PDAs', () => {
    const table = PerHost.tableAddress(creator, id);
    expect(table.equals(pda(PerIds.program, B('table'), creator.toBytes(), le64(id)))).toBe(true);
    expect(PerHost.escapePayer(table).equals(pda(PerIds.program, B('escape-payer'), table.toBytes()))).toBe(true);
    expect(PerHost.invitesAddress(table).equals(pda(PerIds.program, B('invites'), table.toBytes()))).toBe(true);
    expect(PerHost.privateInvitesAddress(table).equals(pda(PerIds.program, B('invites_p'), table.toBytes()))).toBe(true);
  });

  it('constants and stakes', () => {
    expect([PerHost.MIN_SEATS, PerHost.MAX_SEATS, PerHost.MAX_INVITES, PerHost.CREATE_AND_DELEGATE_CU]).toEqual([2, 8, 16, 500_000]);
    expect(PerHost.STAKES).toBe(STAKES);
    expect(PerHost.minBuyIn(0)).toBe(5_000_000n); // max(10 * 200000, 50 * 100000)
    expect(PerHost.maxBuyIn(4)).toBe(1_000_000_000n); // min(100 * 25M, cap)
    const ids = new Set([PerHost.newTableId(), PerHost.newTableId()]);
    expect(ids.size).toBe(2);
    for (const v of ids) expect(v >= 0n && v < 1n << 64n).toBe(true);
    expect(PerHost.newInviteCode().length).toBe(16);
  });

  it('hashes invites as the C# byte layout', () => {
    const table = PerHost.tableAddress(creator, id);
    const code = Uint8Array.from({ length: 16 }, (_, i) => i * 7);
    expect(PerHost.inviteCodeHash(table, code)).toEqual(sha(B('invite-code'), table.toBytes(), code));
    const h = sha(table.toBytes(), wallet.toBytes());
    expect(PerHost.inviteHash(table, wallet)).toEqual(h);
    expect(PerHost.privateInviteEntry(table, wallet)).toEqual(h.slice(0, 16));
    const inv = { table: table.toBytes(), count: 2, hashes: [new Uint8Array(32), h, sha(B('x'))] };
    expect(PerHost.isInvited(inv, table, wallet)).toBe(true);
    expect(PerHost.isInvited({ ...inv, count: 1 }, table, wallet)).toBe(false);
    expect(PerHost.isInvited(null, table, wallet)).toBe(false);
  });

  it('createAndDelegate: compute budget, create_table, delegate_table', () => {
    const p = { smallBlind: 100_000n, bigBlind: 200_000n, minBuyIn: 5_000_000n, maxBuyIn: 20_000_000n, maxSeats: 6, inviteOnly: true };
    const [cu, create, handOver] = PerHost.createAndDelegate(creator, id, p);
    expect([...cu!.data]).toEqual([2, 0x20, 0xa1, 0x07, 0x00]);
    expectIdlShape(create!, 'create_table');
    const table = PerHost.tableAddress(creator, id);
    expect(at(create!, 'create_table', 'table').equals(table)).toBe(true);
    const eata = pda(PerIds.esplProgram, table.toBytes(), PerIds.nativeMint.toBytes());
    expect(at(create!, 'create_table', 'escrow_eata').equals(eata)).toBe(true);
    expect(at(create!, 'create_table', 'escrow_delegation_record').equals(pda(PerIds.delegationProgram, B('delegation'), eata.toBytes()))).toBe(true);
    const params = Buffer.concat([le64(id), le64(100_000n), le64(200_000n), le64(5_000_000n), le64(20_000_000n), Buffer.from([6, 1])]);
    expect(Buffer.from(create!.data.subarray(8)).equals(params)).toBe(true);
    expectIdlShape(handOver!, 'delegate_table');
    expect(Buffer.from(handOver!.data.subarray(8)).equals(Buffer.concat([le64(id), creator.toBuffer()]))).toBe(true);
    expect(at(handOver!, 'delegate_table', 'buffer_table').equals(pda(PerIds.program, B('buffer'), table.toBytes()))).toBe(true);
    expect(at(handOver!, 'delegate_table', 'escape_payer').equals(PerHost.escapePayer(table))).toBe(true);
  });

  it('setInvitesKeyedSteps: create the list, then the data', () => {
    const t = new PerTableAddresses(PerHost.tableAddress(creator, id));
    const code = sha(B('code'));
    const [first, second] = PerHost.setInvitesKeyedSteps(t, playKey, [wallet], code);
    expectIdlShape(first!, 'set_invites_keyed');
    expect(Buffer.from(first!.data.subarray(8)).equals(Buffer.concat([le64(playKey.expires), Buffer.from([0, 0])]))).toBe(true);
    const entry = PerHost.privateInviteEntry(t.table, wallet);
    const want = Buffer.concat([le64(playKey.expires), Buffer.from([1, 1, 0, 0, 0]), entry, Buffer.from([1]), code]);
    expect(Buffer.from(second!.data.subarray(8)).equals(want)).toBe(true);
    const inv = PerHost.privateInvitesAddress(t.table);
    expect(at(second!, 'set_invites_keyed', 'invites').equals(inv)).toBe(true);
    expect(at(second!, 'set_invites_keyed', 'play_key').equals(hostKp.publicKey)).toBe(true);
    expect(at(second!, 'set_invites_keyed', 'wallet_state').equals(pda(PerIds.program, B('wallet'), creator.toBytes()))).toBe(true);
  });

  it('setInvites, closeInvites, open, reclaim', () => {
    const table = PerHost.tableAddress(creator, id);
    const s = PerHost.setInvites(creator, id, [wallet]);
    expectIdlShape(s, 'set_invites');
    expect(Buffer.from(s.data.subarray(8)).equals(Buffer.concat([le64(id), Buffer.from([1, 0, 0, 0]), sha(table.toBytes(), wallet.toBytes())]))).toBe(true);
    expectIdlShape(PerHost.closeInvites(creator, id), 'close_invites');
    const t = new PerTableAddresses(table);
    const o = PerHost.open(t, wallet);
    expectIdlShape(o, 'open_table');
    expect(o.data.length).toBe(8);
    const r = PerHost.reclaim(creator, id);
    expectIdlShape(r, 'reclaim_table');
    expect(at(r, 'reclaim_table', 'escape_payer').equals(PerHost.escapePayer(table))).toBe(true);
  });

  it('closeKeyed names the host vault only when it exists', () => {
    const t = new PerTableAddresses(PerHost.tableAddress(creator, id));
    const dev = key(9).publicKey;
    const withVault = PerHost.closeKeyed(t, playKey, dev);
    expectIdlShape(withVault, 'close_table_keyed');
    expect(at(withVault, 'close_table_keyed', 'creator_vault_token').equals(PerIds.program)).toBe(false);
    expect(at(withVault, 'close_table_keyed', 'magic_fee_vault').equals(pda(PerIds.delegationProgram, B('magic-fee-vault'), PerIds.teeValidator.toBytes()))).toBe(true);
    const noVault = PerHost.closeKeyed(t, playKey, dev, false);
    expect(at(noVault, 'close_table_keyed', 'creator_vault_token').equals(PerIds.program)).toBe(true);
    expect(Buffer.from(noVault.data.subarray(8)).equals(le64(playKey.expires))).toBe(true);
  });
});

describe('PerInvites and PerHostedTables', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installMemoryStorage();
    PerInvites.resetForTests();
  });
  const table = PerHost.tableAddress(creator, id);

  it('keeps codes under the C# keys', () => {
    const code = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);
    expect(PerInvites.hostCode(table)).toBeNull();
    PerInvites.setHostCode(table, code);
    expect(store.get(`per.invite.host.${table.toBase58()}`)).toBe('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
    expect(PerInvites.hostCode(table)).toEqual(code);
    store.set(`per.invite.join.${table.toBase58()}`, 'abc');
    expect(PerInvites.joinCode(table)).toBeNull();
    PerInvites.forget(table);
    expect(store.size).toBe(0);
  });

  it('builds and reads links', () => {
    const code = new Uint8Array(16).fill(0xab);
    const link = PerInvites.link(table, code, 'https://game.test/play/?x=1#y');
    expect(link).toBe(`https://game.test/play/#table=${table.toBase58()}&invite=${'ab'.repeat(16)}`);
    expect(PerInvites.readLinkOnce(link)).toBe(true);
    expect(PerInvites.linkedTable?.equals(table)).toBe(true);
    expect(PerInvites.joinCode(table)).toEqual(code);
    expect(PerInvites.readLinkOnce(link)).toBe(false); // once
    PerInvites.resetForTests();
    expect(PerInvites.readLinkOnce(`https://g.test/?table=${table.toBase58()}&invite=${'cd'.repeat(16)}`)).toBe(true);
    PerInvites.resetForTests();
    expect(PerInvites.readLinkOnce(`https://g.test/?table=${table.toBase58()}`)).toBe(false);
  });

  it('hosted tables: add, upsert, remove, gone', () => {
    const t2 = PerHost.tableAddress(creator, 2n);
    PerHostedTables.add(wallet, table, id);
    PerHostedTables.add(wallet, t2, 2n);
    PerHostedTables.add(wallet, table, id); // moves to the end
    expect(store.get(`per.hosted.${wallet.toBase58()}`)).toBe(`${t2.toBase58()}:2,${table.toBase58()}:${id}`);
    store.set(`per.hosted.${wallet.toBase58()}`, store.get(`per.hosted.${wallet.toBase58()}`)! + ',junk:1,bad');
    expect(PerHostedTables.for(wallet).map((x) => x.id)).toEqual([2n, id]);
    PerInvites.setHostCode(table, new Uint8Array(16));
    PerHostedTables.markGone(wallet, table);
    expect(PerHostedTables.isGone(wallet, table)).toBe(true);
    expect(PerHostedTables.for(wallet).map((x) => x.id)).toEqual([2n]);
    expect(PerInvites.hostCode(table)).toBeNull();
    expect(store.get(`per.hosted.gone.${wallet.toBase58()}`)).toBe(table.toBase58());
  });
});
