/**
 * The game systems the Nomad menu calls, as OPTIONAL services other modules install (economy, retention, net,
 * agents). They are read by name through `svc()` rather than declared on `Services`, so this module never fights
 * another module's declaration of the same key. Every call site checks presence and falls back to the offline
 * behaviour noted next to it.
 */
import type { AppContext } from '../app/app';
import type { StakeTier } from '@nomad/engine';

/** Extra AccountService members the economy module's account may carry (PlayFabLoginUI / PlayFabAuth / PokerClientIdentity). */
export interface AccountExtras {
  /** PokerClientIdentity.IsGuest (a device-only account). Offline: true. */
  isGuest?: boolean;
  /** PlayFabLoginUI.IsBusy. */
  busy?: boolean;
  /** PlayFabGate.LastError. */
  lastError?: string | null;
  /** PlayFabAuth.KeepMeSignedIn. */
  keepSignedIn?: boolean;
  setKeepSignedIn?(on: boolean): void;
  /** PlayFabLoginUI.ContinueAsGuest. */
  signInAsGuest?(): Promise<void> | void;
  /** PlayFabLoginUI.ContinueWithGoogle. */
  signInWithGoogle?(): Promise<void> | void;
  /** Sign in (or save a guest) with a NEAR wallet. */
  signInWithNear?(): Promise<void> | void;
  /** PlayFabLoginUI.SignInWithEmailAsync → error or null. */
  signInWithEmail?(email: string, password: string): Promise<string | null>;
  /** PlayFabAuth.AddRecoveryLoginAsync → error or null. */
  addRecoveryLogin?(email: string, password: string): Promise<string | null>;
  /** PlayFabAuth.RenameAsync → error or null (falls back to AccountService.setDisplayName). */
  rename?(name: string): Promise<string | null>;
}

/** PlayerProgression (economy). Offline: level 1, 0 %. */
export interface ProgressionLike {
  readonly level: number;
  readonly levelProgress01: number;
}

/** DailyEngagement + RetentionMenuHud (retention): ctx.services.retention. */
export interface RetentionLike {
  engagement?: { canSpin?(): boolean; previewLogin?(): { canClaim?: boolean } };
  progression?: ProgressionLike;
  stakes?: unknown;
  openDailySpin?(): void;
  openWeeklyRewards?(): void;
  openMissions?(): void;
}

/** FusionMenuUIMain "OnPlayButtonPressed" / FreePlayJoin (net). Return a promise that settles once at the table. */
export interface NetLike {
  quickPlay?(req: { tier: StakeTier; buyIn: number }): Promise<void>;
  freePlayJoin?(req: { tier: StakeTier; buyIn: number }): Promise<void>;
  /** MenuConnectCancel.Request + Connection.DisconnectAsync(UserRequest). */
  cancelSearch?(): void;
}

/** TournamentApiClient.CallAsync (tournaments / agents): the Agent backend calls (menu/market.ts). */
export interface BackendApiLike {
  call(method: string, path: string, json?: string | null, auth?: boolean): Promise<{ ok: boolean; body: string; error: string }>;
}

/** WebAudio volume setters. */
export interface VolumeSink {
  setVolumes(master: number, music: number, sfx: number): void;
}

export interface MenuDeps {
  progression: ProgressionLike;
  retention: RetentionLike;
  net: NetLike;
  backendApi: BackendApiLike;
}

/** An optional service by name (undefined when its module has not installed it). */
export function svc<K extends keyof MenuDeps>(ctx: AppContext, name: K): Partial<MenuDeps[K]> | undefined {
  return (ctx.services as unknown as Record<string, unknown>)[name] as Partial<MenuDeps[K]> | undefined;
}

/** PlayerProgression: the retention module's (ctx.services.retention.progression), else a 'progression' service. */
export function progressionOf(ctx: AppContext): Partial<ProgressionLike> | undefined {
  return svc(ctx, 'retention')?.progression ?? svc(ctx, 'progression');
}

/** DailyEngagement.CanSpin() / PreviewLogin().CanClaim (false with no retention module). */
export function canSpin(ctx: AppContext): boolean {
  return !!svc(ctx, 'retention')?.engagement?.canSpin?.();
}
export function canClaimLogin(ctx: AppContext): boolean {
  return !!svc(ctx, 'retention')?.engagement?.previewLogin?.()?.canClaim;
}

export function accountExtras(ctx: AppContext): AccountExtras {
  return ctx.services.account as unknown as AccountExtras;
}
