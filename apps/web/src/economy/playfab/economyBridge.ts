/**
 * Ports of Economy/PlayFabEconomyBridge.cs (hooks a PlayFab sign-in into VirtualEconomy: CH balance, UserData
 * progress, the PlayFab wallet provider, leaderboards, and the claimRetentionGrant flush with spaced retries) and
 * Economy/PlayFabGate.cs (the one memoised sign-in everyone awaits; never faults).
 */
import { LocalVirtualWallet } from '../localVirtualWallet';
import { PokerClientIdentity } from '../identity';
import { FreePlayLeaderboard } from '../leaderboards/freePlayLeaderboard';
import { RetentionGrantQueue, type GrantEntry } from '../retentionGrantQueue';
import { Signal } from '../signal';
import { FreePlayBank, VirtualEconomy } from '../virtualEconomy';
import { PlayFabAuth } from './auth';
import { errorReport } from './client';
import { PlayFabLeaderboardBridge } from './leaderboardBridge';
import { PlayFabAgentProgress, PlayFabPlayerProgress } from './playerProgress';
import { playFab } from './runtime';
import { PlayFabVirtualWallet } from './virtualWallet';
import { PlayFabWallet } from './wallet';

const ClaimHandler = 'claimRetentionGrant';
const MaxAutoRetries = 3;

let playFabWallet: PlayFabVirtualWallet | null = null;
let unsubscribeBalance: (() => void) | null = null;
let flushInFlight = false;
let flushAgain = false;
let retryScheduled = false;
let retryCount = 0;

type GrantOutcome = { kind: 'paid'; balance: number } | { kind: 'refused'; detail: string } | { kind: 'retry'; detail: string };

/** The handler's refusals no retry will change. */
const isFinalRefusal = (code: string | null) => code === 'invalid_grant' || code === 'too_old' || code === 'daily_limit';

async function claimViaCloudScript(entry: GrantEntry): Promise<GrantOutcome> {
  const r = await playFab()!.client<{ FunctionResult?: Record<string, unknown>; Error?: { Error?: string; Message?: string } }>(
    'ExecuteCloudScript', { FunctionName: ClaimHandler, FunctionParameter: { key: entry.key, chips: entry.chips, reason: entry.reason }, GeneratePlayStreamEvent: false });
  if (r.error) return { kind: 'retry', detail: errorReport(r.error) };
  if (r.data.Error) return { kind: 'retry', detail: `${r.data.Error.Error}: ${r.data.Error.Message}` };
  const reply = r.data.FunctionResult;
  if (reply && reply.ok === true) return { kind: 'paid', balance: typeof reply.balance === 'number' ? Math.trunc(reply.balance) : -1 };
  const code = reply && typeof reply.error === 'string' ? reply.error : null;
  return isFinalRefusal(code) ? { kind: 'refused', detail: code! } : { kind: 'retry', detail: code ?? 'no result' };
}

async function refreshBalanceAsync(): Promise<void> {
  await PlayFabWallet.refreshAsync();
  VirtualEconomy.notify();
}

async function flushAsync(): Promise<void> {
  flushInFlight = true;
  let anyRetry = false;
  let accountChanged = false;
  try {
    const playFabId = PokerClientIdentity.playFabId;
    if (!playFabId) return;
    const attempted = new Set<string>();
    do {
      flushAgain = false;
      for (const entry of RetentionGrantQueue.snapshotForAccount(playFabId)) {
        if (attempted.has(entry.key)) continue;
        attempted.add(entry.key);
        if (PokerClientIdentity.playFabId !== playFabId) {
          accountChanged = true;
          break;
        }
        const outcome = await claimViaCloudScript(entry);
        if (outcome.kind === 'paid') PlayFabEconomyBridge.onGrantSettled(entry.key, true, outcome.balance);
        else if (outcome.kind === 'refused') {
          console.warn(`[PlayFabEconomy] Grant '${entry.key}' refused (${outcome.detail}) — dropped.`);
          RetentionGrantQueue.settle(entry.key);
          void refreshBalanceAsync();
        } else {
          console.warn(`[PlayFabEconomy] Grant '${entry.key}' not paid yet (${outcome.detail}) — kept queued.`);
          anyRetry = true;
        }
      }
    } while (flushAgain && !accountChanged);
  } catch (e) {
    console.warn('[PlayFabEconomy] Grant flush stopped', e);
    anyRetry = true;
  } finally {
    flushInFlight = false;
  }
  if (accountChanged) {
    PlayFabEconomyBridge.requestFlushPendingGrants();
    return;
  }
  if (anyRetry) void retryLaterAsync();
  else retryCount = 0;
}

async function retryLaterAsync(): Promise<void> {
  if (retryScheduled || retryCount >= MaxAutoRetries) return;
  retryScheduled = true;
  await new Promise((r) => setTimeout(r, (30 << retryCount) * 1000));
  retryCount++;
  retryScheduled = false;
  PlayFabEconomyBridge.requestFlushPendingGrants();
}

export const PlayFabEconomyBridge = {
  /** After attachAfterSignInAsync installed the PlayFab wallet (retention: EnsureTodaysSpinCredit, LevelUp hydration). */
  attached: new Signal(),
  /** After detachToLocal restored the local wallet. */
  detached: new Signal(),

  get wallet(): PlayFabVirtualWallet | null {
    return playFabWallet;
  },

  async attachAfterSignInAsync(): Promise<void> {
    FreePlayBank.bindAccount(PokerClientIdentity.playFabId);
    await PlayFabWallet.refreshAsync();
    void PlayFabWallet.followTableCashOutAsync(PokerClientIdentity.playFabId);
    await PlayFabPlayerProgress.pullAsync();

    playFabWallet ??= new PlayFabVirtualWallet(() => PlayFabEconomyBridge.requestFlushPendingGrants());
    playFabWallet.bindToSignedInAccount();
    VirtualEconomy.setProvider(playFabWallet);
    FreePlayBank.clear();
    unsubscribeBalance ??= PlayFabWallet.balanceChanged.on(() => VirtualEconomy.notify());
    VirtualEconomy.notify();

    PlayFabLeaderboardBridge.attach();
    FreePlayLeaderboard.localDisplayName = PokerClientIdentity.playerName || 'You';
    await PlayFabAgentProgress.pullAsync();

    PlayFabEconomyBridge.requestFlushPendingGrants();
    PlayFabEconomyBridge.attached.emit();
    PlayFabEconomyBridge.requestFlushPendingGrants();
  },

  /** Restores the local stand-in after sign-out so the menu still has a wallet. */
  detachToLocal(): void {
    unsubscribeBalance?.();
    unsubscribeBalance = null;
    PlayFabPlayerProgress.clear();
    PlayFabAgentProgress.clear();
    PlayFabLeaderboardBridge.detach();
    playFabWallet = null;
    FreePlayBank.bindAccount(null);
    const local = new LocalVirtualWallet();
    local.ensureLoaded();
    VirtualEconomy.setProvider(local);
    PlayFabEconomyBridge.detached.emit();
  },

  /** Settles pending coin grants now (from the menu or a table); a grant queued mid-flush joins that flush. */
  requestFlushPendingGrants(): void {
    if (!PokerClientIdentity.isPlayFabSignedIn) return;
    if (flushInFlight) {
      flushAgain = true;
      return;
    }
    if (RetentionGrantQueue.snapshotForAccount(PokerClientIdentity.playFabId).length === 0) return;
    void flushAsync();
  },

  onGrantSettled(key: string, success: boolean, balance: number): void {
    if (!RetentionGrantQueue.contains(key)) return;
    if (success) {
      RetentionGrantQueue.settle(key);
      if (balance >= 0) PlayFabWallet.adopt(balance);
      else void PlayFabWallet.refreshAsync();
      VirtualEconomy.notify();
    } else {
      console.warn(`[PlayFabEconomy] Grant '${key}' not settled yet — keeping queued.`);
      void refreshBalanceAsync();
    }
  },

  /** Resolves when no flush is running (tests). */
  async idle(): Promise<void> {
    while (flushInFlight) await new Promise((r) => setTimeout(r, 0));
  },

  resetForTests(): void {
    unsubscribeBalance?.();
    unsubscribeBalance = null;
    playFabWallet = null;
    flushInFlight = flushAgain = retryScheduled = false;
    retryCount = 0;
  },
};

// ---- PlayFabGate ---------------------------------------------------------------------------------------

let init: Promise<boolean> | null = null;
let ready = false;
let lastError: string | null = null;

async function runGate(forceSignIn: boolean): Promise<boolean> {
  try {
    if (PlayFabAuth.tryRestoreSession()) {
      const restored = await PlayFabAuth.validateRestoredSessionAsync();
      if (restored.success) {
        ready = true;
        lastError = null;
        console.log(`[PlayFab] Restored saved session for ${restored.playFabId}${PokerClientIdentity.isGuest ? ' (guest)' : ''}.`);
        await PlayFabEconomyBridge.attachAfterSignInAsync();
        return true;
      }
      console.log('[PlayFab] Saved session was rejected — signing in again.');
    }
    if (PlayFabAuth.isSignedIn) {
      ready = true;
      await PlayFabEconomyBridge.attachAfterSignInAsync();
      return true;
    }
    if (!forceSignIn && !PlayFabAuth.keepMeSignedIn) {
      ready = false;
      lastError = null;
      console.log('[PlayFab] Skipping auto sign-in (Keep me signed in is off).');
      return false;
    }
    const result = await PlayFabAuth.signInAsDeviceAsync();
    ready = result.success;
    lastError = result.success ? null : result.error;
    if (result.success) console.log(`[PlayFab] Signed in as ${result.playFabId}${PokerClientIdentity.isGuest ? ' (guest)' : ''}.`);
    else console.warn(`[PlayFab] Sign-in failed — economy features stay off: ${result.error}`);
    if (ready) await PlayFabEconomyBridge.attachAfterSignInAsync();
    return ready;
  } catch (e) {
    lastError = 'Something went wrong signing in.';
    console.error('[PlayFab] Gate threw — economy features stay off', e);
    return false;
  }
}

export const PlayFabGate = {
  get isReady(): boolean {
    return ready;
  },
  /** Why the last attempt failed, player-facing; null when fine. */
  get lastError(): string | null {
    return lastError;
  },

  /** Signs in when Keep me signed in is set (saved session, then device). Memoised; never faults. */
  initializeAsync(): Promise<boolean> {
    if (!playFab()) {
      ready = false;
      return Promise.resolve(false);
    }
    init ??= runGate(false);
    return init;
  },

  /** Explicit Guest / recovery path: always attempts device sign-in. */
  signInExplicitAsync(): Promise<boolean> {
    if (!playFab()) return Promise.resolve(false);
    init = runGate(true);
    return init;
  },

  /** Marks the gate ready after a Google / email login that bypassed initializeAsync. */
  notifySignedIn(): void {
    ready = true;
    lastError = null;
    init = Promise.resolve(true);
  },

  /** Forces the next initializeAsync to try again (sign-out, retry after a failure). */
  reset(): void {
    init = null;
    ready = false;
    lastError = null;
  },
};
