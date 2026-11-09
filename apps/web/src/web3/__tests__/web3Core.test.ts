/**
 * The web3 module's pure parts: network policy, PER instruction lists against the IDL,
 * the betting-panel legality port, and the seat rotation the PER table uses.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { makeConfig, assertAllowedUrl, NetworkPolicyError, DEPLOYED } from '../config';
import { PerTableAddresses } from '../per/addresses';
import { PerIx } from '../per/ix';
import { PerGame } from '../per/legal';
import { perIdl } from '../per/types';
import { RotatedView } from '../per/perTableController';
import type { TableViewPort } from '@nomad/engine';

describe('network policy (config.ts)', () => {
  it('defaults to devnet with no backends, refuses mainnet and deployed servers', () => {
    const cfg = makeConfig(new URLSearchParams());
    expect(cfg.cluster).toBe('devnet');
    expect(cfg.gameBackendUrl).toBe('');
    expect(cfg.perBackendUrl).toBe('');
    expect(() => assertAllowedUrl(cfg, 'https://api.mainnet-beta.solana.com')).toThrow(NetworkPolicyError);
    expect(() => assertAllowedUrl(cfg, DEPLOYED.gameBackend + '/api/config')).toThrow(NetworkPolicyError);
    expect(() => assertAllowedUrl(cfg, 'https://api.devnet.solana.com')).not.toThrow();
    expect(() => assertAllowedUrl(cfg, 'http://localhost:8787/api/me')).not.toThrow();
  });
  it('?perprogram=nomad: the new stack PER instance and its own service, no ?web3deployed=1 needed', () => {
    const c = makeConfig(new URLSearchParams('perprogram=nomad'));
    expect(c.perProgram).toBe('7LcbAnHBFHkviM6AhGgmm871VYNkTU8HTt2bTWVWLKBn');
    expect(c.perBackendUrl).toBe('https://nomad-poker-per-staging.kshitijiitgn.workers.dev');
    expect(c.perIsTestProgram).toBe(true);
    expect(c.allowDeployed).toBe(false);
    // The other two are unchanged.
    expect(makeConfig(new URLSearchParams()).perProgram).toBe('4A3DZW5zvmG6v6C47UqooVbnTvNtgRQJ5fKDMZ62FNMZ');
    expect(makeConfig(new URLSearchParams('perprogram=live&web3deployed=1')).perProgram).toBe('7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv');
  });

  it('?web3backend= names a local backend; ?web3deployed=1 is the only way to the Railway servers', () => {
    expect(makeConfig(new URLSearchParams('web3backend=http://localhost:8787/')).gameBackendUrl).toBe('http://localhost:8787');
    const live = makeConfig(new URLSearchParams('web3deployed=1'));
    expect(live.gameBackendUrl).toBe(DEPLOYED.gameBackend);
    expect(() => assertAllowedUrl(live, DEPLOYED.gameBackend)).not.toThrow();
  });
});

describe('poker-per instructions (Per/Core/PerIx.cs)', () => {
  it('act: IDL account order, signer first, discriminator + seat/kind/amount', () => {
    const t = new PerTableAddresses(Keypair.generate().publicKey);
    const signer = Keypair.generate().publicKey;
    const ix = PerIx.act(t, signer, 3, 4, 123_456n);
    const idlAccounts = perIdl.ixAccounts('act');
    expect(ix.keys.length).toBe(idlAccounts.length);
    expect(ix.keys[0]!.pubkey.equals(signer) && ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(t.table)).toBe(true);
    expect([...ix.data.subarray(0, 8)]).toEqual(perIdl.idl.instructions.act!.d);
    expect([ix.data[8], ix.data[9]]).toEqual([3, 4]);
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(10, true)).toBe(123_456n);
  });
  it('compute budget: SetComputeUnitLimit (tag 2, u32 LE)', () => {
    expect([...PerIx.computeLimit(1_400_000).data]).toEqual([2, 0xc0, 0x5c, 0x15, 0x00]);
  });
});

describe('PerGame.legal (engine.rs legal)', () => {
  const seat = (stack: bigint, currentBet = 0n, status = PerGame.Active) => ({ status, stack, currentBet, total: currentBet, hasActed: false });
  const game = (seats: ReturnType<typeof seat>[], toAct: number, highBet: bigint) => ({
    seatCount: seats.length, smallBlind: 1n, bigBlind: 2n, seats, button: 0, sbSeat: 0, bbSeat: 1, currentSeat: toAct, toAct, street: 1,
    highBet, minRaise: 2n, pot: 3n, runout: false, board: new Uint8Array(5), boardLen: 0,
  });
  it('facing the big blind: call 1, raise from 4, all-in', () => {
    const l = PerGame.legal(game([seat(99n, 1n), seat(98n, 2n)], 0, 2n));
    expect([l.canCheck, l.canCall, l.callAmount, l.canRaise, l.minRaiseTo, l.maxRaiseTo, l.canAllIn]).toEqual([false, true, 1, true, 4, 100, true]);
  });
  it('nobody else can act: no raise, no all-in over a call', () => {
    const l = PerGame.legal(game([seat(99n, 1n), seat(0n, 50n, PerGame.AllIn)], 0, 50n));
    expect([l.canCall, l.canRaise, l.canAllIn]).toEqual([true, false, false]);
  });
});

describe('RotatedView (TableView.SetLocalPerspective)', () => {
  it('puts the local seat in slot 0, rotating mod the 8 seat views', () => {
    const calls: number[] = [];
    const inner = { seatCount: 8, betting: null, hideSeat: (s: number) => calls.push(s) } as unknown as TableViewPort;
    const v = new RotatedView(inner);
    v.offset = 3;
    for (let s = 0; s < 9; s++) v.hideSeat(s);
    // seat 3 → 0, 4 → 1, … 0 → 5, 1 → 6, 2 → 7; seat 8 has no view
    expect(calls).toEqual([5, 6, 7, 0, 1, 2, 3, 4]);
  });
});

describe('IDL coder', () => {
  it('round-trips a Table account and rejects another discriminator', () => {
    const creator = new PublicKey(Keypair.generate().publicKey.toBytes());
    const enc = perIdl.encodeAccount('WalletState', { wallet: creator.toBytes(), keySet: 3, vaultSeed: new Uint8Array(8).fill(9) });
    expect(perIdl.decodeAccount<{ keySet: number }>('WalletState', enc)!.keySet).toBe(3);
    expect(perIdl.decodeAccount('Table', enc)).toBeNull();
    expect(perIdl.decodeAccount('WalletState', enc.subarray(0, 20))).toBeNull(); // older, shorter layout
    expect(perIdl.errorText(999999)).toBe('error 999999');
  });
});
