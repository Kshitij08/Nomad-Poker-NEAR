/**
 * A live NEAR tournament on testnet, run by hand (skipped unless NEAR_LIVE=1): the records in the D1 stand-in, the real
 * escrow. pro.nomad-poker.testnet hosts (its "wallet" creates it on the escrow with a prize), both accounts register
 * there and here (the API's escrow views over RPC check it), the host cancels here, and the game server's sweep has
 * the operator (nomad-poker.testnet) cancel it on the escrow: everyone's money must be back in their game balance.
 *
 *   NEAR_LIVE=1 NEAR_CREDENTIALS_DIR=<dir with nomad-poker.testnet.json, pro.nomad-poker.testnet.json> npx vitest run src/__tests__/nearTournamentLive.test.ts
 *
 * Spends only gas: 0.01 NEAR entries and a 0.02 NEAR prize go in and are refunded, then withdrawn.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlayer, findPlayer } from '@nomad/db/accounts';
import { cancelTournament, confirmEscrow, createTournament, escrowCreateArgs, register, tournamentView } from '@nomad/db/tournaments';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { tournamentEscrow } from '../../../api/src/near';
import { NearOperator } from '../nearOperator';
import { sweepTournamentEscrow } from '../tournamentEscrow';

const LIVE = process.env.NEAR_LIVE === '1';
const RPC = 'https://test.rpc.fastnear.com';
const ESCROW = 'nomad-escrow.testnet';
const HOST = 'pro.nomad-poker.testnet';
const OPERATOR = 'nomad-poker.testnet';
const CHIP = 10n ** 21n;

const signer = (account: string) => {
  const cred = JSON.parse(readFileSync(join(process.env.NEAR_CREDENTIALS_DIR ?? '', `${account}.json`), 'utf8')) as { private_key: string };
  return new NearOperator({ rpcUrl: RPC, accountId: account, secretKey: cred.private_key });
};

describe.skipIf(!LIVE)('a live NEAR tournament on testnet', () => {
  it('creates on the escrow, registers both accounts, cancels, and refunds everyone', async () => {
    const log = (level: string, m: string) => console.log(`${level} ${m}`);
    const db = await D1Shim.migrated();
    const now = Date.now();
    const player = async (account: string) => {
      const p = (await findPlayer(db, (await createPlayer(db, { displayName: account }, now)).id))!;
      await db.prepare("INSERT INTO identities (provider, subject, label, player_id, created_at) VALUES ('near', ?1, ?1, ?2, ?3)").bind(account, p.id, now).run();
      return p;
    };
    const host = await player(HOST);
    const op = await player(OPERATOR);
    const hostSigner = signer(HOST);
    const opSigner = signer(OPERATOR);
    const escrow = tournamentEscrow(RPC, ESCROW);
    const balance = async (a: string) => BigInt(await opSigner.view<string>(ESCROW, 'get_balance', { account: a }));
    const before = { host: await balance(HOST), op: await balance(OPERATOR) };

    // Hosted here (hidden), then created on the escrow by the host's key, as the app's wallet step does.
    const rules = { minLeadMs: 60_000, maxLeadMs: 86_400_000, maxActivePerHost: 2 };
    const t = (await createTournament(db, host.id, { name: 'Live NEAR Cup', entryFee: 10, hostPrize: 20, maxPlayers: 4, startsAtUnix: Math.floor(now / 1000) + 3600, currency: 'near' }, rules, now)).tournament;
    const row = (await db.prepare('SELECT * FROM tournaments WHERE id = ?1').bind(t.id).first())!;
    const args = escrowCreateArgs(row as never);
    await hostSigner.call(ESCROW, 'create_tournament', { ...args, code_hash: null }, { deposit: 20n * CHIP });
    console.log(`created ${t.id} on ${ESCROW}`);
    expect((await confirmEscrow(db, escrow, host.id, t.id, Date.now())).tournament.escrowReady).toBe(true);

    // Both register on the escrow (entry attached), then here.
    for (const [p, s] of [[host, hostSigner], [op, opSigner]] as const) {
      await expect(register(db, p, t.id, Date.now(), escrow)).rejects.toMatchObject({ code: 'escrow_unpaid' });
      await s.call(ESCROW, 'register', { tournament_id: t.id, code: null }, { deposit: 10n * CHIP });
      expect((await register(db, p, t.id, Date.now(), escrow)).tournament.myStatus).toBe('registered');
    }
    expect((await escrow.getTournament(t.id))?.players.sort()).toEqual([HOST, OPERATOR].sort());

    // The host cancels here; the game server's sweep refunds it on the escrow as its operator.
    await cancelTournament(db, host.id, t.id, Date.now(), escrow);
    expect(await sweepTournamentEscrow(db, { operator: opSigner, escrow: ESCROW }, log)).toBe(1);
    expect((await escrow.getTournament(t.id))?.status).toBe('Cancelled');
    expect((await tournamentView(db, t.id, host.id)).tournament.status).toBe('cancelled');
    const after = { host: await balance(HOST), op: await balance(OPERATOR) };
    expect(after.host - before.host).toBe(30n * CHIP); // entry + prize
    expect(after.op - before.op).toBe(10n * CHIP);

    // Back to the wallets.
    await hostSigner.call(ESCROW, 'withdraw', { amount: String(after.host - before.host) }, { tgas: 30n });
    await opSigner.call(ESCROW, 'withdraw', { amount: String(after.op - before.op) }, { tgas: 30n });
    expect(await balance(HOST)).toBe(before.host);
    expect(await balance(OPERATOR)).toBe(before.op);
  }, 180_000);
});
