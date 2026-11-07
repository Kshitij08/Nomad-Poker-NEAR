/**
 * The retention service (ctx.services.retention): Daily Spin, the 7-day login track, XP/levels, missions, the
 * level-up queue, stake selection, and the table progress hooks. What the Unity HUD panels and the Nomad screens
 * (LevelRewards, LuckySlot_Win/Lost, WeeklyRewards) call.
 *
 *   const r = ctx.services.retention;
 *   r.engagement.canSpin(); r.engagement.trySpin();               // DailyEngagement
 *   r.engagement.previewLogin(); r.engagement.tryClaimLogin();     // login track
 *   r.progression.level; r.progression.missionBoard;               // PlayerProgression
 *   r.progression.tryClaimMission(id);
 *   r.missionRows('daily');                                        // what the mission rows paint
 *   r.trackTable({ localSeat: 0, roomCode: 'poker-free-st100' })   // feed table events → XP / missions
 *
 * Events on ctx.events: 'engagement:changed', 'progression:changed', 'stake:changed' (C# Changed events).
 */
import type { EventBus } from '../app/app';
import { PlayerPrefs, RewardKind, type RewardGrant, type VirtualWallet } from '../app/services';
import {
  DailySpinCatalog, LevelRewardCatalog, MissionCatalog, MissionProgressMath, rewardPreview, systemClock, type Clock,
  type MissionDef,
} from '../core/retention';
import { formatN0 } from '../core/util/dotnetMath';
import { DailyEngagement, defaultRoll, type PrefsLike, type RetentionEnv } from './dailyEngagement';
import { LevelUpQueue, PlayerProgression } from './playerProgression';
import { StakeSelection } from './stakeSelection';
import { TableProgressTracker, type TableProgressOptions } from './tableProgress';

export interface RetentionServiceOptions {
  events: EventBus;
  wallet: () => VirtualWallet | undefined;
  prefs?: PrefsLike;
  clock?: Clock;
  roll?: () => number;
  /** Opens the level-up celebration (install wires it to router.push('level-up')). */
  showLevelUp?: (level: number) => void;
}

/** One mission row as the Nomad LevelRewards screen / MissionRowView paint it. */
export interface MissionRowModel {
  readonly def: MissionDef;
  readonly progress: number;
  readonly target: number;
  readonly done: boolean;
  readonly claimed: boolean;
  readonly canClaim: boolean;
  /** MissionDef.RewardPreview: "+500 Coins, +50 XP". */
  readonly reward: string;
  /** NomadUiHost.PaintMissions: "Claimed" / "Tap to claim" / "In progress". */
  readonly state: string;
}

export class RetentionService {
  readonly env: RetentionEnv;
  readonly engagement: DailyEngagement;
  readonly progression: PlayerProgression;
  readonly stakes: StakeSelection;
  readonly levelUps: LevelUpQueue;
  /** RetentionMenuHud.OpenLoginRewards / OpenMissions / OpenDailySpin (install wires them to the router / Nomad menu). */
  openWeeklyRewards: () => void = () => {};
  openMissions: () => void = () => {};
  openDailySpin: () => void = () => {};

  constructor(opts: RetentionServiceOptions) {
    this.env = {
      events: opts.events,
      prefs: opts.prefs ?? PlayerPrefs,
      wallet: opts.wallet,
      clock: opts.clock ?? systemClock,
      roll: opts.roll ?? defaultRoll,
    };
    this.engagement = new DailyEngagement(this.env);
    this.progression = new PlayerProgression(this.env);
    this.stakes = new StakeSelection(this.env);
    this.levelUps = new LevelUpQueue(this.progression, (lv) => opts.showLevelUp?.(lv));
    this.progression.levelUps = this.levelUps;
  }

  get wallet(): VirtualWallet | undefined {
    return this.env.wallet();
  }

  /** Swap the clock (tests / debug): every "today" reads it. */
  setClock(clock: Clock): void {
    this.env.clock = clock;
  }

  /** Mission rows for a section, in catalog order. */
  missionRows(section: 'daily' | 'weekly' | 'all' = 'all'): MissionRowModel[] {
    const defs = section === 'daily' ? MissionCatalog.Daily : section === 'weekly' ? MissionCatalog.Weekly : MissionCatalog.All;
    const board = this.progression.missionBoard;
    return defs.map((def) => {
      const slot = MissionProgressMath.find(board, def.id);
      const progress = Math.min(slot?.progress ?? 0, def.target);
      const done = progress >= def.target;
      const claimed = !!slot?.claimed;
      return { def, progress, target: def.target, done, claimed, canClaim: done && !claimed, reward: rewardPreview(def), state: claimed ? 'Claimed' : done ? 'Tap to claim' : 'In progress' };
    });
  }

  /** NomadUiHost.PaintLevelRewards: the Panel_Level texts and the five-level track around the current level. */
  levelRewardsModel(): {
    level: number; xpText: string; progress01: number; toNextText: string; nextLevelText: string; nextRewardText: string; hint: string;
    track: { level: number; label: string; reward: string; reached: boolean }[];
  } {
    const p = this.progression;
    const lv = p.level;
    const into = p.xpIntoLevel;
    const left = p.xpToNext;
    const first = Math.max(1, lv - 1);
    return {
      level: lv,
      xpText: `${formatN0(into)} / ${formatN0(into + left)} XP`,
      progress01: p.levelProgress01,
      toNextText: `${formatN0(left)} XP to Level ${lv + 1}`,
      nextLevelText: `Level ${lv + 1}`,
      nextRewardText: '+' + nomadGrants(LevelRewardCatalog.rewardsForLevel(lv + 1)),
      hint: 'Play hands and finish missions to earn XP.',
      track: [0, 1, 2, 3, 4].map((i) => {
        const n = first + i;
        return { level: n, label: `Lv ${n}`, reward: nomadGrants(LevelRewardCatalog.rewardsForLevel(n)), reached: n <= lv };
      }),
    };
  }

  /** NomadUiHost.PaintSlot's note: "One free spin a day · every spin pays 250 to 25,000 Coins". */
  spinNote(): string {
    const coins = DailySpinCatalog.Prizes.map((p) => p.coins);
    return `One free spin a day · every spin pays ${formatN0(Math.min(...coins))} to ${formatN0(Math.max(...coins))} Coins`;
  }

  /** Starts feeding a table's events into XP / missions (PokerClientGame's progression hooks). */
  trackTable(opts: TableProgressOptions): TableProgressTracker {
    return new TableProgressTracker(this.progression, { ...opts });
  }
}

/** NomadUiHost.Grants: "1,000 Coins + 2 Gems + frame_lv10". */
export function nomadGrants(grants: readonly RewardGrant[]): string {
  return grants
    .map((g) =>
      g.kind === RewardKind.Coins ? `${formatN0(g.amount)} Coins` : g.kind === RewardKind.Gems ? `${formatN0(g.amount)} Gems` : g.kind === RewardKind.Xp ? `${formatN0(g.amount)} XP` : g.itemId,
    )
    .join(' + ');
}
