/**
 * @nomad/chain checked against @solana/web3.js and the program's IDL, entirely offline: no transaction is sent and no
 * real key is used (keypairs are generated in memory for the test).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { EscrowAuthority, ESCROW_PROGRAM_ID, escrowDiscriminators, tableIdBytes } from '../escrow';
import { address, toBase58 } from '../pubkey';
import { SolanaRpc } from '../rpc';
import { compileMessage, signTransaction, signerFromSecret, type Instruction } from '../transaction';
import * as b58 from '../base58';

const idl = JSON.parse(readFileSync(new URL('../../../../onchain/idl/poker_escrow.json', import.meta.url), 'utf8')) as {
  instructions: { name: string; discriminator: number[]; accounts: { name: string; signer?: boolean; writable?: boolean }[] }[];
};
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const toWeb3 = (ix: Instruction) =>
  new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })), data: Buffer.from(ix.data) });

describe('@nomad/chain', () => {
  it('base58 round-trips, including leading zeros', () => {
    for (const s of ['11111111111111111111111111111111', ESCROW_PROGRAM_ID, BLOCKHASH]) expect(b58.encode(b58.decode(s))).toBe(s);
    expect(b58.encode(Uint8Array.of(0, 0, 1))).toBe('112');
  });

  it('derives the same PDAs as web3.js', () => {
    const player = Keypair.generate().publicKey;
    const esc = new EscrowAuthority(ESCROW_PROGRAM_ID, address(Keypair.generate().publicKey.toBase58()));
    const program = new PublicKey(ESCROW_PROGRAM_ID);
    const id = 'poker-money-st1000000-t-abc';
    const web3 = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
    expect(toBase58(esc.config())).toBe(web3([Buffer.from('config')]));
    expect(toBase58(esc.table(id))).toBe(web3([Buffer.from('table'), Buffer.from(tableIdBytes(id))]));
    expect(toBase58(esc.vault(id))).toBe(web3([Buffer.from('vault'), Buffer.from(tableIdBytes(id))]));
    expect(toBase58(esc.seat(id, address(player.toBase58())))).toBe(web3([Buffer.from('seat'), Buffer.from(tableIdBytes(id)), player.toBuffer()]));
  });

  it('matches the IDL: discriminators (sha256 of global:<name>) and account order and flags', () => {
    const authority = address(Keypair.generate().publicKey.toBase58());
    const esc = new EscrowAuthority(ESCROW_PROGRAM_ID, authority);
    const p = address(Keypair.generate().publicKey.toBase58());
    const built: Record<string, Instruction> = {
      create_table: esc.createTable('t1', p, 1_000_000_000n, 5n, 10n, 7),
      begin_round: esc.beginRound('t1'),
      settle_round: esc.settleRound('t1', 3n, [{ player: p, chipDelta: 0n }]),
      cash_out: esc.cashOut('t1', p),
      close_table: esc.closeTable('t1'),
    };
    for (const [name, ix] of Object.entries(built)) {
      const spec = idl.instructions.find((i) => i.name === name)!;
      expect(escrowDiscriminators[name as keyof typeof escrowDiscriminators]).toEqual(spec.discriminator);
      expect([...sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8)]).toEqual(spec.discriminator);
      expect([...ix.data.slice(0, 8)]).toEqual(spec.discriminator);
      // The IDL's accounts, in order, with the same signer / writable flags (settle_round adds seat PDAs after them).
      const fixed = ix.keys.slice(0, spec.accounts.length);
      expect(fixed.map((k) => [k.isSigner, k.isWritable])).toEqual(spec.accounts.map((a) => [!!a.signer, !!a.writable]));
    }
  });

  it('encodes settle_round deltas as Borsh (u64 nonce, u32 length, pubkey + i64 each)', () => {
    const a = address(Keypair.generate().publicKey.toBase58());
    const b = address(Keypair.generate().publicKey.toBase58());
    const esc = new EscrowAuthority(ESCROW_PROGRAM_ID, a);
    const ix = esc.settleRound('t1', 258n, [{ player: a, chipDelta: -50n }, { player: b, chipDelta: 50n }]);
    const d = ix.data;
    expect(d.length).toBe(8 + 32 + 8 + 4 + 2 * 40);
    expect([...d.slice(40, 48)]).toEqual([2, 1, 0, 0, 0, 0, 0, 0]); // 258
    expect([...d.slice(48, 52)]).toEqual([2, 0, 0, 0]);
    expect(Buffer.from(d.slice(84, 92)).readBigInt64LE()).toBe(-50n);
    expect(Buffer.from(d.slice(124, 132)).readBigInt64LE()).toBe(50n);
    expect(ix.keys.slice(3).map((k) => toBase58(k.pubkey))).toEqual([toBase58(esc.seat('t1', a)), toBase58(esc.seat('t1', b))]);
    expect(() => esc.settleRound('t1', 1n, [{ player: a, chipDelta: 1n }])).toThrow(/zero/);
  });

  it('compiles the same message bytes as web3.js, and its WebCrypto signature verifies there', async () => {
    const kp = Keypair.generate();
    const signer = await signerFromSecret(kp.secretKey);
    expect(toBase58(signer.publicKey)).toBe(kp.publicKey.toBase58());
    const esc = new EscrowAuthority(ESCROW_PROGRAM_ID, signer.publicKey);
    const players = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => address(k.publicKey.toBase58()));
    const ixs = [esc.beginRound('t9'), esc.settleRound('t9', 7n, [{ player: players[0]!, chipDelta: 120n }, { player: players[1]!, chipDelta: -100n }, { player: players[2]!, chipDelta: -20n }]), esc.cashOut('t9', players[1]!)];

    const ours = compileMessage(signer.publicKey, BLOCKHASH, ixs);
    const theirs = new Transaction({ feePayer: kp.publicKey, recentBlockhash: BLOCKHASH }).add(...ixs.map(toWeb3));
    expect(Buffer.from(ours.message).equals(theirs.serializeMessage())).toBe(true);

    const wire = await signTransaction(ours, [signer]);
    const decoded = Transaction.from(Buffer.from(wire));
    expect(decoded.verifySignatures()).toBe(true);
    expect(decoded.signatures[0]!.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    theirs.sign(kp);
    expect(Buffer.from(wire).equals(theirs.serialize())).toBe(true); // Ed25519 is deterministic: identical bytes
  });

  it('refuses a mismatched secret, a missing signer, and mainnet', async () => {
    const kp = Keypair.generate();
    const bad = Uint8Array.from(kp.secretKey);
    bad.set(Keypair.generate().publicKey.toBytes(), 32);
    await expect(signerFromSecret(bad)).rejects.toThrow(/do not match/);
    const signer = await signerFromSecret(b58.encode(kp.secretKey));
    const other = address(Keypair.generate().publicKey.toBase58());
    const esc = new EscrowAuthority(ESCROW_PROGRAM_ID, other);
    await expect(signTransaction(compileMessage(signer.publicKey, BLOCKHASH, [esc.beginRound('t1')]), [signer])).rejects.toThrow(/missing signer/);
    expect(() => new SolanaRpc('https://api.mainnet-beta.solana.com')).toThrow(/mainnet/);
  });

  it('talks JSON-RPC: blockhash, send, confirm (against a stand-in RPC)', async () => {
    const calls: string[] = [];
    let statusCalls = 0;
    const fake = (async (_url: string, init: RequestInit) => {
      const { method, params } = JSON.parse(String(init.body));
      calls.push(method);
      const result =
        method === 'getLatestBlockhash' ? { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
        : method === 'sendTransaction' ? (expect(params[1].encoding).toBe('base64'), 'sig123')
        : method === 'getSignatureStatuses' ? { value: [++statusCalls < 2 ? null : { err: null, confirmationStatus: 'confirmed' }] }
        : method === 'getBlockHeight' ? 90
        : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    }) as typeof fetch;
    const rpc = new SolanaRpc('https://api.devnet.solana.com', fake);
    const bh = await rpc.latestBlockhash();
    expect(await rpc.sendTransaction(Uint8Array.of(1, 2))).toBe('sig123');
    await rpc.confirm('sig123', bh.lastValidBlockHeight, async () => undefined);
    expect(calls).toEqual(['getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getSignatureStatuses']);
  });
});

describe('@nomad/chain accounts', () => {
  it('decodes table and seat accounts (Anchor layout) and builds SystemProgram.transfer as web3.js does', async () => {
    const { decodeSeat, decodeTable, systemTransfer, programErrorCode, rakeLamports, SEAT_ACCOUNT_SIZE } = await import('../accounts');
    const { SystemProgram } = await import('@solana/web3.js');
    const host = Keypair.generate().publicKey;
    const auth = Keypair.generate().publicKey;
    const le = (v: bigint, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => Number((BigInt.asUintN(n * 8, v) >> BigInt(8 * i)) & 0xffn)));
    const table = Buffer.concat([Buffer.alloc(8), host.toBuffer(), auth.toBuffer(), Buffer.from(tableIdBytes('t-1')), le(100_000_000n, 8), le(500n, 2), le(5n, 8), le(10n, 8), Buffer.of(6), Buffer.of(2), le(2000n, 8), le(7n, 8), Buffer.of(1), le(1_790_000_000n, 8), le(500n, 8), Buffer.of(254)]);
    expect(decodeTable(table)).toEqual({ host: host.toBase58(), settlementAuthority: auth.toBase58(), buyInLamports: 100_000_000n, rakeBps: 500, smallBlindChips: 5n, bigBlindChips: 10n, maxSeats: 6, seatedCount: 2, chipsInPlay: 2000n, roundNonce: 7n, roundActive: true, lastSettlementTs: 1_790_000_000, pendingChipsInPlay: 500n });
    const p = Keypair.generate().publicKey;
    const seat = Buffer.concat([Buffer.alloc(8), host.toBuffer(), p.toBuffer(), le(1234n, 8), le(100_000_000n, 8), le(5_000_000n, 8), Buffer.of(1), le(-5n, 8), le(500n, 8), Buffer.of(255)]);
    expect(seat.length).toBe(SEAT_ACCOUNT_SIZE);
    expect(decodeSeat(seat)).toEqual({ table: host.toBase58(), player: p.toBase58(), chips: 1234n, depositedLamports: 100_000_000n, rakePaidLamports: 5_000_000n, leaving: true, lastActiveTs: -5, pendingChips: 500n });
    const ix = systemTransfer(address(auth.toBase58()), address(p.toBase58()), 1_461_600n);
    const theirs = SystemProgram.transfer({ fromPubkey: auth, toPubkey: p, lamports: 1_461_600 });
    expect(Buffer.from(ix.data).equals(theirs.data)).toBe(true);
    expect(ix.keys.map((k) => [toBase58(k.pubkey), k.isSigner, k.isWritable])).toEqual(theirs.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
    expect(programErrorCode('Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773')).toBe(6003);
    expect(programErrorCode('transaction failed: {"InstructionError":[0,{"Custom":6005}]}')).toBe(6005);
    expect(programErrorCode('blockhash not found')).toBeNull();
    expect(rakeLamports(100_000_000n, 500)).toBe(5_000_000n);
  });
});

describe('EscrowClient.seatsOf', () => {
  it("finds a seat it wasn't told about from the table's history when getProgramAccounts is refused", async () => {
    const { EscrowClient } = await import('../escrowClient');
    const le = (v: bigint, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => Number((BigInt.asUintN(n * 8, v) >> BigInt(8 * i)) & 0xffn)));
    const kp = Keypair.generate();
    const signer = await signerFromSecret(kp.secretKey);
    const known = Keypair.generate().publicKey;
    const stranger = Keypair.generate().publicKey;
    const esc = new EscrowAuthority(ESCROW_PROGRAM_ID, signer.publicKey);
    const tablePda = toBase58(esc.table('t-x'));
    const tableData = Buffer.concat([Buffer.alloc(8), kp.publicKey.toBuffer(), kp.publicKey.toBuffer(), Buffer.from(tableIdBytes('t-x')), le(100_000_000n, 8), le(500n, 2), le(25n, 8), le(50n, 8), Buffer.of(8), Buffer.of(2), le(1000n, 8), le(4n, 8), Buffer.of(1), le(0n, 8), le(1000n, 8), Buffer.of(254)]);
    const seatData = (p: PublicKey, chips: bigint, pending: bigint) => Buffer.concat([Buffer.alloc(8), Buffer.from(esc.table('t-x')), p.toBuffer(), le(chips, 8), le(0n, 8), le(0n, 8), Buffer.of(0), le(0n, 8), le(pending, 8), Buffer.of(255)]);
    const accounts = new Map<string, Buffer>([
      [tablePda, tableData],
      [toBase58(esc.seat('t-x', address(known.toBase58()))), seatData(known, 1000n, 0n)],
      [toBase58(esc.seat('t-x', address(stranger.toBase58()))), seatData(stranger, 0n, 1000n)],
    ]);
    const calls: string[] = [];
    const rpc = {
      url: 'https://api.devnet.solana.com',
      accountData: async (a: string) => accounts.get(a) ?? null,
      account: async (a: string) => (accounts.has(a) ? { data: accounts.get(a)!, lamports: 1 } : null),
      accounts: async (as: string[]) => as.map((a) => (accounts.has(a) ? { data: accounts.get(a)!, lamports: 1 } : null)),
      programAccounts: async () => {
        calls.push('gpa');
        throw new Error('getProgramAccounts is not available on the Free tier');
      },
      signatures: async (a: string, _l: number, before?: string) => {
        calls.push('sigs');
        expect(a).toBe(tablePda);
        return before ? [] : [{ signature: 's-settle', err: null }, { signature: 's-buyin', err: null }, { signature: 's-failed', err: { x: 1 } }];
      },
      feePayer: async (sig: string) => (calls.push(`tx ${sig}`), sig === 's-buyin' ? stranger.toBase58() : kp.publicKey.toBase58()),
    };
    const client = new EscrowClient(rpc as never, signer);
    const seats = await client.seatsOf('t-x', [known.toBase58()]);
    expect(seats.map((s) => [s.player, s.pendingChips]).sort()).toEqual([[known.toBase58(), 0n], [stranger.toBase58(), 1000n]].sort());
    expect(calls).toEqual(['gpa', 'sigs', 'tx s-settle', 'tx s-buyin']); // failed transactions are skipped
    // When the known wallets already account for every seat and pending chip, nothing else is asked.
    calls.length = 0;
    expect(await client.seatsOf('t-x', [known.toBase58(), stranger.toBase58()])).toHaveLength(2);
    expect(calls).toEqual([]);
  });
});
