import { createHash } from "node:crypto";

/**
 * The backend's PlayFab access, for tournaments: who a session ticket belongs to, and moving chips
 * (the Economy v2 currency with friendly id CH) in and out of a player's inventory.
 *
 * Chips move with the title's secret key, never the player's — players cannot write their own
 * inventory on this title (scripts/playfab-economy-v2.py probe). Every move carries an IdempotencyId
 * derived from our own money_moves key, so a retry after a timeout or a crash moves the chips once.
 *
 * PLAYFAB_FAKE=1 swaps in an in-memory wallet for tests and local runs. Session tickets are then
 * "fake:<playFabId>" or "fake:<playFabId>:<display name>".
 */

export const CURRENCY_FRIENDLY_ID = "CH";

export interface PlayFabIdentity {
  playFabId: string;
  titlePlayerAccountId: string;
  displayName: string | null;
}

export class PlayFabError extends Error {
  constructor(
    message: string,
    /** PlayFab's error name, e.g. "InsufficientFunds", or "Network" / "Timeout". */
    readonly code: string,
    /** True when retrying the same call cannot succeed (bad ticket, not enough chips). */
    readonly final: boolean
  ) {
    super(message);
  }
}

export interface PlayFabEconomy {
  authenticateSessionTicket(sessionTicket: string): Promise<PlayFabIdentity>;
  addChips(titlePlayerAccountId: string, amount: number, idempotencyId: string): Promise<void>;
  subtractChips(titlePlayerAccountId: string, amount: number, idempotencyId: string): Promise<void>;
}

/** A GUID-shaped id from our money key. PlayFab dedupes on it; the same key always maps to the same id. */
export function idempotencyIdFor(key: string): string {
  const hex = createHash("sha256").update(`x2c-tournaments|${key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Whichever PlayFab this process should use, or null when it has no credentials. */
export function createPlayFabFromEnv(): PlayFabEconomy | null {
  if (process.env.PLAYFAB_FAKE === "1") return new FakePlayFab();
  const titleId = process.env.PLAYFAB_TITLE_ID?.trim();
  const secretKey = process.env.PLAYFAB_SECRET_KEY?.trim();
  if (!titleId || !secretKey) return null;
  return new PlayFabClient(titleId, secretKey);
}

// Errors worth retrying: PlayFab is busy or briefly unavailable. Anything else from PlayFab is an
// answer, not a failure — a bad ticket stays bad and a short balance stays short.
const TRANSIENT_CODES = new Set([
  "APIRequestsThrottled",
  "APIConcurrentRequestLimitExceeded",
  "ServiceUnavailable",
  "InternalServerError",
  "DownstreamServiceUnavailable",
  "Network",
  "Timeout",
  "ConcurrentEditError",
]);

export class PlayFabClient implements PlayFabEconomy {
  private readonly base: string;
  private entityToken: { token: string; expiresAt: number } | null = null;
  private currencyId: string | null = null;

  constructor(
    private readonly titleId: string,
    private readonly secretKey: string,
    private readonly timeoutMs = 10_000
  ) {
    this.base = `https://${titleId}.playfabapi.com`;
  }

  async authenticateSessionTicket(sessionTicket: string): Promise<PlayFabIdentity> {
    const data = await this.call("/Server/AuthenticateSessionTicket", { SessionTicket: sessionTicket }, "secret");
    if (data?.IsSessionTicketExpired) {
      throw new PlayFabError("Session ticket has expired", "SessionTicketExpired", true);
    }
    const user = data?.UserInfo;
    const playFabId = user?.PlayFabId;
    const tpa = user?.TitleInfo?.TitlePlayerAccount?.Id;
    if (!playFabId || !tpa) {
      throw new PlayFabError("PlayFab returned no player for this ticket", "InvalidSessionTicket", true);
    }
    return { playFabId, titlePlayerAccountId: tpa, displayName: user?.TitleInfo?.DisplayName ?? null };
  }

  addChips(titlePlayerAccountId: string, amount: number, idempotencyId: string): Promise<void> {
    return this.move("/Inventory/AddInventoryItems", titlePlayerAccountId, amount, idempotencyId, {});
  }

  subtractChips(titlePlayerAccountId: string, amount: number, idempotencyId: string): Promise<void> {
    // Keep emptied stacks: a missing stack reads as "never welcomed" to the game's ledger.
    return this.move("/Inventory/SubtractInventoryItems", titlePlayerAccountId, amount, idempotencyId, {
      DeleteEmptyStacks: false,
    });
  }

  private async move(
    path: string,
    titlePlayerAccountId: string,
    amount: number,
    idempotencyId: string,
    extra: Record<string, unknown>
  ): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0 || amount > 2_147_483_647) {
      throw new PlayFabError(`Chip amount ${amount} is not a positive 32-bit integer`, "InvalidAmount", true);
    }
    const currency = await this.chipsItemId();
    await this.call(
      path,
      {
        Entity: { Id: titlePlayerAccountId, Type: "title_player_account" },
        Item: { Id: currency },
        Amount: amount,
        IdempotencyId: idempotencyId,
        ...extra,
      },
      "entity"
    );
  }

  private async chipsItemId(): Promise<string> {
    if (this.currencyId) return this.currencyId;
    const data = await this.call(
      "/Catalog/GetItem",
      { AlternateId: { Type: "FriendlyId", Value: CURRENCY_FRIENDLY_ID } },
      "entity"
    );
    const id = data?.Item?.Id;
    if (!id) throw new PlayFabError(`Currency ${CURRENCY_FRIENDLY_ID} not found in the catalog`, "ItemNotFound", false);
    this.currencyId = id;
    return id;
  }

  private async titleEntityToken(): Promise<string> {
    if (this.entityToken && this.entityToken.expiresAt - Date.now() > 5 * 60_000) return this.entityToken.token;
    const data = await this.call("/Authentication/GetEntityToken", {}, "secret");
    const expires = Date.parse(data?.TokenExpiration ?? "");
    this.entityToken = {
      token: data.EntityToken,
      expiresAt: Number.isFinite(expires) ? expires : Date.now() + 60 * 60_000,
    };
    return this.entityToken.token;
  }

  private async call(path: string, body: unknown, auth: "secret" | "entity", retriedAuth = false): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth === "secret") headers["X-SecretKey"] = this.secretKey;
    else headers["X-EntityToken"] = await this.titleEntityToken();

    let response: Response;
    try {
      response = await fetch(this.base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new PlayFabError(`${path}: ${err?.message ?? err}`, timeout ? "Timeout" : "Network", false);
    }

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      throw new PlayFabError(`${path}: HTTP ${response.status} with no JSON body`, "Network", response.status < 500);
    }

    if (payload?.code === 200) return payload.data ?? {};

    const code = String(payload?.error ?? `HTTP${response.status}`);
    if (auth === "entity" && !retriedAuth && (code === "NotAuthenticated" || code === "EntityTokenExpired")) {
      this.entityToken = null;
      return this.call(path, body, auth, true);
    }
    const transient = TRANSIENT_CODES.has(code) || response.status >= 500 || response.status === 429;
    throw new PlayFabError(`${path}: ${code}: ${payload?.errorMessage ?? ""}`.trim(), code, !transient);
  }
}

/** In-memory PlayFab for tests and local runs. New players start with 10,000 chips, like the real welcome. */
export class FakePlayFab implements PlayFabEconomy {
  readonly balances = new Map<string, number>();
  private readonly seen = new Set<string>();
  private failures: { code: string; final: boolean }[] = [];

  constructor(private readonly startingChips = 10_000) {}

  /** Makes the next N chip moves fail with this error, before touching any balance. */
  failNext(count: number, code = "ServiceUnavailable", final = false) {
    for (let i = 0; i < count; i++) this.failures.push({ code, final });
  }

  balanceOf(playFabId: string): number {
    return this.balances.get(FakePlayFab.tpa(playFabId)) ?? this.startingChips;
  }

  static tpa(playFabId: string): string {
    return `TPA-${playFabId}`;
  }

  async authenticateSessionTicket(sessionTicket: string): Promise<PlayFabIdentity> {
    const parts = sessionTicket.split(":");
    if (parts[0] !== "fake" || !parts[1]) {
      throw new PlayFabError("Not a fake session ticket", "InvalidSessionTicket", true);
    }
    return { playFabId: parts[1], titlePlayerAccountId: FakePlayFab.tpa(parts[1]), displayName: parts[2] ?? null };
  }

  async addChips(tpa: string, amount: number, idempotencyId: string): Promise<void> {
    this.apply(tpa, amount, idempotencyId);
  }

  async subtractChips(tpa: string, amount: number, idempotencyId: string): Promise<void> {
    this.apply(tpa, -amount, idempotencyId);
  }

  private apply(tpa: string, delta: number, idempotencyId: string) {
    const failure = this.failures.shift();
    if (failure) throw new PlayFabError(`Injected ${failure.code}`, failure.code, failure.final);
    if (this.seen.has(idempotencyId)) return;   // PlayFab answers a repeat with success and does nothing
    const balance = this.balances.get(tpa) ?? this.startingChips;
    if (balance + delta < 0) throw new PlayFabError("Not enough chips", "InsufficientFunds", true);
    this.balances.set(tpa, balance + delta);
    this.seen.add(idempotencyId);
  }
}
