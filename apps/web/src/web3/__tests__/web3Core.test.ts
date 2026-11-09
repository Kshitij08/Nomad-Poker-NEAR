/**
 * The web3 module's pure parts: network policy, the escrow program (decoders checked against Chain/AccountDecoder.cs
 * byte offsets, instruction data against PokerEscrowProgram.cs discriminators), PER instruction lists against the IDL,
 * the betting-panel legality port, and the seat rotation the PER table uses.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { makeConfig, assertAllowedUrl, NetworkPolicyError, DEPLOYED } from '../config';
import { decodeSeat, decodeTable, EscrowProgram, escrowIdl, quoteBuyIn, tableIdToBytes, SeatStatus } from '../chain/escrow';
import { PerTableAddresses } from '../per/addresses';
import { PerIx } from '../per/ix';
import { PerGame } from '../per/legal';
import { perIdl } from '../per/types';
import { RotatedView } from '../per/perTableController';
import { ChainTableSession } from '../chain/chainTableSession';
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

/** Chain/AccountDecoder.cs, byte for byte, as the reference for the IDL decoder. */
function referenceDecodeTable(d: Uint8Array) {
  const v = new DataView(d.buffer, d.byteOffset);
  let o = 8 + 32 + 32 + 32;
  const buyIn = v.getBigUint64(o, true); o += 8;
  const rake = v.getUint16(o, true); o += 2;
  const sb = v.getBigUint64(o, true); o += 8;
  const bb = v.getBigUint64(o, true); o += 8;
  const maxSeats = d[o++]!;
  const seated = d[o++]!;
  const chipsInPlay = v.getBigUint64(o, true); o += 8;
  const nonce = v.getBigUint64(o, true); o += 8;
  const active = d[o++] !== 0;
  o += 8;
  const pending = v.getBigUint64(o, true);
  return { buyIn, rake, sb, bb, maxSeats, seated, chipsInPlay, nonce, active, pending };
}

describe('poker-escrow (Chain/*)', () => {
  const host = Keypair.generate().publicKey;
  const tableData = escrowIdl.encodeAccount('Table', {
    host: host.toBytes(), settlementAuthority: host.toBytes(), tableId: tableIdToBytes('x2c-abc'), buyInLamports: 100_000_000n, rakeBps: 250,
    smallBlindChips: 10n, bigBlindChips: 20n, maxSeats: 6, seatedCount: 2, chipsInPlay: 2000n, roundNonce: 7n, roundActive: true,
    lastSettlementTs: 123n, pendingChipsInPlay: 50n, bump: 254,
  });

  it('decodes Table exactly like AccountDecoder.DecodeTable', () => {
    const t = decodeTable('x2c-abc', tableData);
    const r = referenceDecodeTable(tableData);
    expect([t.buyInLamports, t.rakeBps, t.smallBlindChips, t.bigBlindChips, t.maxSeats, t.seatedCount, t.chipsInPlay, t.roundNonce, t.roundActive, t.pendingChipsInPlay])
      .toEqual([r.buyIn, r.rake, r.sb, r.bb, r.maxSeats, r.seated, r.chipsInPlay, r.nonce, r.active, r.pending]);
    expect(t.host).toBe(host.toBase58());
  });

  it('decodes Seat (status enum, pending chips)', () => {
    const seat = decodeSeat(escrowIdl.encodeAccount('Seat', {
      table: host.toBytes(), player: host.toBytes(), chips: 900n, depositedLamports: 1n, rakePaidLamports: 2n, status: 1, lastActiveTs: 0n, pendingChips: 100n, bump: 1,
    }));
    expect(seat.status).toBe(SeatStatus.Leaving);
    expect(seat.chips + seat.pendingChips).toBe(1000n);
  });

  it('quotes a buy-in like PokerChain.QuoteBuyIn', () => {
    expect(quoteBuyIn(100_000_000n, 250)).toEqual({ buyInLamports: 100_000_000n, rakeLamports: 2_500_000n, totalLamports: 102_500_000n, chips: 1000n });
  });

  it('builds buy_in / rebuy / request_leave with PokerEscrowProgram.cs discriminators and accounts', () => {
    const p = new EscrowProgram();
    const player = Keypair.generate().publicKey;
    const dev = Keypair.generate().publicKey;
    const buy = p.buyInIx(player, 'x2c-abc', dev);
    expect([...buy.data.subarray(0, 8)]).toEqual([126, 94, 133, 165, 163, 236, 161, 152]);
    expect([...buy.data.subarray(8, 15)]).toEqual([...new TextEncoder().encode('x2c-abc')]);
    expect(buy.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[true, true], [false, false], [false, true], [false, true], [false, true], [false, true], [false, false]]);
    expect(buy.keys[4]!.pubkey.equals(p.deriveSeat(tableIdToBytes('x2c-abc'), player))).toBe(true);
    const rebuy = p.rebuyIx(player, 'x2c-abc', 100_000_000n, dev);
    expect([...rebuy.data.subarray(0, 8)]).toEqual([147, 185, 111, 149, 82, 245, 49, 165]);
    expect(new DataView(rebuy.data.buffer, rebuy.data.byteOffset).getBigUint64(40, true)).toBe(100_000_000n);
    expect([...p.requestLeaveIx(player, 'x2c-abc').data.subarray(0, 8)]).toEqual([25, 112, 92, 69, 219, 248, 146, 134]);
  });

  it('ChainTableSession treats a lost begin_round that landed as success, and halts after three failed settles', async () => {
    let roundActive = true;
    const fake = {
      getTable: async () => ({ roundActive }) as never,
      getTableWithRetry: async () => ({}) as never,
      tryGetSeat: async () => null,
      host: {
        beginHand: async () => ({ success: false, alreadyActive: false, roundNonce: 0n, signature: null, error: 'timeout' }),
        settleHand: async () => ({ success: false, signature: null, error: 'boom' }),
      } as never,
    };
    const s = ChainTableSession.adopt(fake, 'jwt', 'x2c-t', 1n, 1n, 2n, async () => {});
    expect(await s.beginHand()).toBe(true);
    let halted = false;
    s.onHalted(() => (halted = true));
    expect(await s.settleHand([], 0)).toBe(false); // round still active after every attempt
    expect(halted).toBe(true);
    roundActive = false;
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
