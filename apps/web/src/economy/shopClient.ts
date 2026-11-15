/**
 * The Shop's client side (Phase 3). The Nomad API owns the catalogue, prices and effects (packages/db/src/shop.ts);
 * this asks for the catalogue and buys with Coins.
 */
import {
  ShopRoutes,
  type ShopBuyResponse,
  type ShopCatalogResponse,
  type ShopItemInfo,
} from '@nomad/contract';
import type { AppContext } from '../app/app';
import type { NomadSession } from '../account/session';

export type { ShopItemInfo, ShopCatalogResponse, ShopBuyResponse };

export class ShopError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
    } catch (e) {
      this.failedAt = Date.now();
      console.warn('[shop] catalogue failed', e);
    }
    return this.catalog;
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

}

let client: ShopClient | null = null;
export function shopClient(ctx: AppContext): ShopClient {
  return (client ??= new ShopClient(ctx));
}
