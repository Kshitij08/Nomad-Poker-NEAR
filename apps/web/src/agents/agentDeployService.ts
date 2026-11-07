/**
 * Port of Assets/Scripts/Net/Agents/AgentDeployService.cs (+ AgentDeploymentStore.cs and AgentReturnWatcher.cs): the
 * client side of a Coins AFK Agent. Deploy queues it (the backend takes the bankroll), the service polls its progress
 * while it plays, asks it to stop, and settles when the authoritative result arrives. Same PlayerPrefs keys and record
 * shapes as the C# ("Poker.Agent.ActiveDeployment", "Poker.Agent.LastSummary").
 *
 * The C# is a static class over UnityWebRequest; here it is an instance over an AgentBackend (local by default).
 */
import {
  buildSessionCode, clampAgentConfig,
  type AgentDeploymentConfig, type AgentDeploymentProgress, type AgentDeploymentSummary, type AgentHandHistory,
  type AgentSessionHistory, newAgentProgress,
} from '../core/agents';
import type { AgentBackend } from './agentBackend';
import { startRequestOf } from './server/agentFarm';

const ACTIVE_PREFS = 'Poker.Agent.ActiveDeployment';
export const LAST_SUMMARY_PREFS = 'Poker.Agent.LastSummary';
/** Re-POST stop this often while waiting (survives backend restarts that wipe the stop flag). */
const STOP_REARM_SECONDS = 12;
/** Last-resort unlock window after the backend's stale-server recovery has had its chance. */
const STOP_ABANDON_SECONDS = 240;
/** AgentReturnWatcher.pollSeconds. */
export const RETURN_POLL_SECONDS = 5;

interface ActiveRecord {
  session: string | null;
  deploymentId: string | null;
  bankroll: number;
  settled: boolean;
  stopRequestedAtUnix: number;
  lastStopRearmUnix: number;
  ownerId: string | null;
  /** A copied marketplace strategy: settle only with its profit share known. */
  strategyId: string | null;
}

export interface Prefs {
  getString(key: string, fallback?: string): string;
  setString(key: string, value: string): void;
  deleteKey(key: string): void;
}

/** AgentDeploymentStore's cloud override (PlayFabAgentProgress mirrors the last summary to PlayFab UserData). */
export interface AgentSummaryCloud {
  loadAgentSummary(): AgentDeploymentSummary | null;
  saveAgentSummary(summary: AgentDeploymentSummary): void;
}

export interface AgentDeployDeps {
  backend: AgentBackend;
  prefs: Prefs;
  /** PokerClientIdentity.PlayFabId (the account's player id); null/empty when signed out. */
  ownerId(): string | null;
  /** VirtualEconomy.Wallet.Coins. */
  coins(): number;
  /** VirtualEconomy.CreditFreePlay: a pre-ledger deployment's stack comes back on this device. */
  creditCoins(amount: number): void;
  /** PlayFabWallet.RefreshAsync: the server moved Coins; read the balance again. */
  refreshWallet(): void;
  summaryCloud?: () => AgentSummaryCloud | null;
  /** Unix seconds. */
  now?: () => number;
  onChanged?: () => void;
}

/** Persists the last summary for the return screen: the cloud override after sign-in, else PlayerPrefs. */
export class AgentDeploymentStore {
  constructor(private readonly prefs: Prefs, private readonly cloud: () => AgentSummaryCloud | null = () => null) {}

  saveSummary(summary: AgentDeploymentSummary | null): void {
    if (!summary) return;
    const c = this.cloud();
    if (c) {
      c.saveAgentSummary(summary);
      return;
    }
    this.prefs.setString(LAST_SUMMARY_PREFS, JSON.stringify(summary));
  }

  loadSummary(): AgentDeploymentSummary | null {
    const c = this.cloud();
    if (c) return c.loadAgentSummary();
    const json = this.prefs.getString(LAST_SUMMARY_PREFS, '');
    if (!json) return null;
    try {
      return JSON.parse(json) as AgentDeploymentSummary;
    } catch {
      return null;
    }
  }
}

const firstNonEmpty = (...values: (string | null | undefined)[]): string | null => {
  for (const v of values) if (v && v.trim()) return v.trim();
  return null;
};
const eqi = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

export class AgentDeployService {
  readonly store: AgentDeploymentStore;
  private progressSnapshot: AgentDeploymentProgress | null = null;
  private nextRecoverMs = 0;
  private readonly listeners = new Set<() => void>();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: AgentDeployDeps) {
    this.store = new AgentDeploymentStore(deps.prefs, deps.summaryCloud);
  }

  get backend(): AgentBackend {
    return this.deps.backend;
  }

  /** AgentDeployService.Changed (and AgentDeployGateway.Changed). */
  onChanged(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
    this.deps.onChanged?.();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }

  private owner(): string {
    return firstNonEmpty(this.deps.ownerId(), 'local')!;
  }

  // ---- state

  get hasActiveDeployment(): boolean {
    const a = this.loadActive();
    return a != null && !a.settled && !!a.session;
  }

  get lastSummary(): AgentDeploymentSummary | null {
    return this.store.loadSummary();
  }

  get lastProgress(): AgentDeploymentProgress | null {
    return this.progressSnapshot;
  }

  /** Unix seconds when the owner last successfully requested stop; 0 if never. */
  get stopRequestedAtUnix(): number {
    const a = this.loadActive();
    return a && !a.settled ? a.stopRequestedAtUnix : 0;
  }

  /** The running deployment's session code (also its id), or null. */
  get activeSession(): string | null {
    const a = this.loadActive();
    return a && !a.settled ? a.session : null;
  }

  // ---- deploy / stop

  /** Queues an Agent for a matching public table. Null on success, else a player-facing error. */
  async deploy(config: AgentDeploymentConfig): Promise<string | null> {
    config = clampAgentConfig(config);
    if (this.hasActiveDeployment) return 'An agent deployment is already running.';
    if (!config.OwnerPlayFabId) config.OwnerPlayFabId = this.owner();
    // The backend takes the bankroll from your Coins when it queues the Agent. This check only saves a round trip.
    if (this.deps.coins() < config.Bankroll) return 'Not enough Coins to allocate that agent bankroll.';
    if (!(await this.deps.backend.signInToken())) return 'Sign in to deploy your Agent.';

    const session = buildSessionCode(config.DeploymentId);
    config.DeploymentId = session;
    this.saveActive({
      session, deploymentId: session, bankroll: config.Bankroll, settled: false, stopRequestedAtUnix: 0, lastStopRearmUnix: 0,
      ownerId: config.OwnerPlayFabId, strategyId: config.StrategyId,
    });
    this.changed();

    const started = await this.deps.backend.start(startRequestOf(config, session));
    if (started.error && !started.status) {
      this.refundAndClear();
      // "Already playing": this device lost its note of the running Agent; show that one.
      this.nextRecoverMs = 0;
      await this.recoverActive();
      return started.error;
    }
    if ((started.status ?? '').toLowerCase() === 'failed') {
      this.refundAndClear();
      return started.error || 'The backend could not queue the agent.';
    }
    this.deps.refreshWallet(); // the bankroll left your Coins on the server
    this.changed();
    return null;
  }

  /** Asks the table to stop after the current hand and return the remaining stack. */
  async stop(): Promise<string | null> {
    const active = this.loadActive();
    if (!active || active.settled) return 'No agent is farming.';
    const error = await this.postStop(active.session!);
    if (error != null) return error;
    const now = this.now();
    if (active.stopRequestedAtUnix <= 0) active.stopRequestedAtUnix = now;
    active.lastStopRearmUnix = now;
    this.saveActive(active);
    this.progressSnapshot ??= newAgentProgress();
    this.progressSnapshot.stopRequested = true;
    this.progressSnapshot.running = true;
    this.changed();
    return null;
  }

  /** Re-sends stop without refunding locally; only an authoritative result can release Coins. */
  async abandon(): Promise<string> {
    const active = this.loadActive();
    if (!active || active.settled) return 'No agent deployment to clear.';
    const error = await this.postStop(active.session!);
    return error ?? 'Stop re-sent. Coins stay locked until the table returns an authoritative result.';
  }

  private async postStop(session: string): Promise<string | null> {
    const r = await this.deps.backend.stop(session, this.owner());
    if (r.error) return r.error;
    if (r.progress) {
      this.progressSnapshot = r.progress;
      this.progressSnapshot.stopRequested = true;
    }
    return null;
  }

  // ---- polling and settlement

  /** Latest hands / stack from the farming table. Clears the snapshot when nothing is deployed. */
  async refreshProgress(): Promise<void> {
    let active = this.loadActive();
    if ((!active || active.settled) && (await this.recoverActive())) active = this.loadActive();
    if (!active || active.settled) {
      if (this.progressSnapshot) {
        this.progressSnapshot = null;
        this.changed();
      }
      return;
    }
    const progress = await this.deps.backend.progress(active.session!, this.owner());
    if (!progress) return;
    this.progressSnapshot = progress;
    this.changed();
  }

  /** Polls progress and the result; settles when finished (AgentReturnWatcher calls this every 5 s while active). */
  async pollAndSettle(): Promise<void> {
    await this.refreshProgress();
    this.trySettleFromStore();
    const active = this.loadActive();
    if (!active || active.settled) return;

    if (active.stopRequestedAtUnix > 0) {
      const now = this.now();
      if (now - active.stopRequestedAtUnix >= STOP_ABANDON_SECONDS) {
        console.warn('[AgentDeploy] Stop is taking longer than expected; keeping the deployment locked until the backend returns an authoritative result.');
        active.stopRequestedAtUnix = now;
        active.lastStopRearmUnix = 0;
        this.saveActive(active);
      }
      if (now - Math.max(active.lastStopRearmUnix, active.stopRequestedAtUnix) >= STOP_REARM_SECONDS) {
        active.lastStopRearmUnix = now;
        this.saveActive(active);
        const rearmError = await this.postStop(active.session!);
        if (rearmError) console.warn(`[AgentDeploy] Stop re-arm failed: ${rearmError}`);
      }
    } else if (this.progressSnapshot?.stopRequested) {
      active.stopRequestedAtUnix = this.now();
      active.lastStopRearmUnix = 0;
      this.saveActive(active);
    }

    const summary = await this.deps.backend.result(active.session!, this.owner());
    if (summary) this.applySettlement(summary);
  }

  /** Applies a finished summary: credits the remaining stack (unless the server did), marks the deployment settled. */
  applySettlement(summary: AgentDeploymentSummary | null): void {
    if (!summary) return;
    this.store.saveSummary(summary);
    const active = this.loadActive();
    if (!active || active.settled) return;
    const match = !summary.DeploymentId || eqi(active.deploymentId, summary.DeploymentId) || eqi(active.session, summary.SessionName);
    if (!match) return;
    // A copied strategy settles only once the backend reports its profit share.
    if (active.strategyId && !summary.CopyFee?.strategyId) return;

    const fee = summary.CopyFee ? Math.max(0, summary.CopyFee.creatorFee) + Math.max(0, summary.CopyFee.platformFee) : 0;
    const credit = summary.EndingStack > 0 ? Math.max(0, summary.EndingStack - fee) : 0;
    // The backend paid the stack back into your Coins: read the balance again. Only a pre-ledger deployment is settled here.
    if (summary.ServerSettled) this.deps.refreshWallet();
    else if (credit > 0) this.deps.creditCoins(credit);

    active.settled = true;
    this.saveActive(active);
    this.changed();
  }

  trySettleFromStore(): void {
    const active = this.loadActive();
    if (!active || active.settled) return;
    const summary = this.store.loadSummary();
    if (!summary) return;
    if (summary.DeploymentId && !eqi(summary.DeploymentId, active.deploymentId) && !eqi(summary.SessionName, active.session)) return;
    this.applySettlement(summary);
  }

  /**
   * This device has no note of a running Agent (storage cleared, another device): the backend, which holds the bankroll,
   * says whether one is queued or playing, and it is picked up here. Asks at most every 30 s.
   */
  private async recoverActive(): Promise<boolean> {
    if (this.hasActiveDeployment || Date.now() < this.nextRecoverMs) return false;
    this.nextRecoverMs = Date.now() + 30_000;
    const owner = this.deps.ownerId();
    if (!owner) return false;
    const found = await this.deps.backend.active(owner);
    if (!found?.deploymentId || this.hasActiveDeployment) return false;
    this.saveActive({
      session: found.deploymentId, deploymentId: found.deploymentId, bankroll: found.bankroll, settled: false,
      stopRequestedAtUnix: 0, lastStopRearmUnix: 0, ownerId: owner, strategyId: null,
    });
    this.changed();
    return true;
  }

  // ---- history

  fetchSessionHistory(limit = 20, offset = 0): Promise<AgentSessionHistory | null> {
    return this.deps.backend.history(this.owner(), Math.max(1, Math.min(limit, 100)), Math.max(0, offset));
  }

  fetchHandHistory(deploymentId: string, limit = 100, offset = 0): Promise<AgentHandHistory | null> {
    if (!deploymentId?.trim()) return Promise.resolve(null);
    return this.deps.backend.hands(this.owner(), deploymentId, Math.max(1, Math.min(limit, 100)), Math.max(0, offset));
  }

  // ---- AgentReturnWatcher

  /** Polls every 5 s while a deployment is active (Unity starts this at boot, outside batch mode). */
  startWatcher(seconds = RETURN_POLL_SECONDS): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      if (!this.hasActiveDeployment || this.polling) return;
      this.polling = true;
      void this.pollAndSettle().finally(() => (this.polling = false));
    }, Math.max(2, seconds) * 1000);
  }

  stopWatcher(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  // ---- records

  /** The start failed: nothing was taken (the backend refunds any bankroll it took), so just forget it. */
  private refundAndClear(): void {
    this.deps.prefs.deleteKey(ACTIVE_PREFS);
    this.deps.refreshWallet();
    this.changed();
  }

  private loadActive(): ActiveRecord | null {
    const json = this.deps.prefs.getString(ACTIVE_PREFS, '');
    if (!json) return null;
    try {
      const r = JSON.parse(json) as Partial<ActiveRecord>;
      return {
        session: r.session ?? null, deploymentId: r.deploymentId ?? null, bankroll: r.bankroll ?? 0, settled: !!r.settled,
        stopRequestedAtUnix: r.stopRequestedAtUnix ?? 0, lastStopRearmUnix: r.lastStopRearmUnix ?? 0, ownerId: r.ownerId ?? null,
        strategyId: r.strategyId || null,
      };
    } catch {
      return null;
    }
  }

  private saveActive(record: ActiveRecord): void {
    this.deps.prefs.setString(ACTIVE_PREFS, JSON.stringify({ ...record, strategyId: record.strategyId ?? '' }));
  }

  /** AgentLocalEditorBackend.ClearLocalAgentState. */
  clearLocalState(): void {
    this.deps.prefs.deleteKey(ACTIVE_PREFS);
    this.deps.prefs.deleteKey(LAST_SUMMARY_PREFS);
    this.changed();
  }
}
