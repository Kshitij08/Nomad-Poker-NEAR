/**
 * Installs the retention module: ctx.services.retention (Daily Spin, login track, XP/levels, missions, level-up
 * queue, stake selection, table progress hooks) and its screens.
 *
 * Router ids (all overlays): 'level-up', 'weekly-reward' (alias 'login-rewards'), 'daily-spin', 'missions',
 * 'stake-select', 'lucky-slot' (the Nomad LuckySlot_Win/Lost screens with NomadSlotSpin + NomadSparkles).
 * Component: mountRetentionHud(ctx, el) (see ./retentionHud).
 *
 * Wallet: ctx.services.wallet is read on every use (the economy module may install it later); without one, spins and
 * claims fail softly and XP reads 0. Cloud: if ctx.services.progress exposes loadEngagement/saveEngagement and/or
 * loadMissions/saveMissions, they are wired as EngagementCloud / ProgressionCloud; else PlayerPrefs (C# keys).
 */
import type { AppContext } from '../app/app';
import type { DailyEngagementState } from '@nomad/engine/retention';
import { RetentionService } from './retentionService';
import { LevelUpScreen } from './screens/levelUpScreen';
import { WeeklyRewardsScreen } from './screens/weeklyRewardsScreen';
import { DailySpinScreen } from './screens/dailySpinScreen';
import { MissionsScreen } from './screens/missionsScreen';
import { StakeSelectScreen } from './screens/stakeSelectScreen';
import { LuckySlotScreen } from './screens/luckySlotScreen';
import type { TableProgressTracker } from './tableProgress';
import type { PokerEvent } from '@nomad/engine/events/pokerEvent';
import { registerNomadPartial } from '../menu/host';
import { bindNomadRetention } from './nomadPartial';

declare module '../app/app' {
  interface Services {
    retention?: RetentionService;
  }
}

/** Optional cloud seam (economy module). Every member is optional; present ones replace PlayerPrefs. */
interface ProgressCloudLike {
  loadEngagement?: () => DailyEngagementState | null;
  saveEngagement?: (s: DailyEngagementState) => void;
  loadMissions?: () => string | null;
  saveMissions?: (packed: string) => void;
}

/** Payloads the table session emits on ctx.events (see the report for the tableScreen diff). */
export interface TableJoinedPayload {
  localSeat: number;
  moneyTable?: boolean;
  roomCode?: string;
  playerName?: string;
}
export interface TableEventPayload {
  event: PokerEvent;
}

export function install(ctx: AppContext): void {
  const svc = new RetentionService({
    events: ctx.events,
    wallet: () => ctx.services.wallet,
    showLevelUp: (level) => {
      if (ctx.router.has('level-up')) void ctx.router.push('level-up', { level });
    },
  });
  ctx.services.retention = svc;
  wireCloud(ctx, svc);

  // A Nomad server owns retention (account module): its snapshot is the state, its answers are the rewards, and the
  // game server counts hands, so the local table hooks below record nothing.
  const serverProgress = ctx.services.nomadProgress;
  if (serverProgress) {
    svc.setBackend(serverProgress);
    ctx.events.on('nomad:progress', () => {
      svc.progression.notifyChanged();
      svc.engagement.notifyChanged();
    });
  }

  // A cloud pull / sign-out (economy module) reloads the board under LevelUpPanel's hydration guard, so the level
  // jump to the account's XP is never celebrated or rewarded twice.
  ctx.events.on('progress:loaded', () => svc.progression.reloadFromCloud());
  // PlayFabEconomyBridge attach (sign-in): C# runs DailyEngagement.EnsureTodaysSpinCredit once here.
  ctx.events.on('economy:attached', () => svc.engagement.ensureTodaysSpinCredit());

  // RetentionMenuHud entry points (the Nomad menu calls these through ctx.services.retention).
  const push = (id: string) => {
    if (ctx.router.has(id)) void ctx.router.push(id);
  };
  svc.openWeeklyRewards = () => push('weekly-reward');
  svc.openMissions = () => push('missions');
  svc.openDailySpin = () => (ctx.services.nomad ? ctx.services.nomad.actions.openDailySpin?.() ?? push('lucky-slot') : push('lucky-slot'));
  registerNomadPartial((host, c) => bindNomadRetention(host, c));

  // Table progress hooks: the table session emits these (PokerClientGame's progression hooks).
  let tracker: TableProgressTracker | null = null;
  ctx.events.on<TableJoinedPayload>('table:joined', (p) => {
    tracker = svc.trackTable({ localSeat: p.localSeat, moneyTable: p.moneyTable, roomCode: p.roomCode, playerName: p.playerName ?? ctx.services.account.displayName });
  });
  ctx.events.on<TableEventPayload>('table:event', (p) => tracker?.onEvent(p.event));
  ctx.events.on<number>('table:seat', (seat) => tracker?.setLocalSeat(seat));
  ctx.events.on('table:left', () => (tracker = null));

  ctx.router.register('level-up', (c) => new LevelUpScreen(c));
  ctx.router.register('weekly-reward', (c) => new WeeklyRewardsScreen(c));
  ctx.router.register('login-rewards', (c) => new WeeklyRewardsScreen(c));
  ctx.router.register('daily-spin', (c) => new DailySpinScreen(c));
  ctx.router.register('missions', (c) => new MissionsScreen(c));
  ctx.router.register('stake-select', (c) => new StakeSelectScreen(c));
  ctx.router.register('lucky-slot', (c) => new LuckySlotScreen(c));

  (window as unknown as Record<string, unknown>).__retention = svc;
}

function wireCloud(ctx: AppContext, svc: RetentionService): void {
  const cloud = (ctx.services as unknown as { progress?: ProgressCloudLike }).progress;
  if (!cloud) return;
  if (cloud.loadEngagement && cloud.saveEngagement) {
    const load = cloud.loadEngagement.bind(cloud);
    svc.engagement.cloud.load = () => load() ?? { lastSpinDay: 0, lastLoginDay: 0, streakDay: 0, lastSpinCoins: 0 };
    svc.engagement.cloud.save = cloud.saveEngagement.bind(cloud);
  }
  if (cloud.loadMissions && cloud.saveMissions) {
    svc.progression.cloud.loadMissions = cloud.loadMissions.bind(cloud);
    svc.progression.cloud.saveMissions = cloud.saveMissions.bind(cloud);
  }
}

export { mountRetentionHud } from './retentionHud';
