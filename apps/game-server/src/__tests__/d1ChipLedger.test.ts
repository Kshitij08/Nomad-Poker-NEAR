/**
 * The table's chip ledger when D1 refuses work for a while ("D1 DB is overloaded", an export, a restart). The 9 Nov
 * load test at 20× speed: 95 cash-outs and over 1,000 stack checkpoints failed on the first try and were never tried
 * again, leaving seat locks with stale stacks. Cash-outs, checkpoints and lock recovery now retry; a retry never pays
 * twice, even when an earlier try was written but its answer was lost.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayer } from '@nomad/db/accounts';
import { balances, entries } from '@nomad/db/ledger';
import { buyIn, checkpoint, seatLock } from '@nomad/db/seatLocks';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { D1ChipLedger } from '../d1ChipLedger';

const OVERLOADED = 'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window';

/**
 * A D1 that refuses the next `refuse` calls (after letting `pass` through), or writes and then loses the answer for the
 * next `loseAnswer` calls.
 */
function flaky(db: D1Database) {
  const ctl = { refuse: 0, loseAnswer: 0, pass: 0 };
  const gate = async <T>(run: () => Promise<T>): Promise<T> => {
    if (ctl.pass > 0) ctl.pass--;
    else if (ctl.refuse > 0) {
      ctl.refuse--;
      throw new Error(OVERLOADED);
    }
    const r = await run();
    if (ctl.loseAnswer > 0) {
      ctl.loseAnswer--;
      throw new Error('Network connection lost.');
    }
    return r;
  };
  const stmt = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, k) {
        if (k === 'bind') return (...a: unknown[]) => stmt(t.bind(...a));
        if (k === 'run' || k === 'first' || k === 'all') return (...a: unknown[]) => gate(() => (t[k] as (...x: unknown[]) => Promise<unknown>)(...a));
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  const wrapped = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => stmt(t.prepare(sql));
      if (k === 'batch') return (stmts: D1PreparedStatement[]) => gate(() => t.batch(stmts));
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { db: wrapped, ctl };
}

let raw: D1Database;
let f: ReturnType<typeof flaky>;
let logs: string[];
let waited: number[];
let ledger: D1ChipLedger;
let pid: string;
const TABLE = 't-retrytest';

beforeEach(async () => {
  raw = await D1Shim.migrated();
  f = flaky(raw);
  logs = [];
  waited = [];
  ledger = new D1ChipLedger(f.db, 'qa-retry', async () => false, (level, m) => void logs.push(`${level}: ${m}`), async (ms) => void waited.push(ms));
  pid = (await createPlayer(raw, { displayName: 'Rita' })).id;
  // Start from a known balance, then sit down with 500.
  await raw.prepare("INSERT INTO ledger_entries (player_id, currency, delta, reason, idempotency_key, created_at) VALUES (?1, 'coins', 10000, 'test', 'seed', 0)").bind(pid).run();
  expect((await buyIn(raw, { playerId: pid, tableId: TABLE, room: 'qa-retry', seat: 2, chips: 500 })).ok).toBe(true);
});

const coins = async () => (await balances(raw, pid)).coins;
const cashOutEntries = async () => (await entries(raw, pid, { limit: 50 })).entries.filter((e) => e.reason === 'table:cash_out');

describe('D1ChipLedger when D1 refuses work', () => {
  it('a cash-out rides out a few refusals', async () => {
    const before = await coins();
    f.ctl.refuse = 3;
    const r = await ledger.creditCashOutAsync(pid, TABLE, 740);
    expect(r.success).toBe(true);
    expect(await coins()).toBe(before + 740);
    expect(await seatLock(raw, pid)).toBeNull();
    expect(waited.length).toBe(3);
  });

  it('a cash-out whose answer was lost is not paid twice', async () => {
    const before = await coins();
    f.ctl.loseAnswer = 1; // the first try is written, then the connection drops
    const r = await ledger.creditCashOutAsync(pid, TABLE, 740);
    expect(r.success).toBe(true);
    expect(await coins()).toBe(before + 740);
    expect(await cashOutEntries()).toHaveLength(1);
  });

  it('gives up after its budget, and the seat lock still covers the stack', async () => {
    f.ctl.refuse = 1000;
    const r = await ledger.creditCashOutAsync(pid, TABLE, 740);
    expect(r.success).toBe(false);
    expect((await seatLock(raw, pid))?.stack).toBe(500);
    expect(logs.some((l) => l.startsWith('error:') && l.includes('GAVE UP'))).toBe(true);
    // Real time, with backoff: about 15 s in all, never a tight loop.
    expect(waited.reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000);
  });

  it('a checkpoint rides out refusals, so a recovered lock pays the latest stack', async () => {
    f.ctl.refuse = 2;
    const r = await ledger.checkpointAsync(pid, TABLE, 2, 812, 7);
    expect(r.success).toBe(true);
    expect((await seatLock(raw, pid))?.stack).toBe(812);
  });

  it('recovering a stranded lock rides out refusals and pays once', async () => {
    await checkpoint(raw, { playerId: pid, tableId: TABLE, seat: 2, stack: 650, handNumber: 3 });
    const before = await coins();
    f.ctl.refuse = 2;
    f.ctl.loseAnswer = 0;
    const r = await ledger.reconcileAsync(pid);
    expect(r.success).toBe(true);
    expect(await coins()).toBe(before + 650);
    expect(await seatLock(raw, pid)).toBeNull();
  });

  it('a buy-in that was written stays a success when the balance read after it is refused', async () => {
    const other = (await createPlayer(raw, { displayName: 'Ola' })).id;
    await raw.prepare("INSERT INTO ledger_entries (player_id, currency, delta, reason, idempotency_key, created_at) VALUES (?1, 'coins', 1000, 'test', 'seed', 0)").bind(other).run();
    f.ctl.pass = 1; // the buy-in batch goes through…
    f.ctl.refuse = 1; // …and the balance read right after it is refused (staging, 9 Nov: six players left unseated)
    const r = await ledger.debitBuyInAsync(other, TABLE, 3, 500);
    expect(r.success).toBe(true);
    expect(r.balance).toBe(-1); // unknown: the table skips the balance push
    expect((await seatLock(raw, other))?.stack).toBe(500);
  });

  it("a refused buy-in is not retried: the player sees it and can try again", async () => {
    const other = (await createPlayer(raw, { displayName: 'Otto' })).id;
    await raw.prepare("INSERT INTO ledger_entries (player_id, currency, delta, reason, idempotency_key, created_at) VALUES (?1, 'coins', 1000, 'test', 'seed', 0)").bind(other).run();
    f.ctl.refuse = 1;
    const r = await ledger.debitBuyInAsync(other, TABLE, 3, 500);
    expect(r.success).toBe(false);
    expect(waited).toEqual([]);
  });
});
