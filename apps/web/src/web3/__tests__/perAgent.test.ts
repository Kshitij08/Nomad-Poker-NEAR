import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { fromBase64, utf8 } from '../lib/bytes';
import type { PerHttp } from '../lib/http';
import { PerIds, PerTableAddresses, permissionOf } from '../per/addresses';
import { AgentState, NO_PER_BACKEND, PerAgent } from '../per/agent';
import { PlayKey, walletStateOf } from '../per/vault';
import { at, expectIdlShape } from './idlShape';

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const B = (s: string) => Buffer.from(s, 'utf8');
const pda = (program: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
const le = (v: bigint, n: number) => {
  const b = Buffer.alloc(n);
  if (n === 8) b.writeBigInt64LE(BigInt.asIntN(64, v));
  else if (n === 4) b.writeUInt32LE(Number(v));
  else b.writeUInt16LE(Number(v));
  return b;
};

const wallet = key(1).publicKey;
const k = new PlayKey(key(2), wallet, 1_850_000_000n, new Uint8Array(64).fill(3), 4);
const t = new PerTableAddresses(key(7).publicKey);

describe('PerAgent', () => {
  it('addresses', () => {
    expect(PerAgent.stateAddress(wallet).equals(pda(PerIds.program, B('agent2'), wallet.toBytes()))).toBe(true);
    expect(PerAgent.sponsor.equals(pda(PerIds.program, B('agent-sponsor')))).toBe(true);
    expect(PerAgent.hostTab(wallet).equals(pda(PerIds.program, B('host-tab'), wallet.toBytes()))).toBe(true);
  });

  it('decodes the v2 record at the pinned offsets', () => {
    const agent = key(4).publicKey, table = key(5).publicKey, reader = key(6).publicKey, creator = key(8).publicKey;
    const d = Buffer.concat([
      Buffer.alloc(8), wallet.toBuffer(), agent.toBuffer(), le(1_700_000_000n, 8), le(9n, 4), le(5_000_000n, 8), le(1_000n, 8),
      table.toBuffer(), Buffer.from([3]), reader.toBuffer(), Buffer.from([254]), creator.toBuffer(), le(1000n, 2), le(500n, 2),
      le(11n, 8), le(12n, 8), le(13n, 8), le(-14n, 8), Buffer.alloc(20),
    ]);
    expect(d.length).toBe(254);
    expect(AgentState.decode(new Uint8Array(d.subarray(0, 253)))).toBeNull();
    const s = AgentState.decode(new Uint8Array(d))!;
    expect(s.wallet.equals(wallet) && s.agent.equals(agent) && s.table.equals(table) && s.reader.equals(reader) && s.creator.equals(creator)).toBe(true);
    expect([s.expires, s.keySet, s.stake, s.committed, s.seat, s.creatorFeeBps, s.platformFeeBps]).toEqual([1_700_000_000n, 9, 5_000_000n, 1_000n, 3, 1000, 500]);
    expect([s.seatIn, s.netIn, s.netOut, s.highWater]).toEqual([11n, 12n, 13n, -14n]);
    expect(s.hasSeat && s.copying && s.running(1_699_999_999) && !s.running(1_700_000_000)).toBe(true);
  });

  it('set / stop / close', () => {
    const agent = key(4).publicKey;
    const terms = PerAgent.terms(key(8).publicKey, 1000, 250);
    const [check, set] = PerAgent.set(k, agent, 1_860_000_000n, 7_000_000n, terms);
    expect(check!.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111');
    expectIdlShape(set!, 'agent_set');
    const args = Buffer.concat([le(k.expires, 8), agent.toBuffer(), le(1_860_000_000n, 8), le(7_000_000n, 8), key(8).publicKey.toBuffer(), le(1000n, 2), le(250n, 2)]);
    expect(Buffer.from(set!.data.subarray(8)).equals(args)).toBe(true);
    const state = PerAgent.stateAddress(wallet);
    expect(at(set!, 'agent_set', 'agent_permission').equals(permissionOf(state))).toBe(true);
    const stop = PerAgent.stop(k)[1]!;
    expect(Buffer.from(stop.data.subarray(8)).equals(Buffer.concat([le(k.expires, 8), Buffer.alloc(32), le(0n, 8), le(0n, 8), Buffer.alloc(36)]))).toBe(true);
    expectIdlShape(PerAgent.close(k)[1]!, 'agent_close');
  });

  it('seats: buy-in, cash-out (optional fee accounts), release, sponsor', () => {
    const bi = PerAgent.buyIn(t, key(4).publicKey, wallet, 2, 1_000n, key(6).publicKey);
    expectIdlShape(bi, 'agent_buy_in');
    expect(at(bi, 'agent_buy_in', 'invites').equals(PerIds.program)).toBe(true);
    expect(at(bi, 'agent_buy_in', 'hand').equals(t.hand(2))).toBe(true);
    const plain = PerAgent.cashOut(t, key(4).publicKey, wallet, 2);
    expectIdlShape(plain, 'agent_cash_out');
    for (const a of ['creator_wallet_state', 'creator_vault_token', 'treasury_wallet_state', 'treasury_vault_token']) expect(at(plain, 'agent_cash_out', a).equals(PerIds.program)).toBe(true);
    const creator = key(8).publicKey;
    const copied = PerAgent.leaveAgentSeat(k, t, 2, creator, key(9).publicKey);
    expect(at(copied, 'agent_cash_out', 'signer').equals(k.key.publicKey)).toBe(true);
    expect(at(copied, 'agent_cash_out', 'creator_wallet_state').equals(walletStateOf(creator))).toBe(true);
    expectIdlShape(PerAgent.release(t, wallet), 'agent_release');
    const [cs, ds] = PerAgent.createSponsor(key(10).publicKey, 1_000_000n);
    expectIdlShape(cs!, 'create_agent_sponsor');
    expectIdlShape(ds!, 'delegate_agent_sponsor');
  });

  it('payHostFee uses the nested pay.* accounts', () => {
    const host = key(11).publicKey;
    const [, ix] = PerAgent.payHostFee(k, 20_000n, host);
    expectIdlShape(ix!, 'pay_host_fee');
    expect(at(ix!, 'pay_host_fee', 'pay.host_tab').equals(PerAgent.hostTab(wallet))).toBe(true);
    expect(at(ix!, 'pay_host_fee', 'pay.host_wallet_state').equals(walletStateOf(host))).toBe(true);
    expect(at(ix!, 'pay_host_fee', 'pay.sponsor').equals(PerAgent.sponsor)).toBe(true);
  });

  it('signedRequest: the play key signs "nomad-agent|path|ts|body"', () => {
    const s = PerAgent.signedRequest(k, '/agents/me', { stake: 2 }, 1_800_000_123);
    expect(s).toContain('"expires":1850000000,');
    const j = JSON.parse(s);
    expect(j).toMatchObject({ wallet: wallet.toBase58(), playKey: k.key.publicKey.toBase58(), keySet: 4, ts: 1_800_000_123, data: '{"stake":2}' });
    expect(fromBase64(j.walletSig)).toEqual(k.signature);
    expect(ed25519.verify(fromBase64(j.sig), utf8('nomad-agent|/agents/me|1800000123|{"stake":2}'), k.key.publicKey.toBytes())).toBe(true);
    expect(JSON.parse(PerAgent.signedRequest(k, '/x')).data).toBe('{}');
  });

  it('call: errors as the C#', async () => {
    const posts: string[] = [];
    const http = (status: number, body: string): PerHttp => ({
      get: async () => ({ status, body }),
      post: async (url) => (posts.push(url), { status, body }),
      delay: async () => {},
    });
    await expect(PerAgent.call(http(200, '{}'), '', k, '/agents/me')).rejects.toThrow(NO_PER_BACKEND);
    expect(posts.length).toBe(0);
    await expect(PerAgent.call(http(200, '{"ok":1}'), 'http://localhost:8787', k, '/agents/me')).resolves.toEqual({ ok: 1 });
    expect(posts).toEqual(['http://localhost:8787/agents/me']);
    await expect(PerAgent.call(http(400, '{"error":"nope"}'), 'http://b', k, '/x')).rejects.toThrow('nope');
    await expect(PerAgent.call(http(500, '{}'), 'http://b', k, '/x')).rejects.toThrow('Agent service: HTTP 500');
    await expect(PerAgent.call(http(502, '<html>'), 'http://b', k, '/x')).rejects.toThrow('Agent service: HTTP 502');
  });
});
