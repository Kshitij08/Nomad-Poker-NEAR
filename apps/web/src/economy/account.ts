/**
 * The account service: who is playing, and every sign-in flow the UI offers (the menu's Login screen and profile).
 *
 * With a Nomad server (the account module's session, NomadLink) the account is the server's: everyone plays as a
 * server guest until they sign in, Google and email-link sign-in link to that guest (keeping its coins), renames and
 * avatars are saved there, and PokerClientIdentity mirrors the server (its "playFabId" is the public Friend ID, so the
 * Friends screens show it unchanged). Without one there is a local guest only — the game still plays offline.
 */
import { requestGoogleIdToken } from '../account/googleSignIn';
import type { EventBus } from '../app/app';
import { PlayerPrefs, type AccountService } from '../app/services';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { SocialRoutes, type PlayerProfile } from '@nomad/contract';
import { PokerClientIdentity } from './identity';
import { DisplayNames } from './names';
import { NomadLink } from './nomadLink';
import { Signal } from './signal';
import { FriendInvites } from './social/friendInvites';
import { Friends } from './social/friends';
import { PlayerAvatar } from './social/playerAvatar';

const KeepMeSignedInPref = 'Poker.KeepMeSignedIn';

export class EconomyAccount implements AccountService {
  /** Status line: progress, a failure, or a confirmation. */
  readonly statusChanged = new Signal<string | null>();
  private _status: string | null = null;
  private _busy = false;
  private localSignedIn = false;

  constructor(private readonly events: EventBus) {
    const changed = () => events.emit('account:changed');
    PokerClientIdentity.changed.on(changed);
    PlayerAvatar.changed.on(changed);
    // The server's view of this player is the truth: mirror it whenever the session changes.
    events.on('nomad:changed', () => this.adoptServerProfile());
  }

  /** A Nomad server is configured (else: offline, local guest). */
  get online(): boolean {
    return NomadLink.configured;
  }

  private get me(): PlayerProfile | null {
    return NomadLink.session?.me?.player ?? null;
  }

  // ---- AccountService

  get signedIn(): boolean {
    return this.online ? NomadLink.signedIn : this.localSignedIn;
  }
  get playerId(): string {
    return this.me?.id ?? 'guest-' + PokerClientIdentity.token.substring(0, 8);
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

  // ---- Extras the menu reads (menu/deps.ts AccountExtras)

  get isGuest(): boolean {
    return this.online ? (this.me?.kind ?? 'guest') === 'guest' : this.localSignedIn;
  }
  /** "1A2B-3C4D-5E6F-7A8B" — the Friend ID; '' offline. */
  get friendId(): string {
    return this.me ? FriendCode.format(this.me.friendCode) : '';
  }
  get busy(): boolean {
    return this._busy || !!NomadLink.session?.busy;
  }
  get signingInQuietly(): boolean {
    return this.online && !NomadLink.signedIn && !!NomadLink.session?.busy;
  }
  get status(): string | null {
    return this._status;
  }
  get lastError(): string | null {
    return NomadLink.session?.error ?? null;
  }
  get keepMeSignedIn(): boolean {
    // With a server the session token persists by itself; the toggle only matters offline.
    return this.online || PlayerPrefs.getInt(KeepMeSignedInPref, 0) !== 0;
  }
  setKeepMeSignedIn(on: boolean): void {
    PlayerPrefs.setInt(KeepMeSignedInPref, on ? 1 : 0);
    this.changed();
  }
  get keepSignedIn(): boolean {
    return this.keepMeSignedIn;
  }
  setKeepSignedIn(on: boolean): void {
    this.setKeepMeSignedIn(on);
  }

  /** At boot: offline, sign the local guest in again when the player asked to be kept signed in. */
  async startUpAsync(): Promise<void> {
    if (!this.online && this.keepMeSignedIn) this.signInLocalGuest();
  }

  /** Play as Guest. Resolves null when signed in, else the reason. */
  async continueAsGuest(): Promise<string | null> {
    const s = NomadLink.session;
    if (!s) {
      this.signInLocalGuest();
      return null;
    }
    if (s.signedIn) return null;
    this.setBusy(true, 'Signing in…');
    await s.guest(PokerClientIdentity.playerName);
    this.setBusy(false, s.signedIn ? null : s.error);
    return s.signedIn ? null : (s.error ?? 'Sign-in failed.');
  }

  /**
   * Continue with Google: Google's prompt (or its button in a small dialog) hands back an ID token, which the Nomad
   * server checks. A guest signed in on this browser keeps its coins: Google is linked to it.
   */
  async continueWithGoogle(): Promise<string | null> {
    const s = NomadLink.session;
    if (!s) return this.fail('Google sign-in needs the Nomad server. Play as Guest instead.');
    let idToken: string | null;
    try {
      idToken = await requestGoogleIdToken();
    } catch (e) {
      return this.fail((e as Error).message || "Couldn't reach Google.");
    }
    if (!idToken) {
      this.setBusy(false, null);
      return 'Google sign-in cancelled.';
    }
    this.setBusy(true, 'Signing in…');
    await s.google(idToken);
    this.setBusy(false, s.signedIn ? null : s.error);
    this.changed();
    return s.signedIn ? null : (s.error ?? 'Google sign-in failed.');
  }

  /**
   * Email sign-in: a one-time link (no passwords). The link signs this browser in when opened; on staging, where no
   * mail is sent, the server hands the link back and it is followed here. Linking keeps a guest's coins.
   */
  async signInWithEmail(email: string, _password = ''): Promise<string | null> {
    const s = NomadLink.session;
    if (!s) return this.fail('Email sign-in needs the Nomad server. Play as Guest instead.');
    const address = (email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return this.fail('Enter your email address.');
    this.setBusy(true, 'Sending your sign-in link…');
    const r = await s.emailStart(address);
    if (!r) return this.fail(s.error ?? 'Could not send the link.');
    if (r.devLink) {
      const token = new URL(r.devLink).searchParams.get('emailToken');
      if (token) await s.emailVerify(token);
      this.setBusy(false, s.signedIn ? 'Signed in.' : s.error);
      return s.error;
    }
    this.setBusy(false, `Check ${address} for your sign-in link.`);
    return null;
  }

  /** Save your account: attach an email to THIS account (a guest keeps its coins and progress). */
  addRecoveryLogin(email: string, password = ''): Promise<string | null> {
    return this.signInWithEmail(email, password);
  }

  /** The menu's rename: null when the name stands, else why not. */
  async rename(name: string): Promise<string | null> {
    const invalid = DisplayNames.validate(name);
    if (invalid) return invalid;
    const trimmed = name.trim();
    if (NomadLink.signedIn) {
      try {
        const p = await NomadLink.call<PlayerProfile>('POST', SocialRoutes.profile, { displayName: trimmed });
        DisplayNames.apply(p.displayName);
        await NomadLink.session?.refresh();
      } catch (e) {
        return (e as Error).message || 'Could not save the name.';
      }
    } else DisplayNames.apply(trimmed);
    this.changed();
    return null;
  }

  async setDisplayName(name: string): Promise<void> {
    const error = await this.rename(name);
    if (error) throw new Error(error);
  }

  async setAvatar(avatar: number): Promise<void> {
    PlayerAvatar.choose(avatar); // AccountAvatar saves it to the server
  }

  async signOut(): Promise<void> {
    const s = NomadLink.session;
    if (s) {
      await s.signOut();
      Friends.clear();
      FriendInvites.clear();
      PlayerAvatar.forgetLocal();
      PokerClientIdentity.playFabId = '';
    } else {
      PlayerPrefs.setInt(KeepMeSignedInPref, 0);
      this.localSignedIn = false;
    }
    this.setStatus('Signed out.');
    this.changed();
  }

  async signInAsGuest(): Promise<void> {
    await this.continueAsGuest();
  }
  async signInWithGoogle(): Promise<void> {
    await this.continueWithGoogle();
  }

  /** The ticket a table server verifies: the Nomad session token ('' offline). */
  get playFabSessionTicket(): string {
    return NomadLink.session?.token ?? '';
  }

  /** The web3 module calls this after it wrote / cleared Poker.WalletPubkey + Poker.SessionJwt. */
  notifyWalletChanged(): void {
    this.changed();
  }

  /** Mirror the server's player into the local identity (name, Friend ID, guest flag). */
  adoptServerProfile(): void {
    const me = this.me;
    if (!me) return;
    if (PokerClientIdentity.playFabId !== me.friendCode) PokerClientIdentity.playFabId = me.friendCode;
    if (PokerClientIdentity.isGuest !== (me.kind === 'guest')) PokerClientIdentity.isGuest = me.kind === 'guest';
    DisplayNames.apply(me.displayName);
    this.changed();
  }

  private signInLocalGuest(): void {
    this.localSignedIn = true;
    if (DisplayNames.isFusionPlaceholder(PokerClientIdentity.playerName) || PokerClientIdentity.playerName === 'Player') {
      DisplayNames.apply(PokerClientIdentity.getOrCreateGuestName());
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
    this.changed();
  }

  private setStatus(message: string | null): void {
    this._status = message;
    this.statusChanged.emit(message);
  }

  private changed(): void {
    this.events.emit('account:changed');
  }
}
