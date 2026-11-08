import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer, createSession, sessionPlayer, session, findPlayer } from '../accounts';
import { adjustBalance, adminRole, auditLog, playerDetail, searchPlayers, setBan } from '../admin';
import { balances } from '../ledger';
import { D1Shim } from '../testing/d1Shim';

const T0 = Date.UTC(2026, 10, 10, 1);
let db: D1Database;
let boss: string;
let helper: string;
let pat: string;

beforeEach(async () => {
  db = await D1Shim.migrated();
  boss = (await createPlayer(db, { displayName: 'Boss' }, T0)).id;
  helper = (await createPlayer(db, { displayName: 'Helper' }, T0)).id;
  pat = (await createPlayer(db, { displayName: 'Pat_100%' }, T0)).id;
  await db.batch([
    db.prepare(`INSERT INTO admin_users (player_id, role, added_at) VALUES (?1, 'admin', ?2)`).bind(boss, T0),
    db.prepare(`INSERT INTO admin_users (player_id, role, added_at) VALUES (?1, 'support', ?2)`).bind(helper, T0),
  ]);
});

describe('support tools', () => {
  it('knows who is an admin, and finds players by id, Friend ID or name', async () => {
    expect(await adminRole(db, boss)).toBe('admin');
    expect(await adminRole(db, helper)).toBe('support');
    expect(await adminRole(db, pat)).toBeNull();
    const code = (await findPlayer(db, pat))!.friend_code!;
    expect((await searchPlayers(db, 'pat_1')).map((p) => p.id)).toEqual([pat]);
    expect((await searchPlayers(db, '%')).map((p) => p.id)).toEqual([]); // wildcards are literal
    expect((await searchPlayers(db, code.toLowerCase().replace(/(.{4})/g, '$1-').slice(0, 19))).map((p) => p.id)).toEqual([pat]);
    expect((await searchPlayers(db, pat))[0]!.name).toBe('Pat_100%');
  });

  it('adjusts a balance once per request id, admins only, never below zero, all audited', async () => {
    const boss_ = { player_id: boss, role: 'admin' as const };
    const helper_ = { player_id: helper, role: 'support' as const };
    await expect(adjustBalance(db, helper_, pat, { delta: 500, reason: 'goodwill', requestId: 'req-00001' }, T0)).rejects.toMatchObject({ status: 403 });
    expect((await adjustBalance(db, boss_, pat, { delta: 500, reason: 'lost hand bug #12', requestId: 'req-00001' }, T0)).coins).toBe(10_500);
    expect((await adjustBalance(db, boss_, pat, { delta: 500, reason: 'lost hand bug #12', requestId: 'req-00001' }, T0)).coins).toBe(10_500);
    await expect(adjustBalance(db, boss_, pat, { delta: -50_000, reason: 'oops', requestId: 'req-00002' }, T0)).rejects.toMatchObject({ code: 'insufficient_funds' });
    await expect(adjustBalance(db, boss_, pat, { delta: 5, reason: '', requestId: 'req-00003' }, T0)).rejects.toMatchObject({ status: 400 });
    expect((await balances(db, pat)).coins).toBe(10_500);
    const log = await auditLog(db);
    expect(log.entries.map((e) => [e.action, e.target_id])).toEqual([['adjust', pat]]);
    const d = await playerDetail(db, helper, pat, T0);
    expect(d.ledger[0]).toMatchObject({ reason: 'admin:adjust', delta: 500 });
    expect(d.audit).toHaveLength(1);
    expect((await auditLog(db)).entries[0]!.action).toBe('view');
  });

  it('a ban signs the player out everywhere and refuses sign-in until lifted', async () => {
    const helper_ = { player_id: helper, role: 'support' as const };
    const tok = (await createSession(db, pat, T0)).token;
    expect(await sessionPlayer(db, tok, T0)).not.toBeNull();
    await setBan(db, helper_, pat, true, 'chip dumping with alt accounts', T0);
    expect(await sessionPlayer(db, tok, T0)).toBeNull();
    await expect(session(db, (await findPlayer(db, pat))!, false, false, T0)).rejects.toMatchObject({ status: 403 });
    await expect(setBan(db, helper_, helper, true, 'test', T0)).rejects.toMatchObject({ status: 400 });
    await setBan(db, helper_, pat, false, '', T0);
    expect((await session(db, (await findPlayer(db, pat))!, false, false, T0)).token).toMatch(/^np_/);
    expect((await auditLog(db)).entries.map((e) => e.action)).toEqual(['unban', 'ban']);
  });
});
