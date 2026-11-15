/**
 * A live NEAR table on testnet, run by hand (skipped unless NEAR_LIVE=1): two real testnet accounts sign in to the
 * local API with NEP-413, buy in on the deployed escrow, play a few hands at the local game server (`npm run dev` in
 * apps/api and apps/game-server), leave, and the escrow must have paid back exactly what the table locked.
 *
 *   NEAR_LIVE=1 NEAR_CREDENTIALS_DIR=<dir with nomad-poker.testnet.json, pro.nomad-poker.testnet.json> npx vitest run src/__tests__/nearLive.test.ts
 *
 * Spends a little testnet NEAR (5% rake of each buy-in; the rest is withdrawn at the end).
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlayerAction } from '@nomad/engine/actions/actions';
import { verifyDeck, type DeckReveal } from '@nomad/engine/cards/deckCommitment';
import { connectTable } from '../../../web/src/net/matchmaking';
import { headlessClient, until, type Headless } from '../../../web/server/__tests__/headlessClient';
import { CHIP_YOCTO } from '../nearChipLedger';
import { NearOperator, base58Decode } from '../nearOperator';

const LIVE = process.env.NEAR_LIVE === '1';
const API = process.env.NEAR_LIVE_API ?? 'http://localhost:8788';
const GAME = process.env.NEAR_LIVE_GAME ?? 'http://localhost:8789';
const ORIGIN = process.env.NEAR_LIVE_ORIGIN ?? 'http://localhost:5183';
const RPC = 'https://test.rpc.fastnear.com';
const ESCROW = 'nomad-escrow.testnet';
/** NEAR_LIVE_HOSTED=1: the first account hosts a fresh st50 table on the escrow and both play there. */
const ROOM = process.env.NEAR_LIVE_HOSTED === '1' ? `poker-money-st50-h${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}` : 'poker-money-st50';
const BUY_IN = 6n * 10n ** 22n; // 0.06 NEAR → 57 chips after the 5% rake
const HANDS = Number(process.env.NEAR_LIVE_HANDS ?? 4);

type Who = { account: string; key: string; publicKey: string; signer: NearOperator; token?: string; chips?: number; client?: Headless };

function who(account: string): Who {
  const cred = JSON.parse(readFileSync(join(process.env.NEAR_CREDENTIALS_DIR ?? '', `${account}.json`), 'utf8')) as { private_key: string; public_key: string };
  return { account, key: cred.private_key, publicKey: cred.public_key, signer: new NearOperator({ rpcUrl: RPC, accountId: account, secretKey: cred.private_key }) };
}

/** NEP-413 sign-in to the local API (the same bytes a wallet signs). */
async function signIn(w: Who): Promise<string> {
  const post = async (path: string, body: unknown) => {
    const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const ch = (await post('/v1/auth/near/challenge', { accountId: w.account })) as { message: string; nonce: string; recipient: string };
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const hash = createHash('sha256').update(Buffer.concat([tag, str(ch.message), Buffer.from(ch.nonce, 'base64'), str(ch.recipient), Buffer.from([0])])).digest();
  const seed = base58Decode(w.key.replace('ed25519:', '')).subarray(0, 32);
  const pk = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const s = (await post('/v1/auth/near/verify', { accountId: w.account, publicKey: w.publicKey, signature: sign(null, hash, pk).toString('base64'), nonce: ch.nonce })) as { token: string };
  return s.token;
}

describe.skipIf(!LIVE)('live: a NEAR table on testnet', () => {
  const players = LIVE ? [who('nomad-poker.testnet'), who('pro.nomad-poker.testnet')] : [];
  const balance = (w: Who) => w.signer.view<string>(ESCROW, 'get_balance', { account: w.account }).then(BigInt);

  it('signs in with NEAR and buys in on the escrow', async () => {
    if (ROOM !== 'poker-money-st50') {
      await players[0]!.signer.call(ESCROW, 'create_hosted_table', { table_id: ROOM, config: { small_blind: 1, big_blind: 2, min_buy_in: 50, max_buy_in: 200, seats: 6 }, invites: players.map((w) => w.account) }, { tgas: 30n });
      console.log(`${players[0]!.account} hosts ${ROOM} (invite-only)`);
    }
    for (const w of players) {
      w.token = await signIn(w);
      const existing = await w.signer.view<{ locked: string } | null>(ESCROW, 'get_seat', { table_id: ROOM, player: w.account });
      if (!existing) await w.signer.call(ESCROW, 'buy_in', { table_id: ROOM }, { deposit: BUY_IN, tgas: 30n });
      // The RPC node can lag the transaction by a moment.
      let seat: { locked: string } | null = null;
      for (let i = 0; i < 20 && !seat; i++) {
        seat = await w.signer.view<{ locked: string } | null>(ESCROW, 'get_seat', { table_id: ROOM, player: w.account });
        if (!seat) await new Promise((r) => setTimeout(r, 500));
      }
      if (!seat) throw new Error(`no escrow seat for ${w.account} after buying in`);
      w.chips = Number(BigInt(seat.locked) / CHIP_YOCTO);
      console.log(`${w.account}: signed in, seat locks ${w.chips} chips`);
    }
  }, 120_000);

  it(`plays ${HANDS} committed hands at the game server`, async () => {
    for (const w of players) {
      const r = await connectTable({ kind: 'join', code: ROOM }, { url: GAME });
      expect(r.ok, r.message).toBe(true);
      const h = headlessClient(r.conn!, { name: w.account, token: `tok-${w.account}`, playerId: w.account, coins: 0, speed: 1, buyIn: w.chips, ticket: () => w.token! });
      h.panel.policy = (legal) => (legal.canCheck ? PlayerAction.check() : legal.canCall ? PlayerAction.call() : PlayerAction.fold());
      h.game.start();
      w.client = h;
    }
    await until(() => players.every((w) => w.client!.game.localSeat >= 0), 20_000, 'both seated');
    await until(() => players[0]!.client!.game.handsSeen >= HANDS, 240_000, `${HANDS} hands`);
    let verified = 0;
    for (let n = 1; n <= HANDS; n++) {
      const res = await fetch(`${GAME}/v1/near-tables/${ROOM}/hands/${n}/deck`);
      if (!res.ok) continue;
      const reveal = (await res.json()) as DeckReveal;
      expect(verifyDeck(reveal).ok).toBe(true);
      verified++;
    }
    console.log(`${verified} of ${HANDS} hands' decks verified from the reveal route`);
    expect(verified).toBeGreaterThan(0);
  }, 300_000);

  it('leaves, and the escrow pays both back what the table locked', async () => {
    const before = await Promise.all(players.map(balance));
    for (const w of players) {
      w.client!.game.requestLeaveTable();
      await until(() => w.client!.game.localSeat < 0, 20_000, 'left');
    }
    const seated = async () => (await Promise.all(players.map((w) => w.signer.view(ESCROW, 'get_seat', { table_id: ROOM, player: w.account })))).every((s) => s === null);
    for (let i = 0; i < 60 && !(await seated()); i++) await new Promise((r) => setTimeout(r, 1000));
    expect(await seated()).toBe(true);
    const after = await Promise.all(players.map(balance));
    const paid = after.reduce((a, b) => a + b, 0n) - before.reduce((a, b) => a + b, 0n);
    const chips = players.reduce((a, w) => a + w.chips!, 0);
    console.log(`paid back ${paid / CHIP_YOCTO} chips for ${chips} locked:`, players.map((w, i) => `${w.account} ${(after[i]! - before[i]!) / CHIP_YOCTO}`).join(', '));
    expect(paid).toBe(BigInt(chips) * CHIP_YOCTO);
    for (const w of players) {
      w.client!.game.stop();
      w.client!.conn.close();
      const b = await balance(w);
      if (b > 0n) await w.signer.call(ESCROW, 'withdraw', { amount: String(b) }, { tgas: 30n });
    }
  }, 120_000);
});
