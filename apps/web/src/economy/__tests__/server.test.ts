/** The offline chip ledger (PlayFabChipLedger rules) and the CloudScript ports (friends.js, economy.js). */
import { describe, expect, it } from 'vitest';
import { TitleChipLedger, readGrantLog } from '../server/chipLedger';
import { createPlayer, memoryTitle, type TitleStateHandle } from '../server/titleState';

const quiet = { log: () => {} };
const A = 'AAAA000011112222';
const B = 'BBBB000011112222';

function title(): TitleStateHandle {
  const t = memoryTitle();
  createPlayer(t.state, { id: A, displayName: 'Alice' });
  createPlayer(t.state, { id: B, displayName: 'Bob' });
  return t;
}

describe('TitleChipLedger (Economy/Server/PlayFabChipLedger.cs)', () => {
  it('welcomes a first-time player once, then buys in / cashes out under the seat lock', async () => {
    const t = title();
    const ledger = new TitleChipLedger(t, quiet);
    expect(await ledger.getBalanceAsync(A)).toBe(10000);
    expect(readGrantLog(t.state.players[A]!).welcomed).toBe(true);

    const buy = await ledger.debitBuyInAsync(A, 'T1', 3, 2000);
    expect(buy).toEqual({ success: true, error: null, balance: 8000 });
    expect((await ledger.debitBuyInAsync(A, 'T1', 3, 2000)).error).toBe('Already seated at this table.');
    expect((await ledger.debitBuyInAsync(A, 'T2', 1, 100)).error).toBe("You're already sitting at another table.");

    expect((await ledger.checkpointAsync(A, 'T1', 3, 2600, 4)).success).toBe(true);
    expect((await ledger.creditCashOutAsync(A, 'T2', 2600)).error).toBe('No seat to cash out.');
    const out = await ledger.creditCashOutAsync(A, 'T1', 2600);
    expect(out.balance).toBe(10600);
    expect(t.state.players[A]!.objects.SeatLock).toBeUndefined();
    expect((await ledger.creditCashOutAsync(A, 'T1', 2600)).success).toBe(false); // replay mints nothing
    // Spent to zero and read again: the welcomed flag means no second welcome.
    await ledger.debitBuyInAsync(A, 'T3', 0, 10600);
    await ledger.creditCashOutAsync(A, 'T3', 0);
    expect(await ledger.getBalanceAsync(A)).toBe(0);
  });

  it('refuses an unaffordable buy-in with the balance', async () => {
    const ledger = new TitleChipLedger(title(), quiet);
    expect(await ledger.debitBuyInAsync(A, 'T1', 0, 20000)).toEqual({ success: false, error: 'Not enough chips.', balance: 10000 });
    expect((await ledger.debitBuyInAsync(A, 'T1', 0, 0)).error).toBe('Buy-in must be positive.');
  });

  it('reconcile: a seated lock pays the recorded stack, an ambiguous one pays nothing', async () => {
    const t = title();
    const ledger = new TitleChipLedger(t, quiet);
    await ledger.debitBuyInAsync(A, 'T1', 0, 3000);
    await ledger.checkpointAsync(A, 'T1', 0, 4200, 9);
    expect((await ledger.reconcileAsync(A)).balance).toBe(11200);
    await ledger.debitBuyInAsync(B, 'T1', 1, 1000);
    t.state.players[B]!.objects.SeatLock = { tableId: 'T1', seat: 1, stack: 1000, handNumber: 0, state: 'buying-in' };
    expect(await ledger.reconcileAsync(B)).toEqual({ success: true, error: null, balance: -1 });
    expect(await ledger.getBalanceAsync(B)).toBe(9000);
  });

  it('grants pay once per idempotency key', async () => {
    const t = title();
    const ledger = new TitleChipLedger(t, quiet);
    expect((await ledger.grantAsync(A, 500, 'daily_spin', 'k1')).balance).toBe(10500);
    expect((await ledger.grantAsync(A, 500, 'daily_spin', 'k1')).balance).toBe(10500);
    expect((await ledger.grantAsync(A, 500, 'daily_spin', '')).error).toBe('Grants need an idempotency key.');
  });

  it('authenticates live session tickets only', async () => {
    const t = title();
    t.state.sessions.good = { playFabId: A, expires: Date.now() + 60_000 };
    t.state.sessions.old = { playFabId: A, expires: Date.now() - 1 };
    const ledger = new TitleChipLedger(t, quiet);
    expect(await ledger.authenticateAsync('good')).toBe(A);
    expect(await ledger.authenticateAsync('old')).toBeNull();
    expect(await ledger.authenticateAsync('nope')).toBeNull();
  });
});
