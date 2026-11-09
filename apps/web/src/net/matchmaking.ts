/**
 * The connect half of Net/PokerMenuConnection.cs (+ PokerPartyClient): Quick Play into the stake's pool with
 * overflow, Party Create (spawn a dedicated room under a generated code, then join it) and Join by code — against the
 * local table server instead of Photon. DOM-free.
 */
import { StakeCatalog, type StakeTier } from '@nomad/engine/stakes/stakes';
import { NetConnection, type JoinResult } from './netConnection';
import { ChainTableMode, PartyCodes, StakeSessionNames } from '@nomad/table-server/sessions';

export interface ConnectResult {
  ok: boolean;
  conn?: NetConnection;
  session?: string;
  /** Player-facing failure text (FusionMenu shows DebugMessage). */
  message?: string;
  /** The table server could not be reached at all (not running) — the only case the menu offers the offline table. */
  unreachable?: boolean;
}

export type ConnectRoute =
  | { kind: 'quick'; minBuyIn: number }
  | { kind: 'create' }
  | { kind: 'join'; code: string };

/** Unity: 3 primary tries 1.5 s apart, then up to 4 overflow tables; named joins retry 4 times. */
const PrimaryTries = 3;
const ExtraTables = 4;
const RetryDelayMs = 1500;

export interface ConnectOptions {
  url: string;
  /** MenuConnectCancel.Requested. */
  cancelled?: () => boolean;
  /** Wallet check for Quick Play (ResolveConnectStake). */
  coins?: number;
  selectedBuyIn?: number;
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** ResolveConnectStake: the coins needed for the chosen stake and buy-in. */
export function checkQuickPlayFunds(tier: StakeTier, coins: number, buyIn: number): string | null {
  if (coins < StakeCatalog.Lowest.minBuyIn)
    return `You need ${StakeCatalog.Lowest.minBuyIn.toLocaleString('en-US')} Coins to sit down. Claim the Daily Spin or login reward first.`;
  if (coins < tier.minBuyIn)
    return `You need ${tier.minBuyIn.toLocaleString('en-US')} Coins for ${tier.displayName} tables. Pick a lower stake or wait for Daily Spin.`;
  if (buyIn > 0 && coins < buyIn) return `You need ${buyIn.toLocaleString('en-US')} Coins for this buy-in. Lower the slider or claim Daily Spin.`;
  return null;
}

export async function connectTable(route: ConnectRoute, opts: ConnectOptions): Promise<ConnectResult> {
  const delay = opts.delay ?? sleep;
  const cancelled = opts.cancelled ?? (() => false);
  const conn = new NetConnection(opts.url);
  try {
    await conn.open();
  } catch (e) {
    return { ok: false, message: (e as Error).message, unreachable: true };
  }
  const fail = (message: string): ConnectResult => {
    conn.close();
    return { ok: false, message };
  };
  const cancel = (): ConnectResult => {
    conn.close();
    return { ok: false, message: '' };
  };

  if (route.kind === 'quick') {
    if (opts.coins !== undefined) {
      const tier = StakeCatalog.get(route.minBuyIn);
      const err = checkQuickPlayFunds(tier, opts.coins, opts.selectedBuyIn ?? 0);
      if (err) return fail(err);
    }
    const primary = StakeSessionNames.primary(false, route.minBuyIn);
    let result: JoinResult | null = null;
    for (let attempt = 0; attempt < PrimaryTries; attempt++) {
      if (cancelled()) return cancel();
      if (attempt > 0) await delay(RetryDelayMs);
      result = await conn.join(primary);
      if (cancelled()) return cancel();
      if (result.ok) return { ok: true, conn, session: primary };
      if (result.reason === 'GameIsFull') break;
    }
    let failed = primary;
    for (let n = 1; n <= ExtraTables; n++) {
      if (cancelled()) return cancel();
      const overflow = await conn.requestOverflow(false, failed, route.minBuyIn);
      if (overflow.error) return fail(overflow.error);
      if (!overflow.session || StakeSessionNames.parseMinBuyIn(overflow.session) !== (route.minBuyIn > 0 ? route.minBuyIn : StakeCatalog.DefaultMinBuyIn)) continue;
      result = await conn.join(overflow.session);
      if (result.ok) return { ok: true, conn, session: overflow.session };
      failed = overflow.session;
    }
    return fail(result?.message || 'Could not join a Quick Play table. Try again in a moment.');
  }

  let session: string;
  if (route.kind === 'create') {
    session = PartyCodes.create();
    const spawnError = await conn.spawnRoom(session, false);
    if (spawnError) return fail(spawnError);
  } else {
    // Party codes are upper case (PokerMenuConnection upper-cases a typed code); tournament sessions are used as given.
    session = ChainTableMode.isTournamentSession(route.code.trim()) || StakeSessionNames.isPool(route.code.trim()) ? route.code.trim() : route.code.trim().toUpperCase();
    if (!session) return fail('Enter a room code.');
  }

  let r = await conn.join(session);
  for (let attempt = 0; attempt < 4 && !r.ok && r.reason !== 'GameNotFound'; attempt++) {
    if (cancelled()) return cancel();
    await delay(RetryDelayMs);
    r = await conn.join(session);
  }
  if (!r.ok) return fail(r.reason === 'GameNotFound' ? `Room ${session} was not found.` : r.message || `Could not join ${session}.`);
  return { ok: true, conn, session };
}
