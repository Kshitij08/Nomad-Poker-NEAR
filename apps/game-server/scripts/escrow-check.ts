/**
 * Phase 6 exit gate, SOL tables on devnet: three throwaway wallets play a `poker-money` table on the deployed game
 * server through the real web client, with every chip on the poker-escrow program.
 *
 *   npx tsx scripts/escrow-check.ts [hands=20] [stage=staging] [--local]
 *
 * --local runs the game server's table routes in-process here (localGameServer.ts: real tables and escrow client,
 * D1 stand-in, players signed in by wallet identity directly) instead of the deployed Worker, still on devnet with the
 * stage's settlement key. Devnet's public RPC refuses Cloudflare Workers, so this is how the program is checked until
 * the Worker has an RPC it can reach.
 *
 * 1. Makes (or reuses) three devnet keypairs, kept only in .escrow-check-wallets.<stage>.json (git-ignored), and tops
 *    each up from the game server's own settlement key (.secrets.<stage>.json). Never touches any other wallet.
 * 2. Signs each in on the API with its wallet (challenge + Ed25519 signature).
 * 3. Alice buys in on chain and sits; Bob buys in and joins. Carol buys in while a round is open (pending chips) and
 *    joins. Bob cashes out half-way; Alice and Carol play on, then leave; the room idles and closes the table.
 * 4. Checks every lamport: what each wallet paid in (buy-in, rake, fees) and got back (chips, seat rent), the table and
 *    vault closed, and chips conserved across all settled rounds.
 * 5. Sends what's left in the test wallets back to the settlement key.
 *
 * Writes results/escrow-check-<time>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { PlayerAction } from '@nomad/engine/actions/actions';
import type { SessionResponse } from '@nomad/contract';
import { decodeSeat, decodeTable, LAMPORTS_PER_CHIP, rakeLamports } from '@nomad/chain/accounts';
import { EscrowAuthority } from '@nomad/chain/escrow';
import * as b58 from '@nomad/chain/base58';
import { address, toBase58 } from '@nomad/chain/pubkey';
import { connectTable } from '../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../web/server/__tests__/headlessClient';
import { decodeConfigDevWallet, EscrowProgram } from '../../web/src/web3/chain/escrow';
import { startLocalGameServer, type LocalGameServer } from './localGameServer';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const LOCAL = process.argv.includes('--local');
const HANDS = Number(args[0] ?? 20);
const stage = args[1] ?? 'staging';
const API = { staging: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev' }[stage]!;
let GAME = { staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev' }[stage]!;
let local: LocalGameServer | null = null;
const RPC = 'https://api.devnet.solana.com';
const TOP_UP = 130_000_000; // 0.13 SOL: a 0.1 SOL buy-in, 5% rake, seat rent, fees
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (l: number | bigint) => (Number(l) / 1e9).toFixed(9);

const secrets = JSON.parse(readFileSync(new URL(`../.secrets.${stage}.json`, import.meta.url), 'utf8')) as { ESCROW_AUTHORITY_SECRET: string };
const authority = Keypair.fromSecretKey(b58.decode(secrets.ESCROW_AUTHORITY_SECRET));
const conn = new Connection(RPC, 'confirmed');
const program = new EscrowProgram();
const walletsFile = new URL(`../.escrow-check-wallets.${stage}.json`, import.meta.url);

function wallets(): Record<'alice' | 'bob' | 'carol', Keypair> {
  const saved: Record<string, string> = existsSync(walletsFile) ? JSON.parse(readFileSync(walletsFile, 'utf8')) : {};
  const out = {} as Record<'alice' | 'bob' | 'carol', Keypair>;
  for (const n of ['alice', 'bob', 'carol'] as const) {
    out[n] = saved[n] ? Keypair.fromSecretKey(b58.decode(saved[n]!)) : Keypair.generate();
    saved[n] = b58.encode(out[n].secretKey);
  }
  writeFileSync(walletsFile, JSON.stringify(saved, null, 2));
  return out;
}

async function topUp(kp: Keypair): Promise<void> {
  const have = await conn.getBalance(kp.publicKey);
  if (have >= TOP_UP) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: kp.publicKey, lamports: TOP_UP - have }));
  await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
}

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5180', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/** Wallet sign-in, as the web client does it: the API's challenge message, signed with the wallet's key. */
async function signIn(kp: Keypair): Promise<{ token: string; player: { id: string } }> {
  const addr = kp.publicKey.toBase58();
  if (local) {
    const p = await local.walletPlayer(addr.slice(0, 6), addr);
    return { token: p.token, player: { id: p.id } };
  }
  const ch = await api<{ nonce: string; message: string }>('POST', '/v1/auth/wallet/challenge', { address: addr });
  if (ch.status !== 200) throw new Error(`challenge ${ch.status}`);
  const signature = b58.encode(ed25519.sign(new TextEncoder().encode(ch.body.message), kp.secretKey.slice(0, 32)));
  const v = await api<SessionResponse>('POST', '/v1/auth/wallet/verify', { address: addr, nonce: ch.body.nonce, signature });
  if (v.status !== 200 && v.status !== 201) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
  return v.body;
}

/** The player's own buy_in, built by the web client's escrow coder and signed by their wallet. */
async function buyIn(kp: Keypair, tableId: string): Promise<{ signature: string; fee: number }> {
  const cfg = await conn.getAccountInfo(program.deriveConfig());
  const dev = decodeConfigDevWallet(cfg!.data);
  const tx = new Transaction().add(program.buyInIx(kp.publicKey, tableId, dev));
  const signature = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
  const meta = (await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta;
  return { signature, fee: meta?.fee ?? 5000 };
}

async function join(name: string, room: string, token: string): Promise<Headless> {
  const r = await connectTable({ kind: 'join', code: room }, { url: GAME });
  if (!r.ok) throw new Error(`${name} join: ${r.message}`);
  const h = headlessClient(r.conn!, { name, token: `escrow-${name}`, playerId: name, coins: 0, speed: 1, ticket: () => token });
  h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : legal.canCall ? PlayerAction.call() : PlayerAction.fold());
  h.game.start();
  return h;
}

async function main(): Promise<void> {
  const esc = new EscrowAuthority(undefined, address(authority.publicKey.toBase58()));
  const table = async (id: string) => {
    const a = await conn.getAccountInfo(new PublicKey(toBase58(esc.table(id))));
    return a ? decodeTable(a.data) : null;
  };
  const seat = async (id: string, kp: Keypair) => {
    const a = await conn.getAccountInfo(new PublicKey(toBase58(esc.seat(id, address(kp.publicKey.toBase58())))));
    return a ? { ...decodeSeat(a.data), rent: a.lamports } : null;
  };

  if (LOCAL) {
    local = await startLocalGameServer(secrets.ESCROW_AUTHORITY_SECRET, RPC, (level, m) => {
      if (level !== 'info' || /\[Escrow\]|HALTED|could not buy in/.test(m)) log(`  server ${level}: ${m}`);
    });
    GAME = local.url;
    log(`local game server at ${GAME}`);
  }
  const cfg = (await (await fetch(`${GAME}/v1/chain/config`)).json()) as { moneyTables: boolean; settlementAuthority?: string };
  if (!cfg.moneyTables || cfg.settlementAuthority !== authority.publicKey.toBase58()) throw new Error(`game server chain config: ${JSON.stringify(cfg)}`);
  log(`settlement key ${authority.publicKey.toBase58()}: ${sol(await conn.getBalance(authority.publicKey))} SOL`);

  const w = wallets();
  for (const [n, kp] of Object.entries(w)) {
    await topUp(kp);
    log(`${n} ${kp.publicKey.toBase58()}: ${sol(await conn.getBalance(kp.publicKey))} SOL`);
  }
  const start = Object.fromEntries(await Promise.all(Object.entries(w).map(async ([n, kp]) => [n, await conn.getBalance(kp.publicKey)] as const))) as Record<string, number>;
  const fees: Record<string, number> = { alice: 0, bob: 0, carol: 0 };
  const sessions = Object.fromEntries(await Promise.all(Object.entries(w).map(async ([n, kp]) => [n, await signIn(kp)] as const))) as Record<string, { token: string; player: { id: string } }>;
  log(`signed in: ${Object.entries(sessions).map(([n, s]) => `${n}=${s.player.id}`).join(' ')}`);

  const room = `poker-money-${50 + Math.floor(Math.random() * 49)}`;
  log(`room ${room}`);
  const a = await join('Alice', room, sessions.alice!.token);
  await until(() => !!a.game.tableEconomy?.tableId, 20_000, 'table economy');
  const tableId = a.game.tableEconomy!.tableId;
  for (let i = 0; i < 60 && !(await table(tableId)); i++) await sleep(1000);
  const t1 = await table(tableId);
  if (!t1) throw new Error(`table ${tableId} never appeared on chain`);
  log(`table ${tableId} on chain: authority ${t1.settlementAuthority}, buy-in ${sol(t1.buyInLamports)} SOL, rake ${t1.rakeBps} bps, ${t1.maxSeats} seats`);
  const buyInL = Number(t1.buyInLamports);
  const rake = Number(rakeLamports(t1.buyInLamports, t1.rakeBps));

  fees.alice += (await buyIn(w.alice, tableId)).fee;
  a.game.requestBuyIn();
  await until(() => a.game.localSeat >= 0, 30_000, 'Alice seated');
  log('Alice bought in and sat');

  fees.bob += (await buyIn(w.bob, tableId)).fee;
  const b = await join('Bob', room, sessions.bob!.token);
  await until(() => b.game.localSeat >= 0, 30_000, 'Bob seated');
  log('Bob bought in and sat');

  const nonce = async () => (await table(tableId))?.roundNonce ?? 0n;
  let c: Headless | null = null;
  let carolPending = false;
  let bobLeft = false;
  const deadline = Date.now() + HANDS * 60_000;
  for (;;) {
    const n = await nonce();
    if (n >= BigInt(HANDS)) break;
    if (Date.now() > deadline) throw new Error(`only ${n} rounds settled`);
    if (!c && n >= 3n) {
      for (let i = 0; i < 40 && !(await table(tableId))!.roundActive; i++) await sleep(500);
      fees.carol += (await buyIn(w.carol, tableId)).fee;
      const s = await seat(tableId, w.carol);
      carolPending = (s?.pendingChips ?? 0n) > 0n;
      log(`Carol bought in during round ${n}: ${s?.chips} chips, ${s?.pendingChips} pending`);
      c = await join('Carol', room, sessions.carol!.token);
      await until(() => c!.game.localSeat >= 0, 30_000, 'Carol seated');
      log('Carol sat');
    }
    if (!bobLeft && n >= BigInt(Math.floor(HANDS / 2))) {
      bobLeft = true;
      b.game.requestLeaveTable();
      log(`Bob leaves after round ${n}`);
    }
    await sleep(3000);
  }
  log(`${HANDS} rounds settled`);
  for (let i = 0; i < 60 && (await seat(tableId, w.bob)); i++) await sleep(1000);
  if (await seat(tableId, w.bob)) throw new Error('Bob was never paid out');

  for (const h of [a, c!]) h.game.requestLeaveTable();
  for (let i = 0; i < 60 && ((await seat(tableId, w.alice)) || (await seat(tableId, w.carol))); i++) await sleep(1000);
  for (const h of [a, b, c!]) {
    h.game.stop();
    h.conn.close();
  }
  log('everyone left; waiting for the room to idle out and close the table (about 3 minutes)');
  for (let i = 0; i < 360 && (await table(tableId)); i++) await sleep(1000);
  const closed = !(await table(tableId));
  const vaultGone = !(await conn.getAccountInfo(new PublicKey(toBase58(esc.vault(tableId)))));
  log(`table closed: ${closed}, vault closed: ${vaultGone}`);

  // Every lamport: delta = − buy-in − rake − fees + payout (seat rent is paid at buy-in and refunded at cash-out).
  const end: Record<string, number> = {};
  const payout: Record<string, number> = {};
  for (const [n, kp] of Object.entries(w)) {
    end[n] = await conn.getBalance(kp.publicKey);
    payout[n] = end[n]! - start[n]! + buyInL + rake + fees[n]!;
    log(`${n}: ${sol(start[n]!)} → ${sol(end[n]!)}; paid out ${sol(payout[n]!)} SOL (${payout[n]! / Number(LAMPORTS_PER_CHIP)} chips)`);
  }
  const totalPaid = payout.alice! + payout.bob! + payout.carol!;
  const checks = {
    chipsConserved: totalPaid === 3 * buyInL,
    payoutsWholeChips: Object.values(payout).every((p) => p % Number(LAMPORTS_PER_CHIP) === 0 && p >= 0),
    tableClosed: closed,
    vaultClosed: vaultGone,
    carolPendingTested: carolPending,
  };
  log(`checks: ${JSON.stringify(checks)}`);

  // Return what's left to the settlement key (each wallet keeps nothing).
  for (const [n, kp] of Object.entries(w)) {
    const bal = await conn.getBalance(kp.publicKey);
    if (bal <= 5000) continue;
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: authority.publicKey, lamports: bal - 5000 })), [kp], { commitment: 'confirmed' });
    log(`returned ${sol(bal - 5000)} SOL from ${n}`);
  }
  await local?.stop();
  const result = { at: new Date().toISOString(), stage: LOCAL ? `${stage} key, local server` : stage, room, tableId, hands: HANDS, buyInLamports: buyInL, rakeLamports: rake, start, end, fees, payout, checks, pass: Object.values(checks).every(Boolean) };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  const file = new URL(`../results/escrow-check-${Date.now()}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`${result.pass ? 'PASS' : 'FAIL'}: ${file.pathname}`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
