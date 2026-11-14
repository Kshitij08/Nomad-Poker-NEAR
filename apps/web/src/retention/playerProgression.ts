/**
 * Account XP, levels and daily/weekly missions. Port of Game/Retention/PlayerProgression.cs (+ ProgressionCloud.cs,
 * the mission-board persistence seam). XP is the wallet's Xp balance; mission claims and level-ups grant through the
 * wallet. Also holds the LevelUpPanel's static level-up listener (Pending queue, hydration), see `LevelUpQueue`.
 */
import { RewardGrant, RewardKind } from '../app/services';
import { HandCategory } from '@nomad/engine/evaluation/handCategory';
import {
  LevelRewardCatalog, MissionCatalog, MissionKind, MissionProgressMath, PlayerLevelMath, UtcDay, deserializeBoard,
  rewardPreview, serializeBoard, type MissionBoardState,
} from '@nomad/engine/retention';
import type { RetentionEnv } from './dailyEngagement';
import type { RetentionBackend } from './backend';

/** ProgressionCloud: LoadMissionsOverride / SaveMissionsOverride. */
export interface ProgressionCloud {
  loadMissions: (() => string | null) | null;
  saveMissions: ((packed: string) => void) | null;
}

const PrefsMissions = 'Poker.Progress.Missions';
const PrefsLastLevel = 'Poker.Progress.LastLevelRewarded';

export class PlayerProgression {
  static readonly XpPerHandPlayed = 10;
  static readonly XpPerHandWon = 25;
  /** Fired as 'progression:changed' on the app bus (C# PlayerProgression.Changed). */
  static readonly CHANGED = 'progression:changed';

  readonly cloud: ProgressionCloud = { loadMissions: null, saveMissions: null };
  private board: MissionBoardState | null = null;
  private lastLevelRewarded = 1;
  private loaded = false;
  private toast = '';
  /** LevelUpPanel's listener, run synchronously on every change before the bus event (C# static subscriber). */
  levelUps: LevelUpQueue | null = null;
  /**
   * Set when a Nomad server owns retention: the board and XP are its numbers (the game server counts hands), level-up
   * rewards are its payouts, and the record* hooks below do nothing.
   */
  backend: RetentionBackend | null = null;

  constructor(private readonly env: RetentionEnv) {}

  /**
   * The level can be trusted: local rules, or a server whose progress snapshot has loaded. Before that the server
   * wallet reads 0 XP (level 1), and taking that as the baseline would celebrate every level when the snapshot lands.
   */
  get ready(): boolean {
    return !this.backend || !!this.backend.snapshot;
  }

  get totalXp(): number {
    this.ensureLoaded();
    return this.env.wallet()?.xp ?? 0;
  }
  get level(): number {
    return PlayerLevelMath.levelFromTotalXp(this.totalXp);
  }
  get levelProgress01(): number {
    return PlayerLevelMath.progress01(this.totalXp);
  }
  get xpIntoLevel(): number {
    return PlayerLevelMath.xpIntoCurrentLevel(this.totalXp);
  }
  get xpToNext(): number {
    return PlayerLevelMath.xpRemainingToNext(this.totalXp);
  }
  get lastLevelUpToast(): string {
    this.ensureLoaded();
    return this.toast;
  }
  get missionBoard(): MissionBoardState {
    if (this.backend) {
      const m = this.backend.snapshot?.missions;
      return MissionProgressMath.ensureFresh(
        m ? { dayNumber: m.dayNumber, weekNumber: m.weekNumber, slots: m.slots.map((s) => ({ ...s })), tablesToday: [] } : null,
        this.backend.snapshot?.today ?? this.today(),
      );
    }
    this.ensureLoaded();
    this.refreshDay();
    return this.board!;
  }

  notifyChanged(): void {
    this.levelUps?.onProgressionChanged();
    this.env.events.emit(PlayerProgression.CHANGED);
  }

  addXp(amount: number, source: string | null): void {
    if (amount <= 0 || this.backend) return;
    this.ensureLoaded();
    const wallet = this.env.wallet();
    if (!wallet) return;
    wallet.grant(RewardGrant.xp(amount, source ?? 'xp'));
    this.processLevelUps();
    this.persist();
    this.notifyChanged();
  }

  recordHandPlayed(): void {
    if (this.backend) return;
    this.ensureLoaded();
    this.refreshDay();
    MissionProgressMath.advance(this.board, MissionKind.PlayHands, 1, this.today());
    MissionProgressMath.advance(this.board, MissionKind.WeeklyHands, 1, this.today());
    this.addXp(PlayerProgression.XpPerHandPlayed, 'hand_played');
    if (!this.env.wallet()) this.persistAndNotify(); // no wallet: missions still move (AddXp would have saved them)
  }

  recordHandWon(): void {
    if (this.backend) return;
    this.ensureLoaded();
    this.refreshDay();
    MissionProgressMath.advance(this.board, MissionKind.WinHands, 1, this.today());
    this.addXp(PlayerProgression.XpPerHandWon, 'hand_won');
    if (!this.env.wallet()) this.persistAndNotify();
  }

  recordTableJoined(sessionName: string): void {
    if (!sessionName || this.backend) return;
    this.ensureLoaded();
    this.refreshDay();
    if (!MissionProgressMath.tryCountTable(this.board, sessionName, this.today())) return;
    this.persistAndNotify();
  }

  /** Local seat's showdown hand (C# RecordShowdown(HandValue): only the category matters). */
  recordShowdown(category: HandCategory): void {
    if (category < HandCategory.Pair || this.backend) return;
    this.ensureLoaded();
    this.refreshDay();
    let changed = MissionProgressMath.advance(this.board, MissionKind.WinPairOrBetter, 1, this.today());
    if (category >= HandCategory.TwoPair) changed = MissionProgressMath.advance(this.board, MissionKind.WinTwoPairOrBetter, 1, this.today()) || changed;
    if (!changed) return;
    this.persistAndNotify();
  }

  recordPlayedWithFriend(): void {
    if (this.backend) return;
    this.ensureLoaded();
    this.refreshDay();
    if (!MissionProgressMath.advance(this.board, MissionKind.PlayWithFriend, 1, this.today())) return;
    this.persistAndNotify();
  }

  /** The mission claim, wherever it is decided: the server with a backend, else tryClaimMission. */
  async claimMission(id: string): Promise<{ ok: boolean; message: string }> {
    if (!this.backend) return this.tryClaimMission(id);
    const r = await this.backend.claimMission(id);
    this.notifyChanged();
    return r ? { ok: r.ok, message: r.message } : { ok: false, message: "Couldn't reach the server. Try again." };
  }

  /** C# TryClaimMission(id, out message). */
  tryClaimMission(id: string): { ok: boolean; message: string } {
    this.ensureLoaded();
    this.refreshDay();
    const wallet = this.env.wallet();
    if (!wallet) return { ok: false, message: 'Not ready to claim.' };
    const rewards = MissionProgressMath.tryClaim(this.board, id, this.today());
    if (!rewards) return { ok: false, message: 'Not ready to claim.' };
    for (const r of rewards) wallet.grant(r);
    this.processLevelUps();
    this.persist();
    this.notifyChanged();
    const def = MissionCatalog.tryGet(id);
    const preview = def ? rewardPreview(def) : '';
    return { ok: true, message: preview ? `Claimed! ${preview}` : 'Mission claimed!' };
  }

  /** After a cloud pull: reload the board and never backfill level rewards for XP that already exists. */
  reloadFromCloud(): void {
    this.levelUps?.beginHydration();
    try {
      this.loaded = false;
      this.ensureLoaded();
      const levelNow = PlayerLevelMath.levelFromTotalXp(this.env.wallet()?.xp ?? 0);
      if (levelNow > this.lastLevelRewarded) {
        this.lastLevelRewarded = levelNow;
        this.env.prefs.setInt(PrefsLastLevel, this.lastLevelRewarded);
      }
      this.notifyChanged();
    } finally {
      this.levelUps?.endHydration();
    }
  }

  private persistAndNotify(): void {
    this.persist();
    this.notifyChanged();
  }

  private processLevelUps(): void {
    const wallet = this.env.wallet();
    if (!wallet) return;
    const current = PlayerLevelMath.levelFromTotalXp(wallet.xp);
    if (current <= this.lastLevelRewarded) return;
    let toast = '';
    for (let level = this.lastLevelRewarded + 1; level <= current; level++) {
      const rewards = LevelRewardCatalog.rewardsForLevel(level);
      for (const r of rewards) wallet.grant(r);
      if (toast) toast += ' · ';
      toast += 'Lv ' + level;
      if (rewards.length > 0 && rewards[0]!.kind === RewardKind.Coins) toast += ' +' + rewards[0]!.amount + ' coins';
    }
    this.lastLevelRewarded = current;
    this.toast = toast;
    this.env.prefs.setInt(PrefsLastLevel, this.lastLevelRewarded);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.lastLevelRewarded = this.env.prefs.getInt(PrefsLastLevel, 0);
    this.board = deserializeBoard(this.loadMissions());
    this.refreshDay();
    const levelNow = PlayerLevelMath.levelFromTotalXp(this.env.wallet()?.xp ?? 0);
    if (this.lastLevelRewarded <= 0) {
      // First run / migrated account: do not backfill historical level rewards.
      this.lastLevelRewarded = levelNow;
      this.env.prefs.setInt(PrefsLastLevel, this.lastLevelRewarded);
    }
  }

  private refreshDay(): void {
    this.board = MissionProgressMath.ensureFresh(this.board, this.today());
  }

  /** C# uses DateTime.UtcNow here; the port shares DailyEngagement's injectable clock. */
  private today(): number {
    return UtcDay.fromUtc(this.env.clock());
  }

  private persist(): void {
    const packed = serializeBoard(this.board);
    if (this.cloud.saveMissions) this.cloud.saveMissions(packed);
    else this.env.prefs.setString(PrefsMissions, packed);
    this.env.prefs.setInt(PrefsLastLevel, this.lastLevelRewarded);
  }

  private loadMissions(): string {
    if (this.cloud.loadMissions) return this.cloud.loadMissions() ?? '';
    return this.env.prefs.getString(PrefsMissions, '');
  }

  /** EditorResetForTests. */
  resetForTests(): void {
    this.loaded = false;
    this.board = null;
    this.lastLevelRewarded = 1;
    this.toast = '';
  }
}

/**
 * LevelUpPanel's static half: baselines the level at install, queues every level gained (Pending), and suppresses
 * celebrations while a cloud reload hydrates the account. `show(level)` is called when the panel should open.
 */
export class LevelUpQueue {
  readonly pending: number[] = [];
  private lastSeenLevel = -1;
  /**
   * The highest level already reached (celebrated or baselined). A reading can dip for a moment (the wallet is swapped
   * or reloads when leaving a table, briefly reading 0 XP) and come back; climbing back to a level already reached is
   * not a level up, so it is never queued twice.
   */
  private highWater = -1;
  private hydrationDepth = 0;
  /** The panel is open (C# IsShowing). Set by the level-up screen. */
  showing = false;
  /** C# autoShowOnLevelUp. */
  autoShow = true;

  constructor(private readonly progression: PlayerProgression, private readonly show: (level: number) => void) {
    // Baseline only: do not celebrate whatever level was already on disk.
    this.baseline();
  }

  /** The current level is the starting point (nothing to celebrate); or none yet while the level isn't loaded. */
  private baseline(): void {
    this.pending.length = 0;
    if (!this.progression.ready) {
      this.lastSeenLevel = -1;
      return;
    }
    this.lastSeenLevel = this.highWater = this.progression.level;
  }

  beginHydration(): void {
    this.hydrationDepth++;
  }

  endHydration(): void {
    if (this.hydrationDepth > 0) this.hydrationDepth--;
    this.baseline();
  }

  /** Re-baseline (the wallet balance arrived after install). */
  rebaseline(): void {
    this.baseline();
  }

  onProgressionChanged(): void {
    if (!this.progression.ready) return; // not loaded yet: no reading to compare
    const now = this.progression.level;
    if (this.hydrationDepth > 0) {
      this.pending.length = 0;
      this.lastSeenLevel = this.highWater = now;
      return;
    }
    if (this.lastSeenLevel < 0) {
      // First real reading (the server snapshot just arrived): the baseline, not a level up.
      this.lastSeenLevel = now;
      this.highWater = Math.max(this.highWater, now);
      return;
    }
    if (this.lastSeenLevel >= 0 && now > this.highWater) {
      for (let lv = Math.max(this.lastSeenLevel, this.highWater) + 1; lv <= now; lv++) if (!this.pending.includes(lv)) this.pending.push(lv);
      this.highWater = now;
    }
    this.lastSeenLevel = now;
    if (this.autoShow && !this.showing && this.pending.length > 0) this.show(this.pending.shift()!);
  }

  /** Continue: the next queued level, or null to close. */
  next(): number | null {
    return this.pending.length > 0 ? this.pending.shift()! : null;
  }
}
