import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { runQuery } from './bridge';
import { lobbyRoute } from './lobby';

/** The PER schema on the node:sqlite D1 stand-in. */
function perDb(): { db: D1Database; shim: D1Shim } {
  const shim = new D1Shim();
  const dir = join(import.meta.dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) shim.sqlite.exec(readFileSync(join(dir, f), 'utf8'));
  return { db: shim as unknown as D1Database, shim };
}

const T = 'Gs5HBtJVw2ouC1Mi7BQXAanhEw4HrLm2y6WZPWA11rRt';
const C = '8y58w8T7h9bWAvJM1nbqu2e65XQMPtuTt8BTf7txbM85';

describe('PER Worker', () => {
  it('serves the lobby, a table and its hands from D1 in the container\'s response shapes', async () => {
    const { db, shim } = perDb();
    shim.sqlite.exec(`INSERT INTO tables (address, table_id, creator, status, max_seats, seated, invite_only, small_blind, big_blind, min_buy_in, max_buy_in, hand_no, hand_state, ledger_seq, last_commit_ts, delegated, idle_since)
      VALUES ('${T}', '18446744073709551615', '${C}', 1, 6, 2, 0, 5000, 10000, 100000, 1000000, 7, 2, 9, 0, 1, unixepoch())`);
    shim.sqlite.exec(`INSERT INTO hands (table_address, hand_no, record, verified, problems, log_status, log_verified, button_checked) VALUES ('${T}', 7, '{"handNo":"7"}', 1, '[]', 'archived', 1, NULL)`);
    const lobby = await (await lobbyRoute(db, new URL('https://per/tables')))!.json();
    expect(lobby).toEqual([
      expect.objectContaining({ address: T, tableId: '18446744073709551615', open: true, live: true, inviteOnly: false, smallBlind: '5000', bigBlind: '10000', handNo: '7', seated: 2 }),
    ]);
    expect(await (await lobbyRoute(db, new URL(`https://per/tables?creator=${C}`)))!.json()).toHaveLength(1);
    expect(((await (await lobbyRoute(db, new URL(`https://per/tables/${T}`)))!.json()) as { address: string }).address).toBe(T);
    const hands = await (await lobbyRoute(db, new URL(`https://per/tables/${T}/hands?before=8`)))!.json();
    expect(hands).toEqual([{ handNo: '7', record: { handNo: '7' }, verified: true, buttonChecked: true, problems: [], log: { status: 'archived', verified: true }, archivedAt: expect.any(String) }]);
    expect(await (await lobbyRoute(db, new URL(`https://per/tables/${T}/hands?before=7`)))!.json()).toEqual([]);
    expect((await lobbyRoute(db, new URL('https://per/tables/not-an-address')))!.status).toBe(400);
    // Anything else is the container's.
    expect(await lobbyRoute(db, new URL(`https://per/tables/${T}/hands/7`))).toBeNull();
    expect(await lobbyRoute(db, new URL('https://per/health'))).toBeNull();
  });

  it('bridges one statement with blobs both ways, and reports errors', async () => {
    const { db } = perDb();
    const enc = btoa(String.fromCharCode(1, 2, 255));
    await runQuery(db, { sql: "INSERT INTO agents (wallet, agent_pub, agent_secret, settings, status, until) VALUES (?1, 'p', ?2, '{}', 'prepared', 0)", params: ['W', { $b: enc }] });
    const r = await runQuery(db, { sql: 'SELECT agent_secret FROM agents WHERE wallet = ?1', params: ['W'] });
    expect(r.rows).toEqual([{ agent_secret: { $b: enc } }]);
    expect((await runQuery(db, { sql: 'SELECT nope FROM agents' })).error).toMatch(/no such column/);
    expect((await runQuery(db, { sql: 'x'.repeat(30_000) })).error).toBe('bad sql');
  });
});
