/**
 * The PlayFab + device half of Net/PokerClientIdentity.cs ("who this client claims to be"), with the same
 * PlayerPrefs keys. The wallet half (WalletPubkey / SessionJwt) belongs to the web3 module; `walletPubkey` here
 * only reads/writes the same key so both agree.
 *
 * Exported for other modules (net, menu): read identity from here instead of keeping a second copy.
 */
import { PlayerPrefs } from '../app/services';
import { Signal } from './signal';

const TokenPref = 'Poker.ClientToken';
const WalletPref = 'Poker.WalletPubkey';
const SessionPref = 'Poker.SessionJwt';
const PlayFabIdPref = 'Poker.PlayFabId';
const GuestPref = 'Poker.IsGuest';
const GuestNamePref = 'Poker.GuestName';
/** Where the Fusion menu keeps its username (FusionMenuConnectArgs.Username); PlayFabAuth keeps it in lockstep. */
export const MenuUsernamePref = 'Photon.Menu.Username';

const GuestAdjectives = ['Lucky', 'Swift', 'Bold', 'Calm', 'Clever', 'Sunny', 'Royal', 'Brave', 'Merry', 'Nimble', 'Silver', 'Golden'];
const GuestNouns = ['Falcon', 'Fox', 'Panda', 'Tiger', 'Otter', 'Raven', 'Wolf', 'Lynx', 'Shark', 'Eagle', 'Cobra', 'Badger'];

function guidN(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

let token: string | null = null;
let playerName = 'Player';
let sessionTicket = '';

export const PokerClientIdentity = {
  /** Raised when PlayerName, the PlayFab session or IsGuest changes. */
  changed: new Signal(),

  get playerName(): string {
    return playerName;
  },
  set playerName(v: string) {
    if (v === playerName) return;
    playerName = v;
    PokerClientIdentity.changed.emit();
  },

  /** Stable random guest name (adjective + noun + 6 digits), generated once per device. */
  getOrCreateGuestName(): string {
    const saved = PlayerPrefs.getString(GuestNamePref, '');
    if (saved.trim().length > 0) return saved;
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const adjective = GuestAdjectives[random[0]! % GuestAdjectives.length]!;
    const noun = GuestNouns[random[1]! % GuestNouns.length]!;
    const u32 = (random[2]! | (random[3]! << 8) | (random[4]! << 16) | (random[5]! << 24)) >>> 0;
    const generated = `${adjective}${noun}${String(u32 % 1_000_000).padStart(6, '0')}`;
    PlayerPrefs.setString(GuestNamePref, generated);
    return generated;
  },

  /** The device GUID ("N" format): the PlayFab CustomID this device signs in with. Never regenerated. */
  get token(): string {
    if (!token) {
      token = PlayerPrefs.getString(TokenPref, '');
      if (!token) {
        token = guidN();
        PlayerPrefs.setString(TokenPref, token);
      }
    }
    return token;
  },

  get walletPubkey(): string {
    return PlayerPrefs.getString(WalletPref, '');
  },
  get sessionToken(): string {
    return PlayerPrefs.getString(SessionPref, '');
  },
  /** Wallet signed in (the chain code's IsLoggedIn). */
  get isLoggedIn(): boolean {
    return PokerClientIdentity.walletPubkey.length > 0 && PokerClientIdentity.sessionToken.length > 0;
  },

  /** Who PlayFab says this player is (persisted, not proof of anything). */
  get playFabId(): string {
    return PlayerPrefs.getString(PlayFabIdPref, '');
  },
  set playFabId(v: string) {
    if (!v) PlayerPrefs.deleteKey(PlayFabIdPref);
    else PlayerPrefs.setString(PlayFabIdPref, v);
  },

  /** This session's ticket. Not persisted here (PlayFabAuth saves the whole session under Keep me signed in). */
  get playFabSessionTicket(): string {
    return sessionTicket;
  },
  set playFabSessionTicket(v: string) {
    sessionTicket = v ?? '';
  },

  get isGuest(): boolean {
    return PlayerPrefs.getInt(GuestPref, 0) === 1;
  },
  set isGuest(v: boolean) {
    PlayerPrefs.setInt(GuestPref, v ? 1 : 0);
    PokerClientIdentity.changed.emit();
  },

  get isPlayFabSignedIn(): boolean {
    return PokerClientIdentity.playFabId.length > 0 && sessionTicket.length > 0;
  },

  setPlayFabSession(playFabId: string | null, ticket: string | null): void {
    PokerClientIdentity.playFabId = playFabId ?? '';
    sessionTicket = ticket ?? '';
    PokerClientIdentity.changed.emit();
  },

  /** Drops the PlayFab session. Keeps the device token (regenerating it would orphan a guest account). */
  clearPlayFabSession(): void {
    PokerClientIdentity.playFabId = '';
    sessionTicket = '';
    PlayerPrefs.setInt(GuestPref, 0);
    PokerClientIdentity.changed.emit();
  },

  /** Test hook: forget in-memory state (token cache, name, ticket). */
  resetForTests(): void {
    token = null;
    playerName = 'Player';
    sessionTicket = '';
  },
};
