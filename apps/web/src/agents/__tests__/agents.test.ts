import { describe, expect, it } from 'vitest';
import {
  AgentHandReplay, AgentStopReasons, AgentStrategyState, buildAgentConfig, newAgentDeploymentConfig, type KeyValueStore,
} from '../../core/agents';
import { LocalAgentBackend } from '../agentBackend';
import { AgentDeployService, type Prefs } from '../agentDeployService';
import { AgentFarm, startRequestOf, type AgentMoney } from '../server/agentFarm';
import { HeadlessAgentTable } from '../server/localAgentRunner';
import { replayToEvents, mapReplaySeats } from '../replayEvents';
import { StakeCatalog } from '../../core/stakes/stakes';

class MemPrefs implements Prefs, KeyValueStore {
  readonly map = new Map<string, string>();
  getString(k: string, fb = ''): string {
    return this.map.get(k) ?? fb;
  }
  setString(k: string, v: string): void {
    this.map.set(k, v);
  }
  deleteKey(k: string): void {
    this.map.delete(k);
  }
}

/** A wallet the farm funds from and settles to. */
class Coins implements AgentMoney {
  constructor(public balance: number) {}
  fund(_id: string, _o: string, n: number) {
    if (this.balance < n) throw new Error('Not enough Coins to allocate that agent bankroll.');
    this.balance -= n;
  }
  refund(_id: string, _o: string, n: number) {
    this.balance += n;
  }
  settle(_id: string, _o: string, n: number) {
    this.balance += n;
  }
}

function setup(opts: { coins?: number; handSeconds?: number } = {}) {
  let now = 1_800_000_000;
  const prefs = new MemPrefs();
  const money = new Coins(opts.coins ?? 20_000);
  let saved: string | null = null;
  const backend = new LocalAgentBackend({
    money, load: () => saved, save: (j) => (saved = j), handSeconds: opts.handSeconds ?? 10, tickMs: 0, now: () => now, seed: 31,
  });
  const credited: number[] = [];
  const service = new AgentDeployService({
    backend, prefs, ownerId: () => 'player-1', coins: () => money.balance, creditCoins: (n) => credited.push(n), refreshWallet: () => {},
    now: () => Math.floor(now),
  });
  const advance = (seconds: number) => {
    for (let t = 0; t < seconds; t++) {
      now += 1;
      backend.tick();
    }
  };
  return { prefs, money, backend, service, advance, credited, saved: () => saved, setNow: (n: number) => (now = n), now: () => now };
}

describe('local Agent farm, end to end (deploy → hands → limits → settlement → history → replay)', { timeout: 30_000 }, () => {
  it('plays real hands with the strategy, stops at its hand limit and pays the stack back', async () => {
    const { service, money, advance, backend } = setup();
    const strategy = new AgentStrategyState(new MemPrefs());
    const config = buildAgentConfig(strategy, { bankroll: 5000, maxHands: 6, maxMinutes: 60 }, { ownerName: 'Rex' });
    expect(await service.deploy(config)).toBeNull();
    expect(money.balance).toBe(15_000);
    expect(service.hasActiveDeployment).toBe(true);
    expect(await service.deploy(config)).toBe('An agent deployment is already running.');

    await service.refreshProgress();
    expect(service.lastProgress?.phase).toBe('seated');
    const table = backend.runner.activeTables[0]!;
    expect(table.engine.table.seats.filter((p) => p.isOccupied).length).toBeGreaterThanOrEqual(2);

    advance(25); // two hands at 10 s
    await service.refreshProgress();
    expect(service.lastProgress?.HandsPlayed).toBe(2);
    expect(service.lastProgress?.RecentHands?.length).toBe(2);

    advance(60);
    await service.pollAndSettle();
    expect(service.hasActiveDeployment).toBe(false);
    const summary = service.lastSummary!;
    expect(summary.StopReason).toBe(AgentStopReasons.MaxHands);
    expect(summary.HandsPlayed).toBe(6);
    expect(summary.ServerSettled).toBe(true);
    expect(money.balance).toBe(15_000 + summary.EndingStack);

    const history = (await service.fetchSessionHistory(10, 0))!;
    expect(history.Total).toBe(1);
    expect(history.Sessions![0]!.NetPnl).toBe(summary.EndingStack - 5000);
    const hands = (await service.fetchHandHistory(summary.DeploymentId!, 20, 0))!;
    expect(hands.Total).toBe(6);
    expect(hands.Hands!.map((h) => h.HandNumber)).toEqual([...hands.Hands!.map((h) => h.HandNumber)].sort((a, b) => b - a));
    for (const h of hands.Hands!) {
      expect(h.HasReplay).toBe(true);
      const r = AgentHandReplay.fromJson(h.ReplayJson)!;
      expect(r).not.toBeNull();
      const me = r.seat(r.agentSeat)!;
      expect(me.isAgent).toBe(true);
      expect(me.cards?.join(' ')).toBe(h.HoleCards);
      expect(me.net).toBe(h.NetPnl);
      // PRIVACY: an opponent's cards only when they were shown at showdown.
      const shown = new Set(r.steps.filter((s) => s.type === 'show').map((s) => s.seat));
      for (const s of r.seats) if (!s.isAgent) expect(s.cards != null).toBe(shown.has(s.seat));
    }
    // Stopped agents leave the table; an idle table goes away.
    expect(backend.runner.activeTables.length).toBe(0);
  });

  it('an owner stop ends it after the hand (a queued Agent ends at once with its bankroll)', async () => {
    const { service, money, advance } = setup();
    const cfg = newAgentDeploymentConfig({ Bankroll: 3000, MaxHands: 500 });
    expect(await service.deploy(cfg)).toBeNull();
    advance(12);
    expect(await service.stop()).toBeNull();
    expect(service.lastProgress?.stopRequested).toBe(true);
    advance(15);
    await service.pollAndSettle();
    expect(service.hasActiveDeployment).toBe(false);
    expect(service.lastSummary!.StopReason).toBe(AgentStopReasons.OwnerStop);
    expect(money.balance).toBe(17_000 + service.lastSummary!.EndingStack);
  });

  it('refuses a bankroll the wallet does not have, and a second Agent', async () => {
    const { service } = setup({ coins: 1000 });
    expect(await service.deploy(newAgentDeploymentConfig({ Bankroll: 5000 }))).toBe('Not enough Coins to allocate that agent bankroll.');
    expect(service.hasActiveDeployment).toBe(false);
  });

  it('survives a reload: the farm restores, the Agent is adopted with its stack and catches up the hands it missed', async () => {
    const first = setup({ handSeconds: 10 });
    expect(await first.service.deploy(newAgentDeploymentConfig({ Bankroll: 5000, MaxHands: 40, MaxRuntimeSeconds: 3600 }))).toBeNull();
    first.advance(31);
    await first.service.refreshProgress();
    const handsBefore = first.service.lastProgress!.HandsPlayed;
    const stackBefore = first.service.lastProgress!.Stack;
    expect(handsBefore).toBe(3);
    first.backend.dispose();

    // A new tab 5 minutes later, same storage.
    let store = first.saved();
    let now = first.now() + 300;
    const backend = new LocalAgentBackend({ money: first.money, load: () => store, save: (j) => (store = j), handSeconds: 10, tickMs: 0, now: () => now, seed: 5 });
    const service = new AgentDeployService({
      backend, prefs: first.prefs, ownerId: () => 'player-1', coins: () => first.money.balance, creditCoins: () => {}, refreshWallet: () => {},
      now: () => Math.floor(now),
    });
    expect(service.hasActiveDeployment).toBe(true);
    backend.tick();
    await service.refreshProgress();
    const p = service.lastProgress!;
    // It kept its totals and played on: either the missed hands (25 per tick at most) or until its stack ran out.
    expect(p.HandsPlayed).toBeGreaterThan(handsBefore + 5);
    expect(p.HandsPlayed).toBeLessThanOrEqual(40);
    if (p.phase !== 'completed') expect(p.HandsPlayed).toBe(handsBefore + 25);
    else expect(p.Stack === 0 || p.HandsPlayed === 40).toBe(true);
    expect(p.RuntimeSeconds).toBeGreaterThan(p.HandsPlayed * 10 - 15);
    // Hand numbers carry on after the adoption: every hand is its own record.
    const id = service.activeSession ?? service.lastSummary?.DeploymentId ?? first.service.activeSession!;
    expect((await service.fetchHandHistory(id, 100, 0))!.Total).toBe(p.HandsPlayed);
    expect(p.StartingBankroll).toBe(5000);
    expect(stackBefore).toBeGreaterThanOrEqual(0);
    now += 1;
  });
});

describe('AgentFarm rules (backend port)', () => {
  it('claims oldest first at the stake, fences progress to the claiming table, history newest first', () => {
    let now = 1000;
    const farm = new AgentFarm({ now: () => now, joinWaitSeconds: 0 });
    const req = (id: string, owner: string, stake = 1000) =>
      startRequestOf(newAgentDeploymentConfig({ DeploymentId: id, OwnerPlayFabId: owner, Bankroll: 5000, MinBuyIn: stake }), id);
    farm.start(req('AGNTAAAA', 'a'), 'a');
    now++;
    farm.start(req('AGNTBBBB', 'b', 500), 'b');
    expect(() => farm.start(req('AGNTCCCC', 'a'), 'a')).toThrow(/already playing/);
    expect(farm.claim('T1', 500)?.DeploymentId).toBe('AGNTBBBB');
    expect(farm.claim('T2', 1000)?.DeploymentId).toBe('AGNTAAAA');
    farm.updateProgress({ session: 'AGNTAAAA', HandsPlayed: 3, Stack: 5100 }, 'T1'); // wrong table: ignored
    expect(farm.progress('AGNTAAAA', 'a')!.HandsPlayed).toBe(0);
    expect(farm.control('AGNTAAAA', 'T2')).toMatchObject({ validClaim: true, stopRequested: false });
    expect(() => farm.progress('AGNTAAAA', 'b')).toThrow(/belong/);
    // Two minutes without a word from its table: the deployment fails with what it had.
    farm.updateProgress({ session: 'AGNTAAAA', phase: 'playing' }, 'T2');
    now += 200;
    farm.claim('T3', 1000);
    expect(farm.result('AGNTAAAA', 'a')!.StopReason).toBe('server_lost');
    expect(farm.history('a').Total).toBe(1);
  });
});

describe('replay → table events', () => {
  function oneHand() {
    const farm = new AgentFarm({ now: () => 5000, joinWaitSeconds: 0 });
    const t = new HeadlessAgentTable({ farm, name: 'T', stake: StakeCatalog.Default, seatCount: 7, seed: 11, clock: () => 0, unixClock: () => 5000 });
    farm.start(startRequestOf(newAgentDeploymentConfig({ DeploymentId: 'AGNTREPL', OwnerPlayFabId: 'o', Bankroll: 5000 }), 'AGNTREPL'), 'o');
    t.syncFarm();
    const replays: AgentHandReplay[] = [];
    for (let i = 0; i < 12; i++) {
      t.playHand();
      t.syncFarm();
    }
    for (const h of farm.hands('o', 'AGNTREPL', 100, 0).Hands!) replays.push(AgentHandReplay.fromJson(h.ReplayJson)!);
    return replays;
  }

  it('the Agent sits at view seat 0 and every recorded step becomes table events with hidden cards dealt face down', () => {
    const replays = oneHand();
    expect(replays.length).toBeGreaterThan(5);
    for (const r of replays) {
      const map = mapReplaySeats(r, 7);
      expect(map.get(r.agentSeat)).toBe(0);
      expect(new Set(map.values()).size).toBe(map.size);
      const { items } = replayToEvents(r, 7);
      expect(items[0]!.event.type).toBe('HandStarted');
      expect(items.at(-1)!.event.type).toBe('HandEnded');
      const dealt = items.filter((i) => i.event.type === 'HoleCardsDealt');
      expect(dealt.length).toBe(r.seats.length);
      const mine = dealt.find((i) => i.event.type === 'HoleCardsDealt' && i.event.seat === 0)!;
      if (mine.event.type === 'HoleCardsDealt') expect(`${mine.event.card0.short} ${mine.event.card1.short}`).toBe(r.agentCards!.join(' '));
      const acts = items.filter((i) => i.event.type === 'PlayerActed').length;
      expect(acts).toBe(r.steps.filter((s) => s.type === 'act').length);
      const awards = items.filter((i) => i.event.type === 'PotAwarded').length;
      expect(awards).toBe(r.steps.filter((s) => s.type === 'award').length);
      // Deal comes after the blinds and before the first action.
      const firstAct = items.findIndex((i) => i.event.type === 'PlayerActed');
      const lastBlind = items.map((i) => i.event.type).lastIndexOf('BlindPosted');
      const firstDeal = items.findIndex((i) => i.event.type === 'HoleCardsDealt');
      if (firstAct >= 0) expect(firstDeal).toBeLessThan(firstAct);
      expect(firstDeal).toBeGreaterThan(lastBlind);
    }
  });
});

describe('two copies of the local farm on one storage (two tabs, a hot reload)', { timeout: 30_000 }, () => {
  it('only the lease holder plays; the other sees its saves; when it goes, the other adopts the Agent', async () => {
    let now = 1_900_000_000;
    let store: string | null = null;
    let lease: string | null = null;
    const money = new Coins(20_000);
    const make = (seed: number) => new LocalAgentBackend({
      money, load: () => store, save: (j) => (store = j), handSeconds: 10, tickMs: 0, now: () => now, seed,
      lease: { get: () => lease, set: (v) => (lease = v) },
    });
    const a = make(1);
    const b = make(2);
    const prefs = new MemPrefs();
    const svcOf = (backend: LocalAgentBackend) => new AgentDeployService({
      backend, prefs, ownerId: () => 'p', coins: () => money.balance, creditCoins: () => {}, refreshWallet: () => {}, now: () => Math.floor(now),
    });
    const sa = svcOf(a);
    const sb = svcOf(b);
    a.tick(); // a holds the lease
    expect(await sa.deploy(newAgentDeploymentConfig({ Bankroll: 5000, MaxHands: 50 }))).toBeNull();
    for (let t = 0; t < 35; t++) {
      now++;
      a.tick();
      b.tick();
    }
    expect(b.runner.activeTables.length).toBe(0);
    await sb.refreshProgress();
    const seen = sb.lastProgress!.HandsPlayed;
    expect(seen).toBe(3);
    a.dispose(); // the tab closes: its lease is released
    for (let t = 0; t < 25; t++) {
      now++;
      b.tick();
    }
    await sb.refreshProgress();
    expect(b.runner.activeTables.length).toBe(1);
    const p = sb.lastProgress!;
    expect(p.HandsPlayed).toBeGreaterThan(seen);
  });
});
