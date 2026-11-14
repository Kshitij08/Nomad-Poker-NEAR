import { describe, expect, it } from 'vitest';
import { EventBus } from '../../app/app';
import { RewardKind, type RewardGrant, type VirtualWallet } from '../../app/services';
import { HandCategory } from '@nomad/engine/evaluation/handCategory';
import { HandValue } from '@nomad/engine/evaluation/handValue';
import type { PokerEvent, SeatSnapshot } from '@nomad/engine/events/pokerEvent';
import { RetentionService } from '../retentionService';
import type { PrefsLike } from '../dailyEngagement';

/** Tiny in-memory IVirtualWallet. */
class MemoryWallet implements VirtualWallet {
  coins = 0;
  gems = 0;
  xp = 0;
  streakTokens = 0;
  ownedItems: string[] = [];
  refuse = false;
  canAfford = (c: number) => this.coins >= c;
  grant(g: RewardGrant): void {
    if (g.kind === RewardKind.Coins) this.coins += g.amount;
    else if (g.kind === RewardKind.Gems) this.gems += g.amount;
    else if (g.kind === RewardKind.Xp) this.xp += g.amount;
    else if (g.kind === RewardKind.StreakToken) this.streakTokens += g.amount;
    else this.ownedItems.push(g.itemId);
  }
  tryGrant(g: RewardGrant): boolean {
    if (this.refuse) return false;
    this.grant(g);
    return true;
  }
  tryConsumeStreakToken(): boolean {
    if (this.streakTokens <= 0) return false;
    this.streakTokens--;
    return true;
  }
  owns = (id: string) => this.ownedItems.includes(id);
}

function memPrefs(): PrefsLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (k, f = '') => map.get(k) ?? f,
    setString: (k, v) => void map.set(k, v),
    getInt: (k, f = 0) => (map.has(k) ? Number.parseInt(map.get(k)!, 10) : f),
    setInt: (k, v) => void map.set(k, String(Math.trunc(v))),
  };
}

const DAY = 86_400_000;
function setup(day = 20000, roll = 0) {
  const wallet = new MemoryWallet();
  const prefs = memPrefs();
  let now = day * DAY + 3_600_000;
  const shown: number[] = [];
  const events = new EventBus();
  const r = new RetentionService({ events, wallet: () => wallet, prefs, clock: () => now, roll: () => roll, showLevelUp: (lv) => shown.push(lv) });
  return { r, wallet, prefs, shown, events, advanceDays: (n: number) => (now += n * DAY) };
}

describe('DailyEngagement', () => {
  it('spins once per UTC day, credits the wallet, persists with the C# keys', () => {
    const { r, wallet, prefs, advanceDays } = setup(20000, 280);
    let changed = 0;
    r.env.events.on('engagement:changed', () => changed++);
    expect(r.engagement.canSpin()).toBe(true);
    const res = r.engagement.trySpin();
    expect([res.awarded, res.prize.coins, res.prize.label]).toEqual([true, 500, 'Small Stack']);
    expect(wallet.coins).toBe(500);
    expect(prefs.map.get('Poker.Engage.LastSpinDay')).toBe('20000');
    expect(prefs.map.get('Poker.Engage.LastSpinCoins')).toBe('500');
    expect(r.engagement.canSpin()).toBe(false);
    expect(r.engagement.trySpin().error).toBe('Come back tomorrow for another spin.');
    expect(changed).toBe(1);
    advanceDays(1);
    expect(r.engagement.canSpin()).toBe(true);
  });
  it('does not mark the day spun when the wallet refuses the credit', () => {
    const { r, wallet } = setup();
    wallet.refuse = true;
    expect(r.engagement.trySpin().awarded).toBe(false);
    expect(r.engagement.canSpin()).toBe(true);
  });
  it('degrades without a wallet', () => {
    const r = new RetentionService({ events: new EventBus(), wallet: () => undefined, prefs: memPrefs(), clock: () => 20000 * DAY });
    expect(r.engagement.trySpin().awarded).toBe(false);
    expect(r.engagement.tryClaimLogin().canClaim).toBe(false);
    expect(r.progression.level).toBe(1);
    r.progression.recordHandPlayed();
    expect(r.progression.missionBoard.slots[0]!.progress).toBe(1);
  });
  it('claims the login track day by day, with a shield covering a one-day miss', () => {
    const { r, wallet, advanceDays } = setup();
    expect(r.engagement.tryClaimLogin().day).toBe(1);
    expect(wallet.coins).toBe(500);
    expect(r.engagement.previewLogin().canClaim).toBe(false);
    advanceDays(1);
    expect(r.engagement.tryClaimLogin().day).toBe(2);
    advanceDays(1);
    expect(r.engagement.tryClaimLogin().day).toBe(3); // 100 XP
    wallet.streakTokens = 1;
    advanceDays(2); // missed one day
    const p = r.engagement.tryClaimLogin();
    expect([p.day, p.tokenConsumed]).toEqual([4, true]);
    expect(wallet.streakTokens).toBe(0);
    expect(wallet.coins).toBe(500 + 750 + 1000);
  });
});

describe('PlayerProgression', () => {
  it('awards XP per hand and per win, levels up with rewards and queues the celebration', () => {
    const { r, wallet, shown } = setup();
    for (let i = 0; i < 10; i++) r.progression.recordHandPlayed(); // 100 XP → level 2
    expect(wallet.xp).toBe(100);
    expect(r.progression.level).toBe(2);
    expect(wallet.coins).toBe(125); // LevelRewardCatalog level 2
    expect(shown).toEqual([2]);
    expect(r.progression.lastLevelUpToast).toBe('Lv 2 +125 coins');
    const rows = r.missionRows('daily');
    expect(rows[0]).toMatchObject({ progress: 10, done: true, canClaim: true, state: 'Tap to claim', reward: '+500 Coins, +50 XP' });
    expect(r.progression.tryClaimMission('daily_warmup_10')).toEqual({ ok: true, message: 'Claimed! +500 Coins, +50 XP' });
    expect(r.progression.tryClaimMission('daily_warmup_10')).toEqual({ ok: false, message: 'Not ready to claim.' });
    expect(wallet.coins).toBe(625);
    expect(r.missionRows('weekly')[0]!.progress).toBe(10);
  });
  it('queues several levels gained at once and shows them one by one', () => {
    const { r, shown } = setup();
    r.levelUps.showing = false;
    r.progression.addXp(600, 'test'); // level 4
    expect(shown).toEqual([2]);
    expect(r.levelUps.pending).toEqual([3, 4]);
    expect(r.levelUps.next()).toBe(3);
  });
  it('does not celebrate a level again when the reading dips and comes back (leaving a table)', () => {
    const { r, wallet, shown } = setup();
    r.progression.addXp(100, 'test'); // level 2
    expect(shown).toEqual([2]);
    r.levelUps.showing = false;
    const xp = wallet.xp;
    wallet.xp = 0; // the wallet reloads
    r.progression.notifyChanged();
    wallet.xp = xp;
    r.progression.notifyChanged();
    expect(shown).toEqual([2]);
    expect(r.levelUps.pending).toEqual([]);
  });
  it('takes the first server snapshot as the baseline, not as level ups', () => {
    const { r, wallet, shown } = setup();
    const backend = { snapshot: null as unknown, spin: async () => null, claimLogin: async () => null, claimMission: async () => null };
    r.setBackend(backend as never); // the snapshot is still loading: the wallet reads 0 XP
    wallet.xp = 3000; // the snapshot lands: a level 7 account
    backend.snapshot = { missions: null };
    r.progression.notifyChanged();
    expect(shown).toEqual([]);
    expect(r.levelUps.pending).toEqual([]);
    wallet.xp += 2000; // a real level up afterwards is still celebrated
    r.progression.notifyChanged();
    expect(shown.length).toBe(1);
  });
  it('does not celebrate or backfill a hydrated account', () => {
    const { r, wallet, shown } = setup();
    wallet.xp = 1000; // arrives from the cloud
    r.progression.reloadFromCloud();
    expect(shown).toEqual([]);
    expect(wallet.coins).toBe(0);
  });
  it('persists the board in the PlayerProgression string format', () => {
    const { r, prefs } = setup();
    r.progression.recordTableJoined('room-1');
    expect(prefs.map.get('Poker.Progress.Missions')).toContain('daily_table_tour_2:1:0');
    expect(prefs.map.get('Poker.Progress.Missions')!.endsWith('|room-1')).toBe(true);
  });
});

describe('TableProgressTracker (PokerClientGame hooks)', () => {
  const seat = (name: string, extra: Partial<SeatSnapshot> = {}): SeatSnapshot => ({ name, stack: 1000, isOccupied: true, isBusted: false, isBot: false, isAgent: false, isPendingNextHand: false, isLeaving: false, avatar: 0, ...extra });
  const hand = (seats: SeatSnapshot[]): PokerEvent => ({ type: 'HandStarted', handNumber: 1, buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2, seats });
  it('counts hands, wins once per hand, showdown categories, tables and friends', () => {
    const { r, wallet } = setup();
    const seats = [seat('Me'), seat('Pal'), seat('Bot 1', { isBot: true })];
    const t = r.trackTable({ localSeat: 0, roomCode: 'poker-free-st100', playerName: 'Me', isFriend: (n) => n === 'Pal' });
    t.onEvent({ type: 'TableRoster', seats });
    t.onEvent(hand(seats));
    t.onEvent({ type: 'Showdown', board: [], entries: [{ seat: 0, card0: null!, card1: null!, value: new HandValue(HandCategory.TwoPair, 10, 5, 2), description: '' }] });
    t.onEvent({ type: 'PotAwarded', seat: 0, seatName: 'Me', amount: 100, stackAfter: 1100, potAfter: 50, reason: 'Main pot' });
    t.onEvent({ type: 'PotAwarded', seat: 0, seatName: 'Me', amount: 50, stackAfter: 1150, potAfter: 0, reason: 'Side pot' });
    t.onEvent({ type: 'HandEnded', handNumber: 1 });
    const byId = Object.fromEntries(r.missionRows().map((x) => [x.def.id, x.progress]));
    expect(byId).toMatchObject({ daily_warmup_10: 1, daily_hot_hand_3: 1, daily_pair_power: 1, weekly_two_pair_3: 1, weekly_grinder_40: 1, daily_buddy: 1 });
    expect(wallet.xp).toBe(10 + 25);
    expect(byId.daily_table_tour_2).toBe(1); // counted when seated (constructor), once per room per UTC day
  });
  it('ignores money tables', () => {
    const { r, wallet } = setup();
    const t = r.trackTable({ localSeat: 0, moneyTable: true, roomCode: 'sol' });
    t.onEvent(hand([seat('Me')]));
    expect(wallet.xp).toBe(0);
  });
});
