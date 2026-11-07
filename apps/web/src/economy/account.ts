/**
 * The account service: who is playing, and every sign-in flow the UI offers. It is the flow half of
 * Economy/Ui/PlayFabLoginUI.cs (StartUpAsync, Play as Guest, Continue with Google, email sign-in / save account,
 * sign-out) on top of PlayFabAuth + PlayFabGate, usable by this module's own panel and by the Nomad menu's Login
 * screen (the menu module) alike.
 *
 * Offline mode has no PlayFab: "Play as Guest" signs a local guest in (same guest name, same Keep me signed in
 * pref), Google and email answer that they need online mode, and the wallet is LocalVirtualWallet.
 */
import type { EventBus } from '../app/app';
import { PlayerPrefs, type AccountService } from '../app/services';
import { FriendCode } from '../core/social/friendCode';
import type { BackendMode } from './config';
import { MenuUsernamePref, PokerClientIdentity } from './identity';
import { PlayFabAuth } from './playfab/auth';
import { PlayFabEconomyBridge, PlayFabGate } from './playfab/economyBridge';
import { requestGoogleCredential } from './playfab/googleSignIn';
import { PlayFabWallet } from './playfab/wallet';
import { Signal } from './signal';
import { FriendInvites } from './social/friendInvites';
import { PlayFabFriends } from './social/playFabFriends';
import { PlayerAvatar } from './social/playerAvatar';

const KeepMeSignedInPref = 'Poker.PlayFab.KeepMeSignedIn';

export class EconomyAccount implements AccountService {
  /** Status line (the login panel's status text): progress, a failure, or a confirmation. */
  readonly statusChanged = new Signal<string | null>();
  private _status: string | null = null;
  private _busy = false;
  private _signingInQuietly = false;
  private localSignedIn = false;

  constructor(readonly mode: BackendMode, private readonly events: EventBus) {
    const changed = () => events.emit('account:changed');
    PokerClientIdentity.changed.on(changed);
    PlayerAvatar.changed.on(changed);
  }

  // ---- AccountService

  /** PlayFabLoginUI.IsReady (offline: a local guest is signed in). The menu gates Play on this. */
  get signedIn(): boolean {
    if (this.mode === 'offline') return this.localSignedIn;
    return PlayFabGate.isReady && PokerClientIdentity.isPlayFabSignedIn;
  }
  get playerId(): string {
    return this.mode === 'offline' ? 'guest-' + PokerClientIdentity.token.substring(0, 8) : PokerClientIdentity.playFabId;
  }
  get displayName(): string {
    return PokerClientIdentity.playerName;
  }
  get avatar(): number {
    return PlayerAvatar.current;
  }
  get walletAddress(): string | null {
    return PokerClientIdentity.walletPubkey || null;
  }

  // ---- Extras

  get isGuest(): boolean {
    return this.mode === 'offline' ? this.localSignedIn : PokerClientIdentity.isGuest;
  }
  /** "1A2B-3C4D-5E6F-7A8B" — the formatted PlayFabId; '' offline (no account to add). */
  get friendId(): string {
    return FriendCode.format(PokerClientIdentity.playFabId);
  }
  get busy(): boolean {
    return this._busy;
  }
  get signingInQuietly(): boolean {
    return this._signingInQuietly;
  }
  get status(): string | null {
    return this._status;
  }
  get lastError(): string | null {
    return this.mode === 'offline' ? null : PlayFabGate.lastError;
  }
  get keepMeSignedIn(): boolean {
    return PlayerPrefs.getInt(KeepMeSignedInPref, 0) !== 0;
  }
  /** Nomad Login screen's Keep me signed in (PlayFabLoginUI.SetKeepMeSignedIn). */
  setKeepMeSignedIn(on: boolean): void {
    if (this.mode === 'offline') PlayerPrefs.setInt(KeepMeSignedInPref, on ? 1 : 0);
    else PlayFabAuth.keepMeSignedIn = on;
    this.changed();
  }

  /** PlayFabLoginUI.StartUpAsync: only auto-sign when the player opted into Keep me signed in. */
  async startUpAsync(): Promise<void> {
    if (this.mode === 'offline') {
      if (this.keepMeSignedIn) this.signInLocalGuest();
      return;
    }
    if (!PlayFabAuth.keepMeSignedIn && !PokerClientIdentity.isPlayFabSignedIn) {
      this.setBusy(false, null);
      return;
    }
    this._signingInQuietly = true;
    this.changed();
    const ok = await PlayFabGate.initializeAsync();
    this._signingInQuietly = false;
    this.setStatus(ok ? null : PlayFabGate.lastError);
    this.changed();
  }

  /** Play as Guest. Resolves null when signed in, else the reason. */
  async continueAsGuest(): Promise<string | null> {
    if (this._busy) return null;
    if (this.mode === 'offline') {
      this.signInLocalGuest();
      return null;
    }
    if (PokerClientIdentity.isPlayFabSignedIn) {
      this.setStatus(null);
      this.changed();
      return null;
    }
    this.setBusy(true, 'Signing in…');
    const ok = await PlayFabGate.signInExplicitAsync();
    this.setBusy(false, ok ? null : PlayFabGate.lastError);
    this.changed();
    return ok ? null : PlayFabGate.lastError ?? 'Sign-in failed.';
  }

  /** Continue with Google: links Google onto a guest, else signs in with it. Null when signed in. */
  async continueWithGoogle(): Promise<string | null> {
    if (this._busy) return null;
    if (this.mode === 'offline') return this.fail('Google sign-in needs the live PlayFab title (online mode). Guest still works here.');
    const wasGuest = PokerClientIdentity.isGuest && PokerClientIdentity.isPlayFabSignedIn;
    const idBefore = PokerClientIdentity.playFabId;
    this.setBusy(true, 'Opening Google…');
    try {
      const cred = await requestGoogleCredential();
      if (!cred.ok) return this.fail(cred.value || 'Google sign-in failed.');
      this.setBusy(true, 'Signing in…');
      const result = await PlayFabAuth.continueWithGoogleCredentialAsync(cred.value);
      if (!result.success) return this.fail(result.error ?? 'Google sign-in failed.');
      PlayFabGate.notifySignedIn();
      PlayFabAuth.keepMeSignedIn = true;
      const linkedInPlace = wasGuest && !!idBefore && idBefore === PokerClientIdentity.playFabId;
      this.setStatus(linkedInPlace ? 'Google linked — your progress is saved.' : 'Signed in with Google.');
      try {
        await PlayFabEconomyBridge.attachAfterSignInAsync();
      } catch (e) {
        console.warn('[Account] Post-Google attach failed', e);
      }
      return null;
    } catch (e) {
      console.error('[Account] Google sign-in threw', e);
      return this.fail('Google sign-in failed. Try again.');
    } finally {
      if (this._busy) this.setBusy(false, null);
      this.changed();
    }
  }

  /** Email sign-in (PlayFabLoginUI.SignInWithEmailAsync / the panel's Sign in). Null when signed in. */
  async signInWithEmail(email: string, password: string): Promise<string | null> {
    if (this.mode === 'offline') return this.fail('Email sign-in needs PlayFab (online mode).');
    this.setBusy(true, 'Signing in…');
    const result = await PlayFabAuth.loginWithEmailAsync(email, password);
    if (result.success && PlayFabAuth.keepMeSignedIn) await PlayFabAuth.linkDeviceAsync();
    this.setBusy(false, result.success ? null : result.error);
    if (!result.success) {
      this.changed();
      return result.error ?? 'Sign-in failed.';
    }
    PlayFabGate.notifySignedIn();
    this.setStatus('Signed in.');
    await PlayFabEconomyBridge.attachAfterSignInAsync();
    this.changed();
    return null;
  }

  /** Save your account: attach email + password to THIS account (a guest keeps their chips). */
  async saveAccount(email: string, password: string): Promise<string | null> {
    if (this.mode === 'offline') return this.fail('Saving an account needs PlayFab (online mode).');
    this.setBusy(true, 'Saving your account…');
    const result = await PlayFabAuth.addRecoveryLoginAsync(email, password, null);
    this.setBusy(false, result.success ? null : result.error);
    if (!result.success) {
      this.changed();
      return result.error ?? 'Could not save the account.';
    }
    PlayFabGate.notifySignedIn();
    this.setStatus('Account saved.');
    await PlayFabEconomyBridge.attachAfterSignInAsync();
    this.changed();
    return null;
  }

  /** The menu's rename (PlayFabAuth.RenameAsync): null when the name stands, else why not. */
  async rename(name: string): Promise<string | null> {
    const error = await PlayFabAuth.renameAsync(name);
    if (error === null && !PlayFabAuth.isSignedIn) {
      // Signed out the Fusion menu saves its own username field; this port has no Fusion menu, so save it here.
      PlayerPrefs.setString(MenuUsernamePref, PokerClientIdentity.playerName);
    }
    this.changed();
    return error;
  }

  /** AccountService.setDisplayName: rejects with the player-facing reason when the name is refused. */
  async setDisplayName(name: string): Promise<void> {
    const error = await this.rename(name);
    if (error) throw new Error(error);
  }

  async setAvatar(avatar: number): Promise<void> {
    PlayerAvatar.choose(avatar);
  }

  /** PlayFabLoginUI.SignOutFromChrome: clears Keep me signed in, no auto-login again. */
  async signOut(): Promise<void> {
    if (this.mode === 'offline') {
      PlayerPrefs.setInt(KeepMeSignedInPref, 0);
      this.localSignedIn = false;
    } else {
      PlayFabAuth.signOut();
      PlayFabWallet.clear();
      PlayFabGate.reset();
      PlayFabEconomyBridge.detachToLocal();
      PlayFabFriends.clear();
      FriendInvites.clear();
      PlayerAvatar.forgetLocal();
    }
    this.setStatus('Signed out.');
    this.changed();
  }

  // ---- Names the Nomad menu reads (menu/deps.ts AccountExtras) and the tournaments module (session ticket)

  get keepSignedIn(): boolean {
    return this.keepMeSignedIn;
  }
  setKeepSignedIn(on: boolean): void {
    this.setKeepMeSignedIn(on);
  }
  async signInAsGuest(): Promise<void> {
    await this.continueAsGuest();
  }
  async signInWithGoogle(): Promise<void> {
    await this.continueWithGoogle();
  }
  addRecoveryLogin(email: string, password: string): Promise<string | null> {
    return this.saveAccount(email, password);
  }
  /** This session's PlayFab ticket ('' offline) — what a table server verifies (ChipLedger.authenticateAsync). */
  get playFabSessionTicket(): string {
    return PokerClientIdentity.playFabSessionTicket;
  }

  /** The web3 module calls this after it wrote / cleared Poker.WalletPubkey + Poker.SessionJwt. */
  notifyWalletChanged(): void {
    this.changed();
  }

  private signInLocalGuest(): void {
    this.localSignedIn = true;
    if (PlayFabAuth.isFusionPlaceholderUsername(PokerClientIdentity.playerName) || PokerClientIdentity.playerName === 'Player') {
      PlayFabAuth.applyLocalDisplayName(PokerClientIdentity.getOrCreateGuestName());
    }
    this.setStatus(null);
    this.changed();
  }

  private fail(message: string): string {
    this.setBusy(false, message);
    this.changed();
    return message;
  }

  private setBusy(busy: boolean, message: string | null): void {
    this._busy = busy;
    if (message !== null) this.setStatus(message);
  }

  private setStatus(message: string | null): void {
    this._status = message;
    this.statusChanged.emit(message);
  }

  private changed(): void {
    this.events.emit('account:changed');
  }
}
