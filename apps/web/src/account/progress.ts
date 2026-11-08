import { RewardKind, type RewardGrant, type VirtualWallet } from '../app/services';
import {
  ProgressRoutes,
  type LoginClaimResponse,
  type MissionClaimResponse,
  type ProgressSnapshot,
  type SpinResponse,
} from '@nomad/contract';
import type { RetentionBackend } from '../retention/backend';
import type { NomadEvents, NomadSession } from './session';

/**
 * The player's progress on the Nomad server: balances, items, spin, login track, missions, level. The retention
 * screens read `snapshot`; their claims call the server, which answers with the new snapshot. Emits 'nomad:progress'.
 */
export class NomadProgress implements RetentionBackend {
  snapshot: ProgressSnapshot | null = null;
  error: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly session: NomadSession,
    private readonly events: NomadEvents,
  ) {}

  refresh(): Promise<void> {
    if (!this.session.signedIn) return Promise.resolve();
    this.refreshing ??= this.session
      .call<ProgressSnapshot>('GET', ProgressRoutes.progress)
      .then((s) => this.adopt(s))
      .catch((e) => {
        this.error = (e as Error).message;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  spin(): Promise<SpinResponse | null> {
    return this.act<SpinResponse>(ProgressRoutes.spin);
  }

  claimLogin(): Promise<LoginClaimResponse | null> {
    return this.act<LoginClaimResponse>(ProgressRoutes.login);
  }

  claimMission(id: string): Promise<MissionClaimResponse | null> {
    return this.act<MissionClaimResponse>(ProgressRoutes.missionClaim, { id });
  }

  private async act<T extends { progress: ProgressSnapshot }>(path: string, body: unknown = {}): Promise<T | null> {
    try {
      const r = await this.session.call<T>('POST', path, body);
      this.adopt(r.progress);
      return r;
    } catch (e) {
      this.error = (e as Error).message;
      console.warn(`[nomad] ${path} failed:`, e);
      return null;
    }
  }

  private adopt(s: ProgressSnapshot): void {
    this.snapshot = s;
    this.error = null;
    this.events.emit('nomad:progress');
    this.events.emit('wallet:changed');
  }
}

/**
 * The wallet when a Nomad server owns the balances: it shows them and refuses to change them. Coins, gems, XP and
 * items move only on the server (rewards, table buy-ins and cash-outs); a client-side grant is ignored and logged.
 */
export class NomadWallet implements VirtualWallet {
  /** VirtualEconomy reads this to route free-play debits and credits to a refresh instead. */
  readonly serverAuthoritative = true;

  constructor(
    private readonly progress: NomadProgress,
    private readonly session: NomadSession,
  ) {}

  private get bal() {
    return this.progress.snapshot?.balances ?? this.session.me?.balances ?? null;
  }
  get coins(): number {
    return this.bal?.coins ?? 0;
  }
  get gems(): number {
    return this.bal?.gems ?? 0;
  }
  get xp(): number {
    return this.bal?.xp ?? 0;
  }
  get streakTokens(): number {
    return this.bal?.streak_tokens ?? 0;
  }
  get ownedItems(): readonly string[] {
    return this.progress.snapshot?.items ?? [];
  }
  canAfford(coins: number): boolean {
    return this.coins >= coins;
  }
  owns(itemId: string): boolean {
    return this.ownedItems.includes(itemId);
  }
  grant(grant: RewardGrant): void {
    console.warn(`[NomadWallet] Ignored a client-side ${RewardKind[grant.kind]} grant of ${grant.amount} (${grant.source}): the server pays rewards.`);
  }
  tryGrant(grant: RewardGrant): boolean {
    this.grant(grant);
    return false;
  }
  tryConsumeStreakToken(): boolean {
    return false; // the server spends shields when it pays the login track
  }
  /** Pull the server's figures again (after a table pushed a new balance). */
  refresh(): void {
    void this.progress.refresh();
  }
}
