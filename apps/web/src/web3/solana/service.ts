/**
 * `ctx.services.solana`: the wallet the whole game shares. Ports of
 *  - Per/Unity/PerPlatform.cs PerWallet (connect / disconnect / sign, Address, IsConnected),
 *  - Auth/WalletAdapterPopup.cs (the picker; remembers the chosen wallet; silent reconnect of a remembered one),
 *  - Auth/SolanaWeb3Persist.cs (the wallet lives in this service for the whole page, across screens),
 *  - Auth/Web3SleepGate.cs + Net/Chain/Web3Capability.cs + Web3FeatureGate.cs (Solana stays asleep until the player
 *    asks for something on chain: nothing is listed or connected at boot),
 *  - Auth/WalletAuthService.cs (SIWS against the game backend) as `solana.auth`.
 * Emits 'web3:wallet-changed' on the app bus.
 */
import type { EventBus } from '../../app/app';
import type { Web3Config } from '../config';
import type { PerHttp } from '../lib/http';
import { WalletAuthService } from './auth';
import { ChainTableMode, PokerClientIdentity } from './identity';
import { listWallets, onWalletsChanged, startWalletRegistry, type BrowserWallet } from './wallets';

/** Shows the wallet list and resolves with the player's pick (null = closed). Set by the UI (wallet-picker). */
export type WalletPicker = (wallets: BrowserWallet[]) => Promise<BrowserWallet | null>;

/** Web3Capability: compile-time + runtime gate for Solana / money tables. */
export class Web3Capability {
  private menuWeb3Override: boolean | null = null;
  /** Private tables need the wallet without turning on the ONCHAIN lobby. */
  privateTables = false;
  private awake = false;
  constructor(private readonly web2Only: boolean) {}
  get compiledIn(): boolean {
    return !this.web2Only;
  }
  /** True when Connect Wallet + DEMO/ONCHAIN should appear. */
  get menuWeb3Enabled(): boolean {
    return this.compiledIn && (this.menuWeb3Override ?? true);
  }
  /** Solana objects should exist and run — player is in the on-chain lobby (Web3SleepGate). */
  get shouldInitialize(): boolean {
    return this.menuWeb3Enabled && (ChainTableMode.chainLobby || this.privateTables);
  }
  get isAwake(): boolean {
    return this.awake;
  }
  setMenuWeb3Enabled(enabled: boolean): void {
    this.menuWeb3Override = enabled;
    if (!enabled) ChainTableMode.chainLobby = false;
  }
  /** Turn Solana on so wallet login / buy-in can run (Web3.AllowBoot + activate the SolanaWeb3 object). */
  wake(): void {
    if (!this.compiledIn) return;
    if (!this.awake) startWalletRegistry();
    this.awake = true;
  }
  /** Web3Capability.ApplyMenuChrome: what the menu should show. */
  menuChrome(chainLobby: boolean, awaitingWallet: boolean): { showToggle: boolean; showWallet: boolean } {
    return { showToggle: this.menuWeb3Enabled, showWallet: this.menuWeb3Enabled && (chainLobby || awaitingWallet) };
  }
}

/** How long a silent reconnect waits (WalletAdapterPopup.SilentTimeoutSeconds). */
const SILENT_TIMEOUT_MS = 15_000;

export class SolanaService {
  readonly capability: Web3Capability;
  readonly auth: WalletAuthService;
  /** Set by the UI module; without one, a single available wallet is used and several are refused. */
  picker: WalletPicker | null = null;
  private wallet: BrowserWallet | null = null;
  private connecting: Promise<boolean> | null = null;

  constructor(
    readonly config: Web3Config,
    private readonly http: PerHttp,
    private readonly events: EventBus,
  ) {
    this.capability = new Web3Capability(config.web2Only);
    const self = this;
    this.auth = new WalletAuthService(http, () => config.gameBackendUrl, {
      ensureConnected: async () => ((await self.connect()) ? self.address : null),
      reconnectSilently: async () => ((await self.reconnectRemembered()) ? self.address : null),
      get address() {
        return self.address;
      },
      signMessage: (m) => self.signMessage(m),
      logout: () => self.disconnect(),
    });
  }

  /** The connected wallet's base58 address (PerWallet.Address). */
  get address(): string | null {
    return this.wallet?.address ?? null;
  }
  get isConnected(): boolean {
    return this.address !== null;
  }
  get walletName(): string | null {
    return this.wallet?.name ?? null;
  }
  /** WalletLoginUI.IsWalletReady: signed in to the game backend AND holding a wallet that can sign. */
  get isWalletReady(): boolean {
    return PokerClientIdentity.isLoggedIn && this.isConnected;
  }

  /** Wallets the browser offers (wakes Solana first: listing is the first thing that needs it). */
  wallets(): BrowserWallet[] {
    this.capability.wake();
    return listWallets();
  }

  onWalletsChanged(fn: () => void): () => void {
    return onWalletsChanged(fn);
  }

  /**
   * PerWallet.ConnectAsync / WalletAdapterPopup.ConnectAsync: shows the picker (unless `walletName` answers it) and
   * connects the chosen wallet. Resolves false when the player closes the picker or the wallet declines.
   */
  /**
   * `onPicked` runs once the player has chosen a wallet, just before that wallet's own prompt: the moment for a
   * "approve it in your wallet" message (shown earlier, it covered the wallet picker; staging, 9 Nov).
   */
  connect(walletName?: string, opts: { onPicked?: () => void } = {}): Promise<boolean> {
    if (this.isConnected) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce(walletName, opts.onPicked).finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connectOnce(walletName?: string, onPicked?: () => void): Promise<boolean> {
    // Private tables ask without ONCHAIN (Web3Capability.PrivateTables + Wake).
    this.capability.privateTables = true;
    this.capability.wake();
    const list = await this.waitForWallets();
    let pick: BrowserWallet | null = walletName ? (list.find((w) => w.name === walletName) ?? null) : null;
    if (!pick) {
      if (list.length === 0) {
        // The picker shows the empty state (install links); the error is then marked as already shown.
        const err = new Error('No Solana wallet found in this browser. Install Phantom or Solflare, then reload.') as Error & { shown?: boolean };
        if (this.picker) {
          await this.picker([]);
          err.shown = true;
        }
        throw err;
      }
      pick = this.picker ? await this.picker(list) : list.length === 1 ? list[0]! : null;
      if (!pick) return false; // closed by the player: a cancel, not a failure
    }
    onPicked?.();
    const address = await pick.connect(false); // a rejected connect surfaces as an exception for the caller
    if (!address) return false;
    this.wallet = pick;
    PokerClientIdentity.walletProvider = pick.name; // remembered for a reloaded tab (RememberSelection)
    this.events.emit('web3:wallet-changed', address);
    return true;
  }

  /**
   * WalletAuthService.ReconnectWalletAsync: reconnects the wallet behind a saved session, silently or not at all.
   * Never opens the picker. Only call from an explicit flow (the porting rules: nothing on chain at boot).
   */
  async reconnectRemembered(): Promise<boolean> {
    if (this.isConnected) return true;
    const name = PokerClientIdentity.walletProvider;
    if (!name) return false;
    this.capability.wake();
    const w = (await this.waitForWallets()).find((x) => x.name === name);
    if (!w) return false;
    try {
      const address = await withTimeout(w.connect(true), SILENT_TIMEOUT_MS);
      if (!address) return false;
      this.wallet = w;
      this.events.emit('web3:wallet-changed', address);
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets the connected wallet (PerWallet.Disconnect). The game balance stays on chain. */
  async disconnect(): Promise<void> {
    const w = this.wallet;
    this.wallet = null;
    try {
      await w?.disconnect();
    } catch (e) {
      console.warn('[PerWallet] logout:', (e as Error).message);
    }
    this.events.emit('web3:wallet-changed', null);
  }

  /** The wallet signs a plain message (Phantom's "Sign message": no transaction, no preview). */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.wallet) throw new Error('no wallet connected');
    return this.wallet.signMessage(message);
  }

  /** The wallet signs a serialized transaction (it shows the player what they're signing). */
  async signTransactionBytes(tx: Uint8Array): Promise<Uint8Array> {
    if (!this.wallet) throw new Error('no wallet connected');
    return this.wallet.signTransaction(tx);
  }

  /** A few frames of patience: extensions register right after load (WalletLoginUI.WaitForWeb3Async). */
  private async waitForWallets(): Promise<BrowserWallet[]> {
    let list = listWallets();
    for (let i = 0; i < 10 && list.length === 0; i++) {
      await this.http.delay(100);
      list = listWallets();
    }
    return list;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
