import { Keypair, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PerGameWallet } from '../per/gameWallet';
import { parsePending, PerWithdrawal, serializePending, WithdrawalPhase } from '../per/withdrawal';
import { installMemoryStorage } from './memoryStorage';

const walletKey = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;

/** A game wallet whose vault arrivals and balance the test sets; sends are recorded, never made. */
function fakeWallet(o: { balance: bigint | null; landed: bigint; sendFails?: Error }) {
  const sent: TransactionInstruction[][] = [];
  const gw = {
    address: walletKey as PublicKey | null,
    loadState: async () => ({ keySet: 0, seed: new Uint8Array(8) }),
    landed: async () => o.landed,
    balance: async () => o.balance,
    l1: {
      sendWithWallet: async (ixs: TransactionInstruction[]) => {
        sent.push(ixs);
        if (o.sendFails) throw o.sendFails;
        return 'sig';
      },
    },
    signer: {},
    hasPlayKey: () => false,
    playKey: async () => {
      throw new Error('no play key in tests');
    },
  };
  return { gw: gw as unknown as PerGameWallet, sent, o };
}

/** Lets the background watch run one poll at a time. */
function stepper() {
  const waiters: (() => void)[] = [];
  return {
    wait: () => new Promise<void>((r) => waiters.push(r)),
    async tick() {
      waiters.shift()?.();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('PerWithdrawal', () => {
  let store: Map<string, string>;
  let now: number;
  beforeEach(() => {
    store = installMemoryStorage();
    now = 1_800_000_000;
  });

  it('serializes Pending as Newtonsoft does, ulongs exact', () => {
    const p = { Wallet: 'W', Baseline: 18_446_744_073_709_551_615n, Expected: 5n, StartedAt: 1, LastChangeAt: 2, LastLanded: 3n, Confirmed: true, GiveUpAfter: 180, Paid: 0n };
    const s = serializePending(p);
    expect(s).toBe('{"Wallet":"W","Baseline":18446744073709551615,"Expected":5,"StartedAt":1,"LastChangeAt":2,"LastLanded":3,"Confirmed":true,"GiveUpAfter":180,"Paid":0}');
    expect(parsePending(s)).toEqual(p);
  });

  it('start saves the withdrawal before the wallet is asked, and a new instance resumes it', async () => {
    const st = stepper();
    const f = fakeWallet({ balance: 3_000_000n, landed: 1_000n });
    const w = new PerWithdrawal(f.gw, { auto: false, nowSeconds: () => now, wait: st.wait });
    let changes = 0;
    w.onChanged(() => changes++);
    const statuses: string[] = [];
    expect(await w.start((s) => statuses.push(s))).toBe(3_000_000n);
    expect(f.sent.length).toBe(1);
    expect(statuses[0]).toBe('Approve taking $30 out of the game balance in your wallet…');
    const saved = parsePending(store.get(PerWithdrawal.PREF_KEY)!);
    expect(saved).toMatchObject({ Wallet: walletKey.toBase58(), Baseline: 1_000n, Expected: 3_001_000n, Confirmed: true, GiveUpAfter: 0 });
    expect(w.current).toBe(WithdrawalPhase.OnTheWay);
    expect(w.amount).toBe(3_000_000n);
    expect(changes).toBeGreaterThan(0);
    expect(await w.start(() => {})).toBe(0n); // one at a time

    // After a reload: a fresh instance reads the saved withdrawal.
    const st2 = stepper();
    const f2 = fakeWallet({ balance: 0n, landed: 1_000n });
    const w2 = new PerWithdrawal(f2.gw, { auto: false, nowSeconds: () => now, wait: st2.wait });
    expect(w2.current).toBe(WithdrawalPhase.OnTheWay);
    expect(w2.wallet).toBe(walletKey.toBase58());
    w2.resume();
    await flush();
    f2.o.landed = 3_001_000n; // everything arrived
    await st2.tick();
    expect(w2.arrived).toBe(3_001_000n);
    expect(w2.current).toBe(WithdrawalPhase.Ready);
  });

  it('a partial arrival is ready after it has been quiet for a while', async () => {
    const st = stepper();
    const f = fakeWallet({ balance: 2_000_000n, landed: 0n });
    const w = new PerWithdrawal(f.gw, { auto: false, nowSeconds: () => now, wait: st.wait });
    await w.start(() => {});
    await flush();
    f.o.landed = 1_500_000n;
    await st.tick();
    expect(w.current).toBe(WithdrawalPhase.OnTheWay);
    now += 61; // quiet 61 s but started only 61 s ago
    await st.tick();
    expect(w.current).toBe(WithdrawalPhase.OnTheWay);
    now += 30; // 91 s since start, 91 s quiet
    expect(w.current).toBe(WithdrawalPhase.Ready);
    expect(w.slow).toBe(false);
  });

  it('a refused exit clears the saved withdrawal; an unconfirmed one is watched, then dropped', async () => {
    const refused = fakeWallet({ balance: 1_000n, landed: 0n, sendFails: new Error('User rejected') });
    const w = new PerWithdrawal(refused.gw, { auto: false, nowSeconds: () => now, wait: () => new Promise(() => {}) });
    await expect(w.start(() => {})).rejects.toThrow('User rejected');
    expect(store.has(PerWithdrawal.PREF_KEY)).toBe(false);
    expect(w.current).toBe(WithdrawalPhase.None);

    const st = stepper();
    const timedOut = fakeWallet({ balance: 1_000n, landed: 0n, sendFails: new Error('transaction abc not confirmed in 30 s') });
    const w2 = new PerWithdrawal(timedOut.gw, { auto: false, nowSeconds: () => now, wait: st.wait });
    expect(await w2.start(() => {})).toBe(1_000n);
    expect(parsePending(store.get(PerWithdrawal.PREF_KEY)!)).toMatchObject({ Confirmed: false, GiveUpAfter: 180 });
    await flush();
    now += 181;
    await st.tick();
    expect(w2.current).toBe(WithdrawalPhase.None);
    expect(store.has(PerWithdrawal.PREF_KEY)).toBe(false);
  });

  it('finish pays out what arrived and keeps watching the rest', async () => {
    const f = fakeWallet({ balance: 0n, landed: 0n });
    store.set(PerWithdrawal.PREF_KEY, serializePending({ Wallet: walletKey.toBase58(), Baseline: 0n, Expected: 5_000n, StartedAt: now, LastChangeAt: now, LastLanded: 0n, Confirmed: true, GiveUpAfter: 0, Paid: 0n }));
    const w = new PerWithdrawal(f.gw, { auto: false, nowSeconds: () => now, wait: () => new Promise(() => {}) });
    await expect(w.finish(() => {})).rejects.toThrow("nothing has arrived yet; it's still on its way");
    f.o.landed = 3_000n;
    expect(await w.finish(() => {})).toBe(3_000n);
    expect(f.sent.length).toBe(1);
    expect(parsePending(store.get(PerWithdrawal.PREF_KEY)!)).toMatchObject({ Baseline: 0n, Expected: 2_000n, GiveUpAfter: 900 });
    f.o.landed = 2_000n;
    expect(await w.finish(() => {})).toBe(2_000n);
    expect(store.has(PerWithdrawal.PREF_KEY)).toBe(false);
    expect(w.current).toBe(WithdrawalPhase.None);
  });

  it('an empty balance with money at the vault is ready at once', async () => {
    const f = fakeWallet({ balance: 0n, landed: 700n });
    const w = new PerWithdrawal(f.gw, { auto: false, nowSeconds: () => now, wait: () => new Promise(() => {}) });
    expect(await w.start(() => {})).toBe(0n);
    expect(w.current).toBe(WithdrawalPhase.Ready);
    expect(f.sent.length).toBe(0);
    const empty = fakeWallet({ balance: null, landed: 0n });
    store.clear();
    const msgs: string[] = [];
    expect(await new PerWithdrawal(empty.gw, { auto: false }).start((s) => msgs.push(s))).toBe(0n);
    expect(msgs).toEqual(['Your game balance is empty.']);
  });
});
