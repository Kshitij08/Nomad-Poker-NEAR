/**
 * Browser wallets: the web replacement for the Solana Unity SDK's wallet adapter (Auth/WalletAdapterPopup.cs and
 * SolanaWalletAdapterWebGL). Lists the wallets the browser actually has through the Wallet Standard
 * (Phantom, Solflare, Backpack… register themselves) and, for older extensions, the injected `window.phantom.solana`
 * / `window.solana` provider. No dependencies and no network: this file stays in the light boot chunk.
 *
 * Every wallet is reduced to one shape: connect (optionally silent), disconnect, signMessage(bytes) and
 * signTransaction(serialized bytes) → signed bytes. Callers (PerWallet, WalletAuthService) build the transaction.
 */

export interface BrowserWallet {
  readonly name: string;
  readonly icon: string;
  /** Base58 address once connected. */
  readonly address: string | null;
  /** `silent`: reconnect a wallet that already trusts this site, never showing a prompt (eager connect). */
  connect(silent?: boolean): Promise<string | null>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Signs a serialized (legacy) transaction, returning the signed serialization. */
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
}

// ---- Wallet Standard (https://github.com/wallet-standard/wallet-standard), minimal app-side registry.

interface StdAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}
interface StdWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StdAccount[];
  features: Record<string, any>;
}

const registered: StdWallet[] = [];
const changeListeners = new Set<() => void>();
let registryStarted = false;

/** Starts listening for wallets (the wallet-standard app-ready handshake). Safe to call repeatedly. */
export function startWalletRegistry(): void {
  if (registryStarted || typeof window === 'undefined') return;
  registryStarted = true;
  const api = Object.freeze({
    register: (...wallets: StdWallet[]) => {
      for (const w of wallets) if (!registered.includes(w)) registered.push(w);
      for (const fn of changeListeners) fn();
      return () => {
        for (const w of wallets) {
          const i = registered.indexOf(w);
          if (i >= 0) registered.splice(i, 1);
        }
      };
    },
  });
  window.addEventListener('wallet-standard:register-wallet', ((e: CustomEvent<(api: unknown) => void>) => e.detail(api)) as EventListener);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {
    /* ignore */
  }
}

export function onWalletsChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

const SOLANA_DEVNET = 'solana:devnet';
const isSolana = (w: StdWallet) =>
  w.chains.some((c) => c.startsWith('solana:')) && !!w.features['standard:connect'] && !!w.features['solana:signTransaction'];

class StandardWallet implements BrowserWallet {
  private account: StdAccount | null = null;
  constructor(private readonly w: StdWallet) {}
  get name() {
    return this.w.name;
  }
  get icon() {
    return this.w.icon;
  }
  get address() {
    return this.account?.address ?? null;
  }
  async connect(silent = false): Promise<string | null> {
    const r = await this.w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
    const accounts: readonly StdAccount[] = r?.accounts ?? this.w.accounts;
    this.account = accounts[0] ?? null;
    return this.address;
  }
  async disconnect(): Promise<void> {
    this.account = null;
    await this.w.features['standard:disconnect']?.disconnect();
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const f = this.w.features['solana:signMessage'];
    if (!f || !this.account) throw new Error('this wallet cannot sign messages');
    const [out] = await f.signMessage({ account: this.account, message });
    return out.signature;
  }
  async signTransaction(tx: Uint8Array): Promise<Uint8Array> {
    if (!this.account) throw new Error('wallet not connected');
    const [out] = await this.w.features['solana:signTransaction'].signTransaction({ account: this.account, transaction: tx, chain: SOLANA_DEVNET });
    return out.signedTransaction;
  }
}

// ---- Injected provider (Phantom's legacy window.solana API).

interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: string): Promise<{ signature: Uint8Array }>;
  signTransaction(tx: unknown): Promise<{ serialize(opts?: unknown): Uint8Array }>;
}

class InjectedWallet implements BrowserWallet {
  private addr: string | null = null;
  constructor(private readonly p: InjectedProvider, readonly name: string) {}
  readonly icon = '';
  get address() {
    return this.addr;
  }
  async connect(silent = false): Promise<string | null> {
    const r = await this.p.connect(silent ? { onlyIfTrusted: true } : undefined);
    this.addr = r.publicKey.toString();
    return this.addr;
  }
  async disconnect(): Promise<void> {
    this.addr = null;
    await this.p.disconnect();
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return (await this.p.signMessage(message, 'utf8')).signature;
  }
  async signTransaction(tx: Uint8Array): Promise<Uint8Array> {
    // The legacy API wants a web3.js Transaction: only loaded here, on a signing action.
    const { Transaction } = await import('@solana/web3.js');
    const signed = await this.p.signTransaction(Transaction.from(tx));
    return signed.serialize({ requireAllSignatures: false });
  }
}

/** Every wallet the browser offers right now (Wallet Standard first, then a legacy injected Phantom). */
export function listWallets(): BrowserWallet[] {
  startWalletRegistry();
  const list: BrowserWallet[] = registered.filter(isSolana).map((w) => new StandardWallet(w));
  const g = globalThis as unknown as { phantom?: { solana?: InjectedProvider }; solana?: InjectedProvider };
  const injected = g.phantom?.solana ?? g.solana;
  if (injected && !list.some((w) => w.name === 'Phantom')) list.push(new InjectedWallet(injected, injected.isPhantom ? 'Phantom' : 'Injected wallet'));
  return list;
}
