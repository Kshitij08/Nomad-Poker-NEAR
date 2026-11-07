/**
 * Who this client claims to be on the wallet side, in the same PlayerPrefs keys as Net/PokerClientIdentity.cs
 * (only the wallet half: the PlayFab half belongs to the net/economy modules), plus the money-lobby preference of
 * Net/Chain/ChainTableMode.cs and the Nomad menu's DEMO/ONCHAIN mode (NomadUiHost.Onchain.cs ModePref).
 */
import { PlayerPrefs } from '../../app/services';

const WALLET_PREF = 'Poker.WalletPubkey';
const SESSION_PREF = 'Poker.SessionJwt';
const PROVIDER_PREF = 'Poker.WalletProvider';
const EMAIL_PROMPT_PREF = 'Poker.EmailPromptDismissed';
const CHAIN_LOBBY_PREF = 'Poker.ChainLobby';
const NOMAD_MODE_PREF = 'Nomad.PlayMode';

const setOrDelete = (key: string, value: string) => (value ? PlayerPrefs.setString(key, value) : PlayerPrefs.deleteKey(key));

export const PokerClientIdentity = {
  get walletPubkey(): string {
    return PlayerPrefs.getString(WALLET_PREF, '');
  },
  set walletPubkey(v: string) {
    setOrDelete(WALLET_PREF, v);
  },
  get sessionToken(): string {
    return PlayerPrefs.getString(SESSION_PREF, '');
  },
  set sessionToken(v: string) {
    setOrDelete(SESSION_PREF, v);
  },
  /** Which browser wallet the player last connected with ("Phantom", "Solflare"…). */
  get walletProvider(): string {
    return PlayerPrefs.getString(PROVIDER_PREF, '');
  },
  set walletProvider(v: string) {
    setOrDelete(PROVIDER_PREF, v);
  },
  get isLoggedIn(): boolean {
    return !!this.walletPubkey && !!this.sessionToken;
  },
  get emailPromptDismissed(): boolean {
    return PlayerPrefs.getInt(EMAIL_PROMPT_PREF, 0) === 1;
  },
  set emailPromptDismissed(v: boolean) {
    PlayerPrefs.setInt(EMAIL_PROMPT_PREF, v ? 1 : 0);
  },
  /** The player's display name (PokerClientIdentity.PlayerName); the account service owns it in the web port. */
  get playerName(): string {
    return PlayerPrefs.getString('poker.playerName', 'Player');
  },
  setWalletSession(pubkey: string, jwt: string): void {
    this.walletPubkey = pubkey ?? '';
    this.sessionToken = jwt ?? '';
  },
  /** `forgetProvider` for a deliberate logout (the next launch must not reconnect the wallet on its own). */
  clearWalletSession(forgetProvider = false): void {
    this.walletPubkey = '';
    this.sessionToken = '';
    if (forgetProvider) this.walletProvider = '';
  },
};

/** ChainTableMode: the persisted money-lobby choice and the devnet table economy constants. */
export const ChainTableMode = {
  LOBBY_NAME: 'poker',
  MODE_PROPERTY: 'mode',
  MODE_CHAIN: 'chain',
  MODE_FREE: 'free',
  DEDICATED_SESSION_NAME: 'poker-money',
  DEDICATED_FREE_SESSION_NAME: 'poker-free',
  DEDICATED_REGION: 'in',
  STAKE_PROPERTY: 'stake',
  HOST_PROPERTY: 'host',
  HOST_DEDICATED: 'dedi',
  KIND_PROPERTY: 'kind',
  KIND_QUICK: 'quick',
  KIND_PRIVATE: 'private',
  PRIVATE_MIN_BUY_IN: 500,
  PRIVATE_MAX_BUY_IN: 1000,
  PRIVATE_SMALL_BLIND: 5,
  PRIVATE_BIG_BLIND: 10,
  /** 0.1 SOL = 1000 chips; blinds double as the engine's blinds. */
  BUY_IN_LAMPORTS: 100_000_000n,
  SMALL_BLIND_CHIPS: 10n,
  BIG_BLIND_CHIPS: 20n,
  get chainLobby(): boolean {
    return PlayerPrefs.getInt(CHAIN_LOBBY_PREF, 0) !== 0;
  },
  set chainLobby(v: boolean) {
    PlayerPrefs.setInt(CHAIN_LOBBY_PREF, v ? 1 : 0);
  },
  get modeValue(): string {
    return this.chainLobby ? this.MODE_CHAIN : this.MODE_FREE;
  },
  /** Snap a requested private buy-in into 500–1,000. An empty request sits at the top. */
  clampPrivateBuyIn(requested: number): number {
    if (requested <= 0 || requested > this.PRIVATE_MAX_BUY_IN) return this.PRIVATE_MAX_BUY_IN;
    if (requested < this.PRIVATE_MIN_BUY_IN) return this.PRIVATE_MIN_BUY_IN;
    return requested;
  },
};

/** NomadUiHost.Onchain `Onchain`: the Nomad menu's DEMO (Coins) / ONCHAIN (private SOL tables) switch. */
export const NomadPlayMode = {
  get onchain(): boolean {
    return PlayerPrefs.getInt(NOMAD_MODE_PREF, 0) === 1;
  },
  set onchain(v: boolean) {
    PlayerPrefs.setInt(NOMAD_MODE_PREF, v ? 1 : 0);
  },
};
