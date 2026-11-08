import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer } from '../accounts';
import { integrityReport } from '../integrity';
import { recordHand } from '../progress';
import { recordDecisions, type DecisionRow } from '../strategies';
import { D1Shim } from '../testing/d1Shim';

const T0 = Date.UTC(2026, 10, 9, 0);
const HOUR = 3_600_000;
let db: D1Database;
let dumper: string;
let mule: string;
let fair1: string;
let fair2: string;

beforeEach(async () => {
  db = await D1Shim.migrated();
  [dumper, mule, fair1, fair2] = await Promise.all(['Dumper', 'Mule', 'Fair1', 'Fair2'].map(async (n) => (await createPlayer(db, { displayName: n }, T0)).id));
});

const hand = (p: string, table: string, n: number, net: number, at: number) => recordHand(db, p, { tableId: table, hand: n, won: net > 0, showdownCategory: null, net }, at);

describe('integrity leads', () => {
  it('finds one-way chip flow between a pair, not ordinary swings', async () => {
    for (let i = 1; i <= 20; i++) {
      await hand(dumper, 't1', i, -600, T0 + i * 60_000); // loses 600 to the mule every hand
      await hand(mule, 't1', i, 600, T0 + i * 60_000);
      const swing = i % 2 ? 400 : -400; // fair players trade wins back and forth
      await hand(fair1, 't2', i, swing, T0 + i * 60_000);
      await hand(fair2, 't2', i, -swing, T0 + i * 60_000);
    }
    const r = await integrityReport(db, { sinceMs: T0, now: T0 + 2 * HOUR });
    expect(r.chipDumping).toEqual([{ from: dumper, to: mule, coins: 12_000, oneWay: 1, handsTogether: 20 }]);
  });

  it('flags marathon accounts and robotic think times', async () => {
    for (let h = 0; h < 20; h++) await hand(fair1, 't3', h + 1, 10, T0 + h * HOUR + 5 * 60_000);
    const rows: DecisionRow[] = [];
    for (let i = 0; i < 220; i++) {
      const base = { table: 't3', handNo: i, street: 0, position: 1, opponents: 3, strength: 0.5, pot: 75, toCall: 50, minRaiseTo: 100, bigBlind: 50, stack: 1000, action: 'call' as const, amount: 0 };
      rows.push({ ...base, playerId: mule, thinkMs: 400 + (i % 3) * 10 }); // a script: fast and even
      rows.push({ ...base, playerId: fair2, thinkMs: 1200 + ((i * 7919) % 4000) }); // a person
    }
    for (let i = 0; i < rows.length; i += 200) await recordDecisions(db, rows.slice(i, i + 200), T0 + HOUR);
    const r = await integrityReport(db, { sinceMs: T0, now: T0 + 20 * HOUR });
    expect(r.marathons).toEqual([{ player: fair1, hoursInLastDay: 20, hands: 20 }]);
    expect(r.robotic.map((x) => x.player)).toEqual([mule]);
  });
});
