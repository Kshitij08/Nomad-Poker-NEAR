/**
 * Port of Economy/PlayFabAuth.cs: every PlayFab call that establishes or changes who this player is.
 *
 * The DEVICE is the login (a CustomID = PokerClientIdentity.token, account created on first run); email/password
 * and Google are RECOVERY methods attached to that same account, never a second account. Every method resolves to
 * an AuthResult and never throws.
 *
 * The WebGL-only branches of the C# (browser fetch for Google login / link / link-device) are the only path here,
 * because this client is fetch-based already.
 */
import { PlayerPrefs } from '../../app/services';
import { parsePlayFabWebResponse } from '@nomad/engine/economy/playFabWebResponse';
import { PokerFunnel } from '../analytics/pokerFunnel';
import { PlayFabConfig } from '../config';
import { MenuUsernamePref, PokerClientIdentity } from '../identity';
import { Signal } from '../signal';
import { errorReport, type ApiResult, type LoginResult, type PlayFabError } from './client';
import { requestGoogleCredential } from './googleSignIn';
import { isClientLoggedIn, playFab } from './runtime';

export interface AuthResult {
  readonly success: boolean;
  /** Player-facing; null on success. */
  readonly error: string | null;
  readonly playFabId: string | null;
}
export const AuthResult = {
  ok: (playFabId: string | null = null): AuthResult => ({ success: true, error: null, playFabId }),
  fail: (error: string): AuthResult => ({ success: false, error, playFabId: null }),
};

const KeepMeSignedInPref = 'Poker.PlayFab.KeepMeSignedIn';
const SavedSessionPref = 'Poker.PlayFab.Session';
const DefaultSessionLifetimeMs = 23 * 3600_000;
const RestoreMarginMs = 10 * 60_000;
const MinDisplayName = 3;
const MaxDisplayName = 25;
const PlaceholderName = 'Player';
/** .NET DateTime ticks at the unix epoch (the saved session stores expiresUtcTicks like JsonUtility did). */
const EPOCH_TICKS = 621355968000000000;
const msToTicks = (ms: number): number => ms * 10000 + EPOCH_TICKS;
const ticksToMs = (ticks: number): number => (ticks - EPOCH_TICKS) / 10000;

interface SavedSession {
  titleId: string;
  playFabId: string;
  sessionTicket: string;
  entityToken: string;
  entityId: string;
  entityType: string;
  expiresUtcTicks: number;
}

let sessionExpiresUtc = 0;
let syncedDisplayName: string | null = null;
let lastDisplayNameAttempt: string | null = null;

const sameIgnoreCase = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();
const isLetterOrDigit = (c: string): boolean => /[\p{L}\p{Nd}]/u.test(c);

export const PlayFabAuth = {
  /** Fired whenever the local display name changes (profile, guest assign, rename). */
  displayNameChanged: new Signal<string>(),

  get isSignedIn(): boolean {
    return isClientLoggedIn();
  },

  get keepMeSignedIn(): boolean {
    return PlayerPrefs.getInt(KeepMeSignedInPref, 0) !== 0;
  },
  set keepMeSignedIn(value: boolean) {
    PlayerPrefs.setInt(KeepMeSignedInPref, value ? 1 : 0);
    if (value) saveSession();
    else clearSavedSession();
  },

  // ---- Sign in

  signInAsDeviceAsync(): Promise<AuthResult> {
    return run<LoginResult>('LoginWithCustomID', {
      TitleId: PlayFabConfig.TitleId, CustomId: PokerClientIdentity.token, CreateAccount: true, InfoRequestParameters: accountInfo(),
    }, (r) => adoptLogin(r, true), false);
  },

  loginWithEmailAsync(email: string | null, password: string | null): Promise<AuthResult> {
    if (!email || !email.trim()) return Promise.resolve(AuthResult.fail('Enter your email.'));
    if (!password) return Promise.resolve(AuthResult.fail('Enter your password.'));
    return run<LoginResult>('LoginWithEmailAddress', {
      TitleId: PlayFabConfig.TitleId, Email: email.trim(), Password: password, InfoRequestParameters: accountInfo(),
    }, (r) => adoptLogin(r, false), false);
  },

  /** Signs in (or creates) with a Google credential (`token:…` access token; `code:…` legacy). */
  async loginWithGoogleAsync(credential: string): Promise<AuthResult> {
    const split = splitGoogleCredential(credential);
    if (!split) return AuthResult.fail('Google sign-in did not return a credential.');
    const c = playFab();
    if (!c) return AuthResult.fail(Explain('NetworkError'));
    const res = await c.client<LoginResult>('LoginWithGoogleAccount', {
      TitleId: PlayFabConfig.TitleId,
      AccessToken: split.accessToken ?? undefined,
      ServerAuthCode: split.serverAuthCode ?? undefined,
      CreateAccount: true,
      InfoRequestParameters: { GetPlayerProfile: true },
    }, false);
    const response = parsePlayFabWebResponse(JSON.stringify(res.error
      ? { code: res.error.httpCode || 400, error: res.error.error, errorMessage: res.error.errorMessage }
      : { code: 200, data: res.data }));
    if (!response.isSuccess) {
      console.warn(`[PlayFabAuth] Browser LoginWithGoogleAccount failed: ${response.errorCode}`);
      return AuthResult.fail(explainGoogleWeb(response.errorCode, response.errorMessage));
    }
    if (!response.sessionTicket || !response.playFabId) return AuthResult.fail('PlayFab returned an incomplete login response.');
    const login: LoginResult = res.data!;
    c.adoptContext({
      sessionTicket: response.sessionTicket, entityToken: response.entityToken ?? '', playFabId: response.playFabId,
      entityId: response.entityId ?? '', entityType: response.entityType ?? '',
    });
    adoptLogin(login, false);
    PokerClientIdentity.isGuest = false;
    if (login.NewlyCreated) PokerFunnel.onAccountCreated('google');
    return AuthResult.ok(response.playFabId);
  },

  /** Links Google to the signed-in account (guest upgrade): same PlayFabId and chips. */
  async linkGoogleAsync(credential: string): Promise<AuthResult> {
    if (!PlayFabAuth.isSignedIn) return AuthResult.fail('Sign in first.');
    const split = splitGoogleCredential(credential);
    if (!split) return AuthResult.fail('Google sign-in did not return a credential.');
    const res = await playFab()!.client('LinkGoogleAccount', {
      AccessToken: split.accessToken ?? undefined, ServerAuthCode: split.serverAuthCode ?? undefined, ForceLink: true,
    });
    if (res.error) {
      console.warn(`[PlayFabAuth] Browser LinkGoogleAccount failed: ${res.error.error}`);
      return AuthResult.fail(explainGoogleWeb(res.error.error, res.error.errorMessage));
    }
    PokerClientIdentity.isGuest = false;
    return AuthResult.ok(PokerClientIdentity.playFabId);
  },

  /** Guest → link Google onto this account. Otherwise → login with Google and bind this device. */
  async continueWithGoogleAsync(): Promise<AuthResult> {
    const { ok, value } = await requestGoogleCredential();
    if (!ok) return AuthResult.fail(value);
    return PlayFabAuth.continueWithGoogleCredentialAsync(value);
  },

  async continueWithGoogleCredentialAsync(credential: string): Promise<AuthResult> {
    if (PlayFabAuth.isSignedIn && PokerClientIdentity.isGuest) {
      const linked = await PlayFabAuth.linkGoogleAsync(credential);
      if (linked.success) return linked;
      if (looksLikeGoogleOwnedElsewhere(linked.error)) {
        const again = await requestGoogleCredential();
        if (!again.ok) return AuthResult.fail(again.value);
        const login = await PlayFabAuth.loginWithGoogleAsync(again.value);
        if (login.success) await tryLinkDeviceAfterGoogle();
        return login;
      }
      if (linked.error) {
        console.warn(`[PlayFabAuth] LinkGoogle failed (${linked.error}); trying LoginWithGoogle.`);
        const login = await PlayFabAuth.loginWithGoogleAsync(credential);
        if (login.success) await tryLinkDeviceAfterGoogle();
        return login;
      }
      return linked;
    }
    const signedIn = await PlayFabAuth.loginWithGoogleAsync(credential);
    if (signedIn.success) await tryLinkDeviceAfterGoogle();
    return signedIn;
  },

  // ---- Account upgrade

  /** Attaches email + password to the account ALREADY signed in (keeps the same PlayFabId and chips). */
  addRecoveryLoginAsync(email: string | null, password: string | null, username: string | null): Promise<AuthResult> {
    if (!PlayFabAuth.isSignedIn) return Promise.resolve(AuthResult.fail('Sign in first.'));
    if (!email || !email.trim()) return Promise.resolve(AuthResult.fail('Enter your email.'));
    if (!password || password.length < 6) return Promise.resolve(AuthResult.fail('Password must be at least 6 characters.'));
    return run('AddUsernamePassword', {
      Email: email.trim(), Password: password, Username: !username || !username.trim() ? suggestUsername() : username.trim(),
    }, () => {
      PokerClientIdentity.isGuest = false;
    });
  },

  /** Binds this device to the signed-in account (ForceLink: the account just proven wins over a throwaway guest). */
  async linkDeviceAsync(): Promise<AuthResult> {
    if (!PlayFabAuth.isSignedIn) return AuthResult.fail('Sign in first.');
    const res = await playFab()!.client('LinkCustomID', { CustomId: PokerClientIdentity.token, ForceLink: true });
    if (res.error) {
      console.warn(`[PlayFabAuth] Browser LinkCustomID failed: ${res.error.error}`);
      return AuthResult.fail(res.error.errorMessage.trim() ? res.error.errorMessage : "Couldn't link this device.");
    }
    return AuthResult.ok(PokerClientIdentity.playFabId);
  },

  // ---- Profile

  setDisplayNameAsync(displayName: string | null): Promise<AuthResult> {
    if (!PlayFabAuth.isSignedIn) return Promise.resolve(AuthResult.fail('Sign in first.'));
    if (!displayName || !displayName.trim()) return Promise.resolve(AuthResult.fail('Enter a name.'));
    const name = displayName.trim();
    return run<{ DisplayName?: string }>('UpdateUserTitleDisplayName', { DisplayName: name }, (r) => applyLocalDisplayName(r.DisplayName ?? name));
  },

  /** Pushes `name` to PlayFab unless it is a placeholder, out of 3–25 chars, or already sent/refused this session. */
  async syncDisplayNameAsync(name: string | null): Promise<void> {
    if (!PlayFabAuth.isSignedIn) return;
    const trimmed = name?.trim();
    if (!trimmed || trimmed === PlaceholderName) return;
    if (PlayFabAuth.isFusionPlaceholderUsername(trimmed)) return;
    if (trimmed.length < MinDisplayName || trimmed.length > MaxDisplayName) return;
    if (trimmed === syncedDisplayName || trimmed === lastDisplayNameAttempt) return;
    lastDisplayNameAttempt = trimmed;
    const result = await PlayFabAuth.setDisplayNameAsync(trimmed);
    if (result.success) syncedDisplayName = trimmed;
  },

  /** The menu's rename: null when the name stands, else the reason to show (the menu keeps the old name). */
  async renameAsync(name: string | null): Promise<string | null> {
    const trimmed = name?.trim();
    if (!trimmed || trimmed.length < MinDisplayName || trimmed.length > MaxDisplayName) {
      return `Names must be ${MinDisplayName}–${MaxDisplayName} characters.`;
    }
    if (sameIgnoreCase(trimmed, PlaceholderName)) return 'Pick a name other than "Player".';
    if (!PlayFabAuth.isSignedIn) {
      PokerClientIdentity.playerName = trimmed;
      return null;
    }
    if (trimmed === syncedDisplayName) return null;
    lastDisplayNameAttempt = trimmed;
    const result = await PlayFabAuth.setDisplayNameAsync(trimmed);
    if (!result.success) return result.error;
    syncedDisplayName = trimmed;
    return null;
  },

  /** Drops the session; keeps the device token (that GUID is the device, not the player). */
  signOut(): void {
    PlayFabAuth.keepMeSignedIn = false;
    playFab()?.forgetAllCredentials();
    PokerClientIdentity.clearPlayFabSession();
    syncedDisplayName = null;
    lastDisplayNameAttempt = null;
  },

  // ---- Saved session (Keep me signed in)

  /** Puts the saved session back into the client. Follow with validateRestoredSessionAsync. */
  tryRestoreSession(): boolean {
    const c = playFab();
    if (!c || PlayFabAuth.isSignedIn || !PlayFabAuth.keepMeSignedIn) return false;
    const json = PlayerPrefs.getString(SavedSessionPref, '');
    if (!json) return false;
    let saved: Partial<SavedSession> | null = null;
    try {
      saved = JSON.parse(json) as Partial<SavedSession>;
    } catch {
      saved = null;
    }
    const usable = !!saved && saved.titleId === PlayFabConfig.TitleId && !!saved.playFabId && !!saved.sessionTicket
      && !!saved.entityToken && typeof saved.expiresUtcTicks === 'number'
      && ticksToMs(saved.expiresUtcTicks) > Date.now() + RestoreMarginMs;
    if (!usable) {
      clearSavedSession();
      return false;
    }
    const s = saved as SavedSession;
    c.adoptContext({ sessionTicket: s.sessionTicket, entityToken: s.entityToken, playFabId: s.playFabId, entityId: s.entityId ?? '', entityType: s.entityType ?? '' });
    sessionExpiresUtc = ticksToMs(s.expiresUtcTicks);
    PokerClientIdentity.setPlayFabSession(s.playFabId, s.sessionTicket);
    return true;
  },

  /** One round trip proving a restored session still works (also refreshes the display name). */
  async validateRestoredSessionAsync(): Promise<AuthResult> {
    const c = playFab();
    if (!c) return AuthResult.fail(Explain('NetworkError'));
    const restored: LoginResult = {
      PlayFabId: c.playFabId,
      SessionTicket: c.sessionTicket,
      EntityToken: { EntityToken: c.entityToken, TokenExpiration: new Date(sessionExpiresUtc).toISOString(), Entity: { Id: c.entityId, Type: c.entityType } },
    };
    const result = await run<{ PlayerProfile?: { DisplayName?: string } }>('GetPlayerProfile', {
      PlayFabId: c.playFabId, ProfileConstraints: { ShowDisplayName: true },
    }, (r) => {
      restored.InfoResultPayload = { PlayerProfile: r.PlayerProfile };
      adoptLogin(restored, true); // not new, so IsGuest stays as the saved account left it
    });
    if (!result.success) {
      clearSavedSession();
      c.forgetAllCredentials();
      PokerClientIdentity.playFabSessionTicket = '';
    }
    return result;
  },

  /** Fusion's SetDefaults invents `Player` + 3 chars when the pref is empty. */
  isFusionPlaceholderUsername(name: string | null | undefined): boolean {
    if (!name || name.length !== 9 || !name.startsWith('Player')) return false;
    for (let i = 6; i < name.length; i++) if (!isLetterOrDigit(name[i]!)) return false;
    return true;
  },

  /**
   * PreferPersistedNameOverFusionPlaceholder + the Fusion menu's username default, run once at boot: the menu
   * username pref is the name this device plays under; a Fusion placeholder is replaced by the durable guest name.
   */
  bootDisplayName(): void {
    let menu = PlayerPrefs.getString(MenuUsernamePref, '');
    if (!menu || PlayFabAuth.isFusionPlaceholderUsername(menu)) {
      let guest = PlayerPrefs.getString('Poker.GuestName', '');
      if (!guest.trim() && PokerClientIdentity.isGuest) guest = PokerClientIdentity.getOrCreateGuestName();
      if (guest.trim() && !PlayFabAuth.isFusionPlaceholderUsername(guest)) {
        PlayerPrefs.setString(MenuUsernamePref, guest);
        menu = guest;
      }
    }
    if (!menu) {
      // FusionMenuConnectArgs.SetDefaults: "Player" + a 3-digit number, saved as the menu username.
      menu = 'Player' + String(100 + Math.floor(Math.random() * 900));
      PlayerPrefs.setString(MenuUsernamePref, menu);
    }
    PokerClientIdentity.playerName = menu;
  },

  /** Exposed for the offline account (same rules as a PlayFab login's ApplyLocalDisplayName). */
  applyLocalDisplayName(name: string | null): void {
    applyLocalDisplayName(name);
  },

  resetForTests(): void {
    sessionExpiresUtc = 0;
    syncedDisplayName = null;
    lastDisplayNameAttempt = null;
  },
};

// ---- Plumbing ---------------------------------------------------------------------------------------------

const accountInfo = () => ({ GetPlayerProfile: true });

function saveSession(): void {
  const c = playFab();
  if (!c || !PlayFabAuth.keepMeSignedIn || !c.isClientLoggedIn() || !c.entityToken) return;
  const saved: SavedSession = {
    titleId: PlayFabConfig.TitleId,
    playFabId: c.playFabId,
    sessionTicket: c.sessionTicket,
    entityToken: c.entityToken,
    entityId: c.entityId,
    entityType: c.entityType,
    expiresUtcTicks: msToTicks(sessionExpiresUtc),
  };
  PlayerPrefs.setString(SavedSessionPref, JSON.stringify(saved));
}

function clearSavedSession(): void {
  if (!PlayerPrefs.hasKey(SavedSessionPref)) return;
  PlayerPrefs.deleteKey(SavedSessionPref);
}

function expiryOf(result: LoginResult): number {
  const t = result.EntityToken?.TokenExpiration;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : Date.now() + DefaultSessionLifetimeMs;
}

function adoptLogin(result: LoginResult, treatNewAsGuest: boolean): void {
  const c = playFab();
  if (c && result.SessionTicket && result.PlayFabId) {
    // The SDK stores the login's context itself before the callback runs.
    c.adoptContext({
      sessionTicket: result.SessionTicket,
      entityToken: result.EntityToken?.EntityToken ?? c.entityToken,
      playFabId: result.PlayFabId,
      entityId: result.EntityToken?.Entity?.Id ?? c.entityId,
      entityType: result.EntityToken?.Entity?.Type ?? c.entityType,
    });
  }
  PokerClientIdentity.setPlayFabSession(result.PlayFabId ?? '', result.SessionTicket ?? '');
  sessionExpiresUtc = expiryOf(result);
  saveSession();

  const newlyCreated = result.NewlyCreated === true;
  const guestLogin = treatNewAsGuest && (newlyCreated || PokerClientIdentity.isGuest);
  if (newlyCreated && treatNewAsGuest) {
    PokerClientIdentity.isGuest = true;
    PokerFunnel.onAccountCreated('device');
  } else if (!treatNewAsGuest) {
    PokerClientIdentity.isGuest = false;
  }

  const profileName = result.InfoResultPayload?.PlayerProfile?.DisplayName ?? null;
  syncedDisplayName = profileName;
  lastDisplayNameAttempt = null;
  const placeholderProfile = sameIgnoreCase(profileName, PlaceholderName);
  const fusionPlaceholderProfile = PlayFabAuth.isFusionPlaceholderUsername(profileName);
  const usableProfileName = !!profileName && profileName.trim().length > 0 && !placeholderProfile && !fusionPlaceholderProfile;

  if (guestLogin) {
    if (usableProfileName) {
      applyLocalDisplayName(profileName);
    } else {
      const guestName = PokerClientIdentity.getOrCreateGuestName();
      if (fusionPlaceholderProfile) syncedDisplayName = null;
      applyLocalDisplayName(guestName);
      void PlayFabAuth.syncDisplayNameAsync(guestName);
    }
  } else if (usableProfileName) {
    applyLocalDisplayName(profileName);
  } else {
    const local = PlayerPrefs.getString(MenuUsernamePref, PokerClientIdentity.playerName);
    if (local.trim() && !PlayFabAuth.isFusionPlaceholderUsername(local) && !sameIgnoreCase(local, PlaceholderName)) applyLocalDisplayName(local);
    void PlayFabAuth.syncDisplayNameAsync(PokerClientIdentity.playerName);
  }
}

/** Keeps PokerClientIdentity.playerName and the Fusion menu username pref in lockstep. */
function applyLocalDisplayName(name: string | null): void {
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  PokerClientIdentity.playerName = trimmed;
  PlayerPrefs.setString(MenuUsernamePref, trimmed);
  console.log(`[PlayFab] Display name set to '${trimmed}'.`);
  PlayFabAuth.displayNameChanged.emit(trimmed);
}

async function tryLinkDeviceAfterGoogle(): Promise<void> {
  try {
    const linked = await PlayFabAuth.linkDeviceAsync();
    if (!linked.success) console.warn(`[PlayFabAuth] LinkDevice after Google skipped: ${linked.error}`);
  } catch (e) {
    console.warn('[PlayFabAuth] LinkDevice after Google threw', e);
  }
}

function splitGoogleCredential(credential: string | null): { accessToken: string | null; serverAuthCode: string | null } | null {
  if (!credential || !credential.trim()) return null;
  const trimmed = credential.trim();
  if (trimmed.startsWith('token:')) {
    const accessToken = trimmed.substring(6).trim();
    return accessToken ? { accessToken, serverAuthCode: null } : null;
  }
  if (trimmed.startsWith('code:')) {
    const serverAuthCode = trimmed.substring(5).trim();
    return serverAuthCode ? { accessToken: null, serverAuthCode } : null;
  }
  return { accessToken: null, serverAuthCode: trimmed };
}

const looksLikeGoogleOwnedElsewhere = (error: string | null): boolean =>
  !!error && (error.toLowerCase().includes('already') || error.toLowerCase().includes('linked'));

function suggestUsername(): string {
  const id = PokerClientIdentity.playFabId;
  const suffix = id ? id.substring(0, Math.min(8, id.length)) : crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  return 'player' + suffix.toLowerCase();
}

/** Bridges one call into an AuthResult (PlayFabAuth.Run). Bookkeeping that throws is logged, not reported. */
async function run<T>(api: string, body: object, onSuccess: ((r: T) => void) | null, auth = true): Promise<AuthResult> {
  const c = playFab();
  if (!c) return AuthResult.fail(Explain('NetworkError'));
  const res: ApiResult<T> = await c.client<T>(api, body, auth);
  if (res.error) {
    console.warn(`[PlayFabAuth] ${api} failed: ${errorReport(res.error)}`);
    return AuthResult.fail(Explain(res.error.error));
  }
  try {
    onSuccess?.(res.data);
  } catch (e) {
    console.error('[PlayFabAuth] Post-login bookkeeping threw', e);
  }
  return AuthResult.ok(PokerClientIdentity.playFabId);
}

/** PlayFabAuth.Explain: a PlayFab error code as something worth showing a player. */
export function Explain(code: PlayFabError['error'] | null): string {
  switch (code) {
    case 'PlayerCreationDisabled':
      return 'New accounts are turned off for this title. Enable player creation for Custom ID in Game Manager → Settings → API Features.';
    case 'InvalidEmailOrPassword':
    case 'AccountNotFound':
      return "That email and password don't match an account.";
    case 'EmailAddressNotAvailable':
      return 'That email is already registered. Sign in instead.';
    case 'UsernameNotAvailable':
      return 'That username is taken.';
    case 'InvalidParams':
    case 'InvalidEmailAddress':
      return "That doesn't look like a valid email address.";
    case 'NameNotAvailable':
      return 'That name is taken — pick another.';
    case 'ProfaneDisplayName':
      return "That name isn't allowed — pick another.";
    case 'AccountAlreadyLinked':
      return 'This account already has Google linked.';
    case 'LinkedAccountAlreadyClaimed':
      return 'That Google account is already tied to another player. Sign in with Google instead.';
    case 'InvalidGoogleToken':
    case 'GoogleOAuthError':
      return 'Google sign-in failed. Try again.';
    case 'GoogleOAuthNotConfiguredForTitle':
    case 'MissingTitleGoogleProperties':
      return 'Google login is not enabled on this PlayFab title. Add the Google add-on in Game Manager.';
    default:
      return "Couldn't reach the server. Check your connection and try again.";
  }
}

/** ExplainGoogleWeb: the browser-path wording (falls back to PlayFab's own message). */
function explainGoogleWeb(code: string | null, message: string | null): string {
  switch (code) {
    case 'AccountAlreadyLinked':
    case 'LinkedAccountAlreadyClaimed':
    case 'InvalidGoogleToken':
    case 'GoogleOAuthError':
    case 'GoogleOAuthNotConfiguredForTitle':
    case 'MissingTitleGoogleProperties':
      return Explain(code);
    default:
      return message && message.trim() ? message : "Couldn't reach the server. Check your connection and try again.";
  }
}
