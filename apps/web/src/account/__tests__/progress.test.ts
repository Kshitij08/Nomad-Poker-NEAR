import { afterEach, describe, expect, it } from 'vitest';
import type { ProgressSnapshot, SpinResponse } from '@nomad/contract';
import { EventBus } from '../../app/app';
import { RewardGrant } from '../../app/services';
import { VirtualEconomy } from '../../economy/virtualEconomy';
import { RetentionService } from '../../retention/retentionService';
import { NomadProgress, NomadWallet } from '../progress';
import type { NomadSession } from '../session';

const snap = (over: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  balances: { coins: 12_000, gems: 3, xp: 150, streak_tokens: 1 },
  items: ['frame_lv10'],
  today: 20_400,
  level: 2,
  rewardedLevel: 2,
  spin: { canSpin: true, lastSpinDay: 0, lastSpinCoins: 0 },
  login: { lastLoginDay: 0, streakDay: 0, canClaim: true, day: 1, tokensAfter: 1, tokenConsumed: false, reset: false, error: '' },
  missions: { dayNumber: 20_400, weekNumber: 2914, slots: [{ id: 'daily_warmup_10', progress: 10, claimed: false }] },
  ...over,
});

/** A session stand-in that answers the progress routes like the API does. */
function fakeSession(handlers: Record<string, () => unknown>, calls: string[] = []): NomadSession {
  return {
    signedIn: true,
    me: null,
    call: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const h = handlers[path];
      if (!h) throw new Error(`no route ${path}`);
      return h();
    },
  } as unknown as NomadSession;
}

const memPrefs = () => {
  const m = new Map<string, string>();
  return {
    getString: (k: string, f = '') => m.get(k) ?? f,
    setString: (k: string, v: string) => void m.set(k, v),
    getInt: (k: string, f = 0) => (m.has(k) ? Number(m.get(k)) : f),
    setInt: (k: string, v: number) => void m.set(k, String(v)),
  };
};

afterEach(() => VirtualEconomy.resetForTests());

describe('server mode', () => {
  it('shows server balances and refuses every client-side grant or spend', async () => {
    const events = new EventBus();
    const progress = new NomadProgress(fakeSession({ '/v1/progress': () => snap() }), events);
    await progress.refresh();
    const wallet = new NomadWallet(progress, fakeSession({}));
    VirtualEconomy.setProvider(wallet);
    expect([wallet.coins, wallet.gems, wallet.xp, wallet.streakTokens]).toEqual([12_000, 3, 150, 1]);
    expect(wallet.owns('frame_lv10')).toBe(true);

    wallet.grant(RewardGrant.coins(1_000_000, 'cheat'));
    expect(wallet.tryGrant(RewardGrant.xp(99_999, 'cheat'))).toBe(false);
    expect(wallet.tryConsumeStreakToken()).toBe(false);
    VirtualEconomy.grant(RewardGrant.cosmetic('frame_lv100', 'cheat'));
    expect(VirtualEconomy.trySpendCoins(500, 'agent_bankroll')).toBe(false);
    VirtualEconomy.creditFreePlay(5000);
    expect([wallet.coins, wallet.xp, wallet.owns('frame_lv100')]).toEqual([12_000, 150, false]);
  });

  it('spins, claims and reads missions through the server; table hooks record nothing', async () => {
    const events = new EventBus();
    const calls: string[] = [];
    let current = snap();
    const session = fakeSession(
      {
        '/v1/progress': () => current,
        '/v1/rewards/spin': (): SpinResponse => {
          current = snap({ balances: { ...current.balances, coins: current.balances.coins + 2000 }, spin: { canSpin: false, lastSpinDay: 20_400, lastSpinCoins: 2000 } });
          return { awarded: true, coins: 2000, label: 'Hot Streak', error: '', progress: current };
        },
        '/v1/missions/claim': () => {
          current = snap({ missions: { ...current.missions, slots: [{ id: 'daily_warmup_10', progress: 10, claimed: true }] } });
          return { ok: true, message: 'Claimed! +500 Coins, +50 XP', progress: current };
        },
      },
      calls,
    );
    const progress = new NomadProgress(session, events);
    await progress.refresh();
    const wallet = new NomadWallet(progress, session);
    const svc = new RetentionService({ events, wallet: () => wallet, prefs: memPrefs(), roll: () => 999 });
    svc.setBackend(progress);

    expect(svc.engagement.canSpin()).toBe(true);
    const spun = await svc.engagement.spin();
    expect(spun).toMatchObject({ awarded: true, prize: { coins: 2000, label: 'Hot Streak' } });
    expect(svc.engagement.canSpin()).toBe(false);
    expect(wallet.coins).toBe(14_000);

    expect(svc.missionRows('daily').find((r) => r.def.id === 'daily_warmup_10')?.canClaim).toBe(true);
    expect(await svc.progression.claimMission('daily_warmup_10')).toEqual({ ok: true, message: 'Claimed! +500 Coins, +50 XP' });
    expect(svc.missionRows('daily').find((r) => r.def.id === 'daily_warmup_10')?.claimed).toBe(true);

    // The local table hooks are inert: the game server counts hands.
    svc.progression.recordHandPlayed();
    svc.progression.recordHandWon();
    svc.progression.addXp(500, 'cheat');
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /v1/rewards/spin', 'POST /v1/missions/claim']);
    expect(svc.progression.level).toBe(2);
  });

  it('keeps local rules when no server is configured', async () => {
    const events = new EventBus();
    let coins = 0;
    const local = { coins: 0, gems: 0, xp: 0, streakTokens: 0, ownedItems: [], canAfford: () => true, owns: () => false, tryConsumeStreakToken: () => false,
      grant: (g: RewardGrant) => void (coins += g.amount), tryGrant: (g: RewardGrant) => ((coins += g.amount), true) };
    const svc = new RetentionService({ events, wallet: () => local, prefs: memPrefs(), roll: () => 0 });
    const r = await svc.engagement.spin();
    expect(r.awarded).toBe(true);
    expect(coins).toBe(r.prize.coins);
  });
});
