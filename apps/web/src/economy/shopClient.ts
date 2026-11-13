/**
 * The Shop's client side (Phase 3). The Nomad API owns the catalogue, prices and effects (packages/db/src/shop.ts);
 * this asks for the catalogue, buys with Coins, and pays SOL items with a devnet transfer the API then checks on chain.
 *
 * SOL path: POST /v1/shop/sol/intent → the wallet signs one transaction (a System transfer of the quoted lamports to
 * the treasury + a Memo instruction carrying the intent id) → it's sent to the devnet RPC → POST /v1/shop/sol/confirm
 * with the signature. Devnet only (Web3Config refuses mainnet RPCs).
 */
import {
  ShopRoutes,
  type ShopBuyResponse,
  type ShopCatalogResponse,
  type ShopItemInfo,
  type ShopSolIntentResponse,
} from '@nomad/contract';
import { Buffer } from 'buffer';
import type { AppContext } from '../app/app';
import type { NomadSession } from '../account/session';

export type { ShopItemInfo, ShopCatalogResponse, ShopBuyResponse };

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export class ShopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Set once a SOL payment was sent: the devnet transaction signature. */
    readonly signature?: string,
  ) {
    super(message);
  }
}

/** A SOL payment that was sent but not confirmed by the server yet; retried on the next catalogue load. */
interface PendingSol {
  intentId: string;
  signature: string;
  itemId: string;
  at: number;
}
const PENDING_KEY = 'Nomad.ShopPendingSol';
const readPending = (): PendingSol[] => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as PendingSol[];
    return Array.isArray(v) ? v.filter((p) => Date.now() - p.at < 7 * 86_400_000) : [];
  } catch {
    return [];
  }
};
const writePending = (list: PendingSol[]): void => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the payment still shows on chain */
  }
};
/** Wait before trying the catalogue again after a failure (e.g. a server without the shop). */
const RETRY_AFTER_MS = 45_000;

function asShopError(e: unknown): ShopError {
  if (e instanceof ShopError) return e;
  const err = e as { code?: string; message?: string };
  return new ShopError(err?.code ?? 'internal', err?.message ?? String(e));
}

const newRequestId = (): string => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'web-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export class ShopClient {
  catalog: ShopCatalogResponse | null = null;

  private failedAt = 0;

  constructor(private readonly ctx: AppContext) {
    // Another player signed in (or out): their items and boost are not this one's; try the catalogue afresh.
    ctx.events.on('nomad:changed', () => {
      this.catalog = null;
      this.failedAt = 0;
    });
  }

  /** Whether this build talks to a Nomad server at all (else the Shop can only be browsed). */
  get hasServer(): boolean {
    return !!this.session;
  }

  private get session(): NomadSession | null {
    return (this.ctx.services as unknown as { nomadApi?: NomadSession | null }).nomadApi ?? null;
  }

  /** Purchases need the Nomad server and a signed-in player. */
  get online(): boolean {
    return !!this.session?.signedIn;
  }

  private loading: Promise<ShopCatalogResponse | null> | null = null;

  /**
   * Loads the catalogue once it can (the session may still be restoring when the Shop opens), one request at a time,
   * and not again for a while after a failure. Calls `then` when a load finishes. `force` reloads a loaded catalogue.
   */
  ensure(then: () => void, force = false): void {
    if (this.loading || !this.session?.signedIn) return;
    if (this.catalog && !force) return;
    if (!this.catalog && this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_MS) return;
    this.loading = this.load().finally(() => {
      this.loading = null;
      then();
    });
  }

  private async load(): Promise<ShopCatalogResponse | null> {
    const s = this.session;
    if (!s?.signedIn) return null;
    try {
      this.catalog = await s.call<ShopCatalogResponse>('GET', ShopRoutes.catalog);
      this.failedAt = 0;
      void this.resumePending();
    } catch (e) {
      this.failedAt = Date.now();
      console.warn('[shop] catalogue failed', e);
    }
    return this.catalog;
  }

  /** Re-confirms SOL payments that were sent but not credited yet (the server credits a signature once). */
  private async resumePending(): Promise<void> {
    const s = this.session;
    const list = readPending();
    if (!s?.signedIn || list.length === 0) return;
    const left: PendingSol[] = [];
    for (const p of list) {
      try {
        const r = this.adopt(await s.call<ShopBuyResponse>('POST', ShopRoutes.solConfirm, { intentId: p.intentId, signature: p.signature }));
        this.ctx.events.emit('shop:credited', { itemId: r.itemId });
      } catch (e) {
        // Keep it for later unless the server says it can never be credited (unknown purchase / another player).
        if ((e as { status?: number }).status !== 404) left.push(p);
      }
    }
    writePending(left);
  }

  owns(itemId: string): boolean {
    return !!this.catalog?.owned.includes(itemId);
  }

  private adopt(r: ShopBuyResponse): ShopBuyResponse {
    if (this.catalog) this.catalog = { ...this.catalog, owned: r.owned, xpBoostUntil: r.xpBoostUntil };
    // Balances and items: the progress snapshot is the wallet's source; refresh it so every screen updates.
    void (this.ctx.services as unknown as { nomadProgress?: { refresh(): Promise<void> } }).nomadProgress?.refresh();
    this.ctx.events.emit('wallet:changed');
    return r;
  }

  async buyWithCoins(itemId: string): Promise<ShopBuyResponse> {
    const s = this.session;
    if (!s?.signedIn) throw new ShopError('offline', 'The Shop needs the online server.');
    const requestId = newRequestId();
    try {
      return this.adopt(await s.call<ShopBuyResponse>('POST', ShopRoutes.buy, { itemId, requestId }));
    } catch (e) {
      // One retry with the same id on a network error: it can't charge twice.
      if (!(e as { status?: number }).status) {
        try {
          return this.adopt(await s.call<ShopBuyResponse>('POST', ShopRoutes.buy, { itemId, requestId }));
        } catch (e2) {
          throw asShopError(e2);
        }
      }
      throw asShopError(e);
    }
  }

  /** Pays a SOL item from the connected wallet (devnet). `status` reports each step for the UI. */
  async buyWithSol(itemId: string, status: (text: string) => void): Promise<ShopBuyResponse> {
    const s = this.session;
    if (!s?.signedIn) throw new ShopError('offline', 'The Shop needs the online server.');
    const solana = this.ctx.services.solana;
    const rpcUrl = this.ctx.services.web3Config?.solanaRpcUrl;
    if (!solana || !rpcUrl) throw new ShopError('not_configured', 'SOL purchases are unavailable in this build.');
    if (!solana.isConnected && !(await solana.connect())) throw new ShopError('no_wallet', 'Connect a Solana wallet (devnet) to pay with SOL.');
    const payer = solana.address!;
    let intent: ShopSolIntentResponse;
    try {
      status('Getting a price…');
      intent = await s.call<ShopSolIntentResponse>('POST', ShopRoutes.solIntent, { itemId });
    } catch (e) {
      throw asShopError(e);
    }
    status('Approve the payment in your wallet…');
    const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = await import('@solana/web3.js');
    const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await res.json()) as { result?: T; error?: { message?: string } };
      if (j.error) throw new ShopError('rpc', j.error.message ?? 'The Solana network refused the payment.');
      return j.result as T;
    };
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const from = new PublicKey(payer);
    const tx = new Transaction({ feePayer: from, recentBlockhash: value.blockhash })
      .add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(intent.treasury), lamports: intent.lamports }))
      .add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(intent.memo, 'utf8') }));
    let signed: Uint8Array;
    try {
      signed = await solana.signTransactionBytes(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    } catch {
      throw new ShopError('declined', "Your wallet didn't approve the payment. Nothing was charged.");
    }
    status('Sending…');
    const b64 = btoa(String.fromCharCode(...signed));
    // Up to here nothing has left the wallet; a failure here is the network refusing the transaction.
    const sig = await rpc<string>('sendTransaction', [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    // From here the payment may be on chain: remember it, so a later visit can still credit it.
    writePending([...readPending().filter((p) => p.signature !== sig), { intentId: intent.intentId, signature: sig, itemId, at: Date.now() }]);
    const forget = () => writePending(readPending().filter((p) => p.signature !== sig));
    try {
      status('Waiting for the network…');
      for (let i = 0; i < 40; i++) {
        const st = await rpc<{ value: ({ confirmationStatus?: string; err?: unknown } | null)[] }>('getSignatureStatuses', [[sig]]);
        const v = st.value[0];
        if (v?.err) {
          forget();
          throw new ShopError('failed', 'The payment failed on the network, so only the small network fee left your wallet.', sig);
        }
        if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      status('Checking the payment…');
      for (let attempt = 0; ; attempt++) {
        try {
          const r = this.adopt(await s.call<ShopBuyResponse>('POST', ShopRoutes.solConfirm, { intentId: intent.intentId, signature: sig }));
          forget();
          return r;
        } catch (e) {
          const err = asShopError(e);
          // The RPC may lag a moment behind confirmation: try again a few times.
          if (attempt < 4 && /isn't confirmed yet/.test(err.message)) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw err;
        }
      }
    } catch (e) {
      const err = asShopError(e);
      if (err.code === 'failed') throw err;
      // Sent, but not confirmed yet (network lag, a server hiccup): it stays pending and is retried on the next visit.
      console.warn('[shop] SOL payment sent but not confirmed yet', sig, err);
      throw new ShopError('unconfirmed', "Payment sent, but we couldn't confirm it yet. It will appear in your items shortly.", sig);
    }
  }
}

let client: ShopClient | null = null;
export function shopClient(ctx: AppContext): ShopClient {
  return (client ??= new ShopClient(ctx));
}
