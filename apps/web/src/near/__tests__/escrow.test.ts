import { describe, expect, it } from 'vitest';
import { CHIP_YOCTO, HOUSE_TABLES, buyInError, buyInPlan, chipsToYocto, getBalance, getSeat, getTable, isNearMoneyRoom, yoctoToChips, type EscrowTable } from '../escrow';

const NEAR = 10n ** 24n;

/** A fake NEAR RPC answering `call_function` with `answer(method, args)` as the contract's JSON. */
function rpc(answer: (method: string, args: Record<string, unknown>) => unknown) {
  const calls: { account: string; method: string; args: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)).params;
    const args = JSON.parse(atob(p.args_base64));
    calls.push({ account: p.account_id, method: p.method_name, args });
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(answer(p.method_name, args))));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'nomad', result: { result: bytes, logs: [] } }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const table = (over: Partial<EscrowTable> = {}): EscrowTable => ({
  table_id: 'poker-money-st50', host: null, config: HOUSE_TABLES[0]!.config, invite_only: false, closed: false, finalized: false, seated: 2,
  bought_in: '0', rake: '0', locked: '0', paid: '0', outstanding: '0', remainder: '0', buy_ins: 0, cash_outs: 0, created_at: '0', ...over,
});

describe('escrow views', () => {
  it('reads the balance as yoctoNEAR from the escrow contract', async () => {
    const { fetchImpl, calls } = rpc(() => '1500000000000000000000000');
    expect(await getBalance('alice.testnet', fetchImpl)).toBe(1_500_000_000_000_000_000_000_000n);
    expect(calls).toEqual([{ account: 'escrow.nomad-poker.testnet', method: 'get_balance', args: { account: 'alice.testnet' } }]);
  });

  it('reads a table and a seat (null when there is none)', async () => {
    const { fetchImpl, calls } = rpc((m) => (m === 'get_table' ? table({ seated: 3 }) : null));
    expect((await getTable('poker-money-st50', fetchImpl))?.seated).toBe(3);
    expect(await getSeat('poker-money-st50', 'bob.testnet', fetchImpl)).toBeNull();
    expect(calls[1]).toMatchObject({ method: 'get_seat', args: { table_id: 'poker-money-st50', player: 'bob.testnet' } });
  });

  it('surfaces a contract error', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ result: { error: 'wasm execution failed' } }))) as unknown as typeof fetch;
    await expect(getBalance('x.testnet', fetchImpl)).rejects.toThrow('wasm execution failed');
  });
});

describe('escrow amounts', () => {
  it('house tables are the Micro, Low and Mid stakes with the escrow room names', () => {
    expect(HOUSE_TABLES.map((t) => [t.id, t.config.small_blind, t.config.big_blind, t.config.min_buy_in, t.config.max_buy_in, t.config.seats])).toEqual([
      ['poker-money-st50', 1, 2, 50, 200, 6],
      ['poker-money-st100', 2, 5, 100, 500, 6],
      ['poker-money-st500', 10, 25, 500, 2500, 6],
    ]);
    expect(HOUSE_TABLES.every((t) => isNearMoneyRoom(t.id))).toBe(true);
    expect(isNearMoneyRoom('poker-free-st50')).toBe(false);
  });

  it('a chip is 0.001 NEAR; seats play whole chips, rounded down', () => {
    expect(chipsToYocto(100)).toBe(NEAR / 10n);
    expect(yoctoToChips('95000000000000000000000')).toBe(95);
    expect(yoctoToChips(CHIP_YOCTO * 95n + CHIP_YOCTO - 1n)).toBe(95);
  });

  it('pays from the game balance first, the rest from the wallet, 5% rake', () => {
    const p = buyInPlan(100, 30n * CHIP_YOCTO);
    expect(p.amount).toBe(100n * CHIP_YOCTO);
    expect(p.fromBalance).toBe(30n * CHIP_YOCTO);
    expect(p.attach).toBe(70n * CHIP_YOCTO);
    expect(p.rake).toBe(5n * CHIP_YOCTO);
    expect(yoctoToChips(p.locked)).toBe(95);
  });

  it('attaches nothing when the balance covers it, everything when it is empty', () => {
    expect(buyInPlan(50, NEAR).attach).toBe(0n);
    expect(buyInPlan(50, 0n).attach).toBe(50n * CHIP_YOCTO);
    // An odd buy-in: the rake rounds down like the contract's, the seat keeps the rest.
    const odd = buyInPlan(51, 0n);
    expect(odd.rake + odd.locked).toBe(51n * CHIP_YOCTO);
    expect(odd.rake).toBe((51n * CHIP_YOCTO * 500n) / 10_000n);
  });

  it('checks the buy-in against the table', () => {
    const c = HOUSE_TABLES[0]!.config;
    expect(buyInError('100', c, table(), null)).toBeNull();
    expect(buyInError('49', c, table(), null)).toMatch(/minimum buy-in is 50/);
    expect(buyInError('201', c, table(), null)).toMatch(/maximum buy-in is 200/);
    expect(buyInError('1.5', c, table(), null)).toMatch(/whole number/);
    expect(buyInError('100', c, table({ seated: 6 }), null)).toMatch(/full/);
    expect(buyInError('100', c, table({ closed: true }), null)).toMatch(/closed/);
    expect(buyInError('100', c, null, null)).toMatch(/isn't open/);
    // A top-up: no minimum, but everything bought in counts toward the maximum.
    const seat = { bought_in: (150n * CHIP_YOCTO).toString(), locked: (142n * CHIP_YOCTO).toString() };
    expect(buyInError('10', c, table({ seated: 6 }), seat)).toBeNull();
    expect(buyInError('51', c, table(), seat)).toMatch(/already bought in 150/);
  });
});
