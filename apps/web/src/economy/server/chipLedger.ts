/**
 * Port of Economy/Contracts/IChipLedger.cs (the contract) and Economy/Server/PlayFabChipLedger.cs (its rules), for
 * the web port's dedicated-server stand-in. No browser-only APIs: the net module's server can run this in a
 * worker, in Node, or in the page.
 *
 * `TitleChipLedger` keeps PlayFabChipLedger's protocol exactly — seat lock (buying-in → seated → cashing-out) won
 * by compare-and-set BEFORE chips move, a ChipGrants log (newest 200 keys + the never-trimmed `welcomed` flag)
 * claimed before paying, deterministic IdempotencyIds — but over an emulated title (titleState.ts) instead of
 * PlayFab's Server/Economy/Data APIs, which need the title secret key and therefore never exist in this client.
 *
 * Implementations never throw: every method resolves to a result carrying its own failure.
 */
import { EconomyConfig } from '../config';
import { grantIdempotencyId, welcomeIdempotencyId } from './ids';
import { moveChips, setObject, type TitlePlayer, type TitleStateHandle } from './titleState';

import { LedgerResult, type ChipLedger } from '@nomad/table-server/ledger';

export { LedgerResult, type ChipLedger };

const LockObjectName = 'SeatLock';
const GrantsObjectName = 'ChipGrants';
const StateBuyingIn = 'buying-in';
const StateSeated = 'seated';
const StateCashingOut = 'cashing-out';
const INT_MAX = 2147483647;

interface SeatLock {
  tableId: string;
  seat: number;
  stack: number;
  handNumber: number;
  state: string | null;
}

export interface GrantLog {
  keys: string[];
  welcomed: boolean;
}

/** economy.js grantLog / the ledger's Deserialize<GrantLog>: always `{ keys: [...], welcomed }`. */
export function readGrantLog(p: TitlePlayer): GrantLog {
  const raw = p.objects[GrantsObjectName] as Partial<GrantLog> | undefined;
  return { keys: Array.isArray(raw?.keys) ? [...raw.keys] : [], welcomed: !!raw?.welcomed };
}

export interface ChipLedgerOptions {
  /** Called for ledger log lines ([ChipLedger] …). Defaults to console. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
}

export class TitleChipLedger implements ChipLedger {
  private readonly log: NonNullable<ChipLedgerOptions['log']>;
  private readonly now: () => number;

  constructor(private readonly title: TitleStateHandle, opts: ChipLedgerOptions = {}) {
    this.log = opts.log ?? ((level, m) => console[level === 'info' ? 'log' : level](m));
    this.now = opts.now ?? Date.now;
  }

  // ---- Identity

  async authenticateAsync(sessionTicket: string): Promise<string | null> {
    if (!sessionTicket) return null;
    const s = this.title.state.sessions[sessionTicket];
    if (!s) return null;
    if (s.expires <= this.now()) {
      this.log('warn', '[ChipLedger] Session ticket presented but expired.');
      return null;
    }
    return this.title.state.players[s.playFabId] ? s.playFabId : null;
  }

  // ---- Buy in

  async debitBuyInAsync(playFabId: string, tableId: string, seat: number, chips: number): Promise<LedgerResult> {
    if (chips <= 0) return LedgerResult.fail('Buy-in must be positive.');
    const p = this.player(playFabId);
    if (!p) return LedgerResult.fail("Couldn't reach the account service.");

    // Welcome a first-time player BEFORE snapshotting the lock (welcoming bumps ProfileVersion).
    if (this.readBalance(p) < 0) return LedgerResult.fail("Couldn't read your balance.");

    let claim: SeatLock | null = null;
    const maxLockAttempts = 4;
    for (let attempt = 0; attempt < maxLockAttempts; attempt++) {
      const version = p.profileVersion;
      const held = this.readLock(p);
      if (held && held.state != null) {
        if (held.tableId === tableId && held.state === StateSeated) return LedgerResult.fail('Already seated at this table.');
        return LedgerResult.fail("You're already sitting at another table.");
      }
      const balance = this.readBalance(p);
      if (balance < 0) return LedgerResult.fail("Couldn't read your balance.");
      if (balance < chips) return LedgerResult.insufficientFunds(balance);

      claim = { tableId, seat, stack: chips, handNumber: 0, state: StateBuyingIn };
      if (this.writeLock(p, claim, version)) break;
      claim = null;
      if (attempt === maxLockAttempts - 1) return LedgerResult.fail("Couldn't hold your seat — try again.");
    }

    const after = this.moveCurrency(p, -chips);
    if (after < 0) {
      this.clearLock(p);
      return LedgerResult.fail("Couldn't take the buy-in.");
    }
    claim!.state = StateSeated;
    this.writeLock(p, claim!, null);
    this.log('info', `[ChipLedger] ${playFabId} bought in for ${chips} at ${tableId} seat ${seat} (balance ${after}).`);
    return LedgerResult.ok(after);
  }

  // ---- During play

  async checkpointAsync(playFabId: string, tableId: string, seat: number, stack: number, handNumber: number): Promise<LedgerResult> {
    const p = this.player(playFabId);
    if (!p) return LedgerResult.fail("Couldn't reach the account service.");
    return this.writeLock(p, { tableId, seat, stack, handNumber, state: StateSeated }, null)
      ? LedgerResult.ok()
      : LedgerResult.fail("Couldn't checkpoint the stack.");
  }

  // ---- Cash out

  async creditCashOutAsync(playFabId: string, tableId: string, chips: number): Promise<LedgerResult> {
    if (chips < 0) return LedgerResult.fail('Cash-out cannot be negative.');
    const p = this.player(playFabId);
    if (!p) return LedgerResult.fail("Couldn't reach the account service.");

    const held = this.readLock(p);
    if (!held || held.state == null || held.tableId !== tableId) {
      this.log('warn', `[ChipLedger] Cash-out refused for ${playFabId} at ${tableId}: no matching seat lock ` +
        `(held: ${held?.tableId ?? 'none'}/${held?.state ?? '-'}).`);
      return LedgerResult.fail('No seat to cash out.');
    }
    held.state = StateCashingOut;
    held.stack = chips;
    this.writeLock(p, held, null);

    if (chips === 0) {
      this.clearLock(p);
      return LedgerResult.ok(this.readBalance(p));
    }
    const after = this.moveCurrency(p, chips);
    if (after < 0) {
      this.log('error', `[ChipLedger] ORPHAN ${playFabId} ${tableId}: credit of ${chips} failed after the lock was marked cashing-out. Needs manual reconciliation.`);
      return LedgerResult.fail("Couldn't return your chips — this has been logged.");
    }
    this.clearLock(p);
    this.log('info', `[ChipLedger] ${playFabId} cashed out ${chips} from ${tableId} (balance ${after}).`);
    return LedgerResult.ok(after);
  }

  // ---- Recovery

  async reconcileAsync(playFabId: string): Promise<LedgerResult> {
    const p = this.player(playFabId);
    if (!p) return LedgerResult.fail("Couldn't reach the account service.");
    const held = this.readLock(p);
    if (!held || held.state == null) return LedgerResult.ok();

    if (held.state === StateSeated) {
      const after = held.stack > 0 ? this.moveCurrency(p, held.stack) : this.readBalance(p);
      if (after < 0) return LedgerResult.fail("Couldn't return the stranded stack.");
      this.clearLock(p);
      this.log('info', `[ChipLedger] Recovered ${held.stack} for ${playFabId} from dead table ${held.tableId} (hand ${held.handNumber}). Balance ${after}.`);
      return LedgerResult.ok(after);
    }
    this.log('error', `[ChipLedger] ORPHAN ${playFabId}: stale '${held.state}' lock for ${held.tableId}, stack ${held.stack}. ` +
      'Cleared without payment — reconcile by hand if the player reports missing chips.');
    this.clearLock(p);
    return LedgerResult.ok();
  }

  // ---- Grants

  async grantAsync(playFabId: string, chips: number, reason: string, idempotencyKey: string): Promise<LedgerResult> {
    if (chips <= 0) return LedgerResult.fail('Grant must be positive.');
    if (!idempotencyKey) return LedgerResult.fail('Grants need an idempotency key.');
    const p = this.player(playFabId);
    if (!p) return LedgerResult.fail("Couldn't reach the account service.");

    const version = p.profileVersion;
    const log = readGrantLog(p);
    if (log.keys.includes(idempotencyKey)) {
      this.log('info', `[ChipLedger] Grant '${idempotencyKey}' already applied to ${playFabId}; skipping.`);
      return LedgerResult.ok(this.readBalance(p));
    }
    log.keys.push(idempotencyKey);
    if (log.keys.length > 200) log.keys.splice(0, log.keys.length - 200);
    if (!this.writeObject(p, GrantsObjectName, log, version)) return LedgerResult.fail("Couldn't record the grant — try again.");

    const after = this.moveCurrency(p, chips, grantIdempotencyId(playFabId, idempotencyKey));
    if (after < 0) {
      log.keys.splice(log.keys.indexOf(idempotencyKey), 1);
      this.writeObject(p, GrantsObjectName, log, null);
      this.log('error', `[ChipLedger] ORPHAN ${playFabId}: grant '${idempotencyKey}' (${reason}) was recorded but the credit failed — key cleared for retry.`);
      return LedgerResult.fail("Couldn't add the chips — this has been logged.");
    }
    this.log('info', `[ChipLedger] Granted ${chips} to ${playFabId} (${reason}). Balance ${after}.`);
    return LedgerResult.ok(after);
  }

  async getBalanceAsync(playFabId: string): Promise<number> {
    const p = this.player(playFabId);
    return p ? this.readBalance(p) : -1;
  }

  // ---- Currency

  /** Moves currency; returns the resulting balance or -1. Reading first is what welcomes a first-time player. */
  private moveCurrency(p: TitlePlayer, delta: number, idempotencyId: string | null = null): number {
    const before = this.readBalance(p);
    if (before < 0 || delta === 0) return before;
    if (delta > INT_MAX || delta < -INT_MAX) {
      this.log('error', `[ChipLedger] Refusing to move ${delta} chips for ${p.id}: exceeds a v2 amount.`);
      return -1;
    }
    const moved = moveChips(p, delta, idempotencyId);
    if (moved) this.title.save();
    return moved ? this.readBalance(p) : -1;
  }

  private readBalance(p: TitlePlayer): number {
    return p.chips !== null ? p.chips : this.ensureWelcome(p);
  }

  /** Grants the starting balance to a player nobody has welcomed yet (claim the flag, then pay). */
  private ensureWelcome(p: TitlePlayer): number {
    const version = p.profileVersion;
    const log = readGrantLog(p);
    if (log.welcomed) return 0;
    log.welcomed = true;
    if (!this.writeObject(p, GrantsObjectName, log, version)) return p.chips ?? -1;
    moveChips(p, EconomyConfig.StartingBalance, welcomeIdempotencyId(p.id));
    this.title.save();
    this.log('info', `[ChipLedger] Welcomed ${p.id} with ${EconomyConfig.StartingBalance} chips.`);
    return p.chips ?? -1;
  }

  // ---- Entity objects

  private player(playFabId: string): TitlePlayer | null {
    return (playFabId && this.title.state.players[playFabId]) || null;
  }

  private readLock(p: TitlePlayer): SeatLock | null {
    const raw = p.objects[LockObjectName] as SeatLock | undefined;
    return raw ? { ...raw } : null;
  }

  private writeLock(p: TitlePlayer, lock: SeatLock, expectedVersion: number | null): boolean {
    return this.writeObject(p, LockObjectName, lock, expectedVersion);
  }

  private writeObject(p: TitlePlayer, name: string, value: unknown, expectedVersion: number | null): boolean {
    const ok = setObject(p, name, value, expectedVersion);
    if (ok) this.title.save();
    return ok;
  }

  private clearLock(p: TitlePlayer): void {
    setObject(p, LockObjectName, null, null);
    this.title.save();
  }
}
