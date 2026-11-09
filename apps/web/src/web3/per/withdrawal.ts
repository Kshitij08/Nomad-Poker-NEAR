/**
 * "Withdraw all" in the background. Port of Per/Unity/PerWithdrawal.cs (a static class there; one instance per game
 * wallet here, C# events → listener sets). The wallet approves taking the game balance out of the rollup
 * (vault_exit); MagicBlock's shuttle then brings it to the vault on Solana (up to a minute or more). This watches the
 * vault until it arrives, across screens and after a reload (the withdrawal is saved). The last step, vault_payout, is
 * signed by the wallet, so it isn't sent from the background: when the money has arrived the menu offers "Finish
 * withdrawal". Test builds (the test program) finish it in the background instead: the backend's keeper sends
 * vault_payout_to_owner and `withdrawn` fires with no Finish tap; if it hasn't paid within AUTO_GRACE_SECONDS of the
 * money arriving, the Finish button comes back.
 */
import { PublicKey } from '@solana/web3.js';
import { PlayerPrefs } from '../../app/services';
import { IDS } from '../config';
import type { PerHttp } from '../lib/http';
import { PerIds } from './addresses';
import { PerAgent } from './agent';
import type { PerGameWallet, Status } from './gameWallet';
import { sol } from './money';
import { PerVault } from './vault';

export enum WithdrawalPhase {
  None = 0,
  OnTheWay = 1,
  Ready = 2,
}

/** The withdrawal in progress, saved so it survives a restart (field names as the C# Pending's JSON). */
interface Pending {
  Wallet: string;
  /** Lamports already at the vault before the exit (an earlier withdrawal, or anyone's transfer). */
  Baseline: bigint;
  /** Lamports at the vault once everything arrived: Baseline plus what left the rollup. */
  Expected: bigint;
  StartedAt: number;
  LastChangeAt: number;
  LastLanded: bigint;
  /** False when the exit's confirmation timed out: it may never have happened. */
  Confirmed: boolean;
  /** Seconds after which a withdrawal with nothing arrived is dropped. 0: kept until it arrives. */
  GiveUpAfter: number;
  /** Test builds: what the backend has paid out of this withdrawal so far. */
  Paid: bigint;
}

const PREF_KEY = 'per.withdrawal';
const POLL_MS = 5000;
/** When only part arrived and nothing more for this long, that part can be paid out (the rest follows). */
const PARTIAL_QUIET_SECONDS = 60;
const PARTIAL_MIN_SECONDS = 90;
const UNCONFIRMED_GIVE_UP = 180;
const REMAINDER_GIVE_UP = 900;
/** After this long the note says it's taking longer than usual. */
const SLOW_SECONDS = 180;
const AUTO_GRACE_SECONDS = 120;

const BIG_FIELDS = ['Baseline', 'Expected', 'LastLanded', 'Paid'] as const;

/** JsonConvert.SerializeObject(Pending): declaration order, ulongs as plain JSON integers. */
export function serializePending(p: Pending): string {
  return `{"Wallet":${JSON.stringify(p.Wallet ?? null)},"Baseline":${p.Baseline},"Expected":${p.Expected},"StartedAt":${p.StartedAt},`
    + `"LastChangeAt":${p.LastChangeAt},"LastLanded":${p.LastLanded},"Confirmed":${p.Confirmed},"GiveUpAfter":${p.GiveUpAfter},"Paid":${p.Paid}}`;
}

/** JsonConvert.DeserializeObject<Pending>, with the ulongs read exactly (quoted before JSON.parse). */
export function parsePending(s: string): Pending {
  const quoted = s.replace(/"(Baseline|Expected|LastLanded|Paid)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
  const j = JSON.parse(quoted) as Record<string, unknown>;
  if (!j || typeof j !== 'object') throw new Error('not an object');
  const big = (k: (typeof BIG_FIELDS)[number]) => (j[k] == null ? 0n : BigInt(String(j[k])));
  const num = (k: string) => (j[k] == null ? 0 : Number(j[k]));
  return {
    Wallet: j.Wallet == null ? (null as unknown as string) : String(j.Wallet),
    Baseline: big('Baseline'), Expected: big('Expected'), StartedAt: num('StartedAt'), LastChangeAt: num('LastChangeAt'),
    LastLanded: big('LastLanded'), Confirmed: j.Confirmed === true, GiveUpAfter: num('GiveUpAfter'), Paid: big('Paid'),
  };
}

const minB = (a: bigint, b: bigint) => (a < b ? a : b);

export interface PerWithdrawalOptions {
  /** For the test builds' backend payout (PerAgent.call). */
  http?: PerHttp;
  /** PerSettings.BackendUrl ('' = not configured: the backend never pays, the Finish button comes back). */
  backendUrl?: string;
  /** The backend finishes withdrawals (PerIds.TestProgram). Default: whether the test program is in use. */
  auto?: boolean;
  nowSeconds?: () => number;
  /** PerClock.Instance.Wait. */
  wait?: (ms: number) => Promise<void>;
}

/** The RPC's "not confirmed in 30 s" (C# TimeoutException): sent, maybe landing later. */
const isConfirmTimeout = (e: unknown): boolean => e instanceof Error && /not confirmed in/.test(e.message);

export class PerWithdrawal {
  static readonly PREF_KEY = PREF_KEY;

  private saved: Pending | null = null;
  private loaded = false;
  private watching = false;
  private landedNow = 0n;
  private readySince = 0;
  private readonly changedListeners = new Set<() => void>();
  private readonly withdrawnListeners = new Set<(amount: bigint) => void>();
  private readonly auto: boolean;
  private readonly nowFn: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly gameWallet: PerGameWallet, private readonly opts: PerWithdrawalOptions = {}) {
    this.auto = opts.auto ?? [IDS.perTestProgram, IDS.perNomadProgram].includes(PerIds.program.toBase58() as never);
    this.nowFn = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.wait = opts.wait ?? ((ms) => (opts.http ? opts.http.delay(ms) : new Promise((r) => setTimeout(r, ms))));
  }

  /** The saved withdrawal, read on first use. */
  private get p(): Pending | null {
    if (!this.loaded) {
      this.loaded = true;
      this.saved = PerWithdrawal.load();
    }
    return this.saved;
  }
  private set p(v: Pending | null) {
    this.loaded = true;
    this.saved = v;
  }

  private get now(): number {
    return this.nowFn();
  }

  /** Raised when the phase or the amounts change (also from the background loop). Returns an unsubscribe. */
  onChanged(fn: () => void): () => void {
    this.changedListeners.add(fn);
    return () => this.changedListeners.delete(fn);
  }
  /** Test builds: the backend paid this much into the wallet (no Finish tap). */
  onWithdrawn(fn: (amount: bigint) => void): () => void {
    this.withdrawnListeners.add(fn);
    return () => this.withdrawnListeners.delete(fn);
  }
  private changed(): void {
    for (const f of [...this.changedListeners]) f();
  }
  private withdrawn(amount: bigint): void {
    for (const f of [...this.withdrawnListeners]) f(amount);
  }

  get current(): WithdrawalPhase {
    const p = this.p;
    if (!p) return WithdrawalPhase.None;
    if (!PerWithdrawal.ready(p, this.landedNow, this.now)) return WithdrawalPhase.OnTheWay;
    // Test builds: the backend pays it out; the Finish button only if it hasn't after a while.
    return this.auto && (this.readySince === 0 || this.now - this.readySince < AUTO_GRACE_SECONDS) ? WithdrawalPhase.OnTheWay : WithdrawalPhase.Ready;
  }
  /** The wallet the withdrawal is for (null if none). */
  get wallet(): string | null {
    return this.p?.Wallet ?? null;
  }
  /** What left the game balance in this withdrawal. */
  get amount(): bigint {
    const p = this.p;
    return p ? p.Expected - minB(p.Expected, p.Baseline) : 0n;
  }
  /** What can be paid out now (everything at the vault). */
  get arrived(): bigint {
    return this.p ? this.landedNow : 0n;
  }
  get slow(): boolean {
    const p = this.p;
    return !!p && this.current === WithdrawalPhase.OnTheWay && this.now - p.StartedAt > SLOW_SECONDS;
  }

  /** After a reload: keep watching a saved withdrawal (RuntimeInitializeOnLoadMethod Resume). */
  resume(): void {
    if (this.p) void this.watch();
  }

  /**
   * Starts a withdrawal of the whole game balance: the wallet approves the exit from the rollup, then this returns and
   * the arrival is watched in the background. Returns what left the rollup (0: nothing to withdraw, or one was
   * already in progress).
   */
  async start(status: Status): Promise<bigint> {
    if (this.p) return 0n;
    const wallet = this.gameWallet.address;
    if (!wallet) throw new Error('no wallet connected');
    await this.gameWallet.loadState(wallet);
    const landed = await this.gameWallet.landed(wallet);
    const balance = (await this.gameWallet.balance(status)) ?? 0n;
    if (this.p) return 0n; // another tap got here first
    const now = this.now;
    if (balance === 0n) {
      if (landed === 0n) {
        status('Your game balance is empty.');
        return 0n;
      }
      // Money from an earlier withdrawal is already at the vault: nothing to take out, it's ready to pay out.
      this.save({ Wallet: wallet.toBase58(), Baseline: 0n, Expected: landed, StartedAt: now, LastChangeAt: now, LastLanded: landed, Confirmed: true, GiveUpAfter: 0, Paid: 0n });
      this.landedNow = landed;
      this.changed();
      return 0n;
    }
    // Saved before the wallet is asked, so a second tap meanwhile can't send a second exit.
    const p: Pending = { Wallet: wallet.toBase58(), Baseline: landed, Expected: landed + balance, StartedAt: now, LastChangeAt: now, LastLanded: landed, Confirmed: false, GiveUpAfter: UNCONFIRMED_GIVE_UP, Paid: 0n };
    this.save(p);
    this.landedNow = landed;
    this.changed();
    try {
      status(`Approve taking ${sol(balance)} out of the game balance in your wallet…`);
      await this.gameWallet.l1.sendWithWallet([PerVault.vaultExit(wallet, balance, PerVault.newShuttleId())], this.gameWallet.signer);
      p.Confirmed = true;
      p.GiveUpAfter = 0;
      p.StartedAt = this.now;
      this.save(p);
      if (this.auto) await this.askBackend(p, false, true);
    } catch (e) {
      if (isConfirmTimeout(e)) {
        // Sent, but not confirmed in time: it may still land. The watch decides (and drops it if nothing arrives).
        console.warn('[PerWithdrawal] exit not confirmed in time; watching for it');
      } else {
        // Not signed, or the transaction failed: nothing left the rollup.
        this.clear();
        this.changed();
        throw e;
      }
    }
    void this.watch();
    return balance;
  }

  /** Pays out what arrived (the wallet approves). If only part arrived, the rest keeps being watched. Returns what was paid. */
  async finish(status: Status): Promise<bigint> {
    const p = this.p;
    if (!p) throw new Error('no withdrawal in progress');
    const wallet = this.gameWallet.address;
    if (!wallet) throw new Error('no wallet connected');
    if (wallet.toBase58() !== p.Wallet) throw new Error(`this withdrawal belongs to wallet ${p.Wallet.slice(0, 4)}…; connect that wallet to finish it`);
    await this.gameWallet.loadState(wallet);
    const landed = await this.gameWallet.landed(wallet);
    if (landed === 0n) {
      this.landedNow = 0n;
      this.changed();
      throw new Error("nothing has arrived yet; it's still on its way");
    }
    status(`Approve receiving ${sol(landed)} in your wallet…`);
    await this.gameWallet.l1.sendWithWallet(PerVault.vaultPayout(wallet), this.gameWallet.signer);
    // vault_payout empties the vault: anything still expected is the part that hasn't arrived yet.
    const rest = p.Expected > landed ? p.Expected - landed : 0n;
    if (this.p === p) {
      if (rest === 0n) this.clear();
      else {
        const now = this.now;
        this.save({ Wallet: p.Wallet, Baseline: 0n, Expected: rest, StartedAt: now, LastChangeAt: now, LastLanded: 0n, Confirmed: true, GiveUpAfter: REMAINDER_GIVE_UP, Paid: 0n });
        this.landedNow = 0n;
        void this.watch();
      }
    }
    this.changed();
    status(`Withdrawn: ${sol(landed)} is in your wallet as SOL.`);
    return landed;
  }

  /** Checks the vault now (the menu calls it when it shows the withdrawal). */
  checkSoon(): void {
    if (this.p) void this.watch();
  }

  // ---------------------------------------------------------------------------- the background watch

  private async watch(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      while (this.p) {
        const p = this.p;
        try {
          const wallet = new PublicKey(p.Wallet);
          await this.gameWallet.loadState(wallet);
          const landed = await this.gameWallet.landed(wallet);
          if (this.p !== p) continue;
          const now = this.now;
          if (landed !== p.LastLanded) {
            p.LastLanded = landed;
            p.LastChangeAt = now;
            this.save(p);
          }
          const changed = landed !== this.landedNow;
          this.landedNow = landed;
          if (landed <= p.Baseline && p.GiveUpAfter > 0 && now - p.StartedAt > p.GiveUpAfter) {
            // An unconfirmed exit that never arrived, or the rest of a partial one that didn't come: drop it.
            console.log('[PerWithdrawal] nothing arrived; dropping the withdrawal');
            this.clear();
            this.changed();
            break;
          }
          if (changed) this.changed();
          if (this.auto) {
            // The backend pays it out (or already did while the game was closed).
            const ready = PerWithdrawal.ready(p, landed, now);
            if (ready && this.readySince === 0) this.readySince = now;
            if (await this.askBackend(p, ready, false)) continue;
            if (ready && now - this.readySince >= AUTO_GRACE_SECONDS) {
              this.changed();
              break;
            } // Finish button as a fallback
          } else if (PerWithdrawal.ready(p, landed, now)) break; // the player finishes it; nothing more to watch
        } catch (e) {
          console.warn('[PerWithdrawal] check: ' + ((e as Error).message ?? e));
        }
        await this.wait(POLL_MS);
      }
    } finally {
      this.watching = false;
    }
  }

  /** Test builds: registers the withdrawal with the backend, or asks it to pay out what arrived. True when it paid. */
  private async askBackend(p: Pending, ready: boolean, register: boolean): Promise<boolean> {
    try {
      const wallet = new PublicKey(p.Wallet);
      if (!this.gameWallet.hasPlayKey(wallet)) return false; // never prompts the wallet from the background
      if (!this.opts.http) throw new Error('no http for the backend');
      const key = await this.gameWallet.playKey(() => {});
      const data: Record<string, unknown> = { ready };
      // Everything at the vault once it arrived (the backend pays out the whole vault, as vault_payout does).
      if (register) data.expected = p.Expected.toString();
      const r = await PerAgent.call(this.opts.http, this.opts.backendUrl ?? '', key, '/vault/payout', data);
      const paid = BigInt(String(r.paid ?? '0'));
      if (paid <= p.Paid) return false;
      const now = paid - p.Paid;
      if (this.p !== p) return false;
      if (r.done == null) throw new Error("the backend's answer has no 'done'");
      if (r.done === true) this.clear();
      else {
        p.Paid = paid;
        p.Baseline = 0n;
        p.Expected = p.Expected > now ? p.Expected - now : 0n;
        p.LastLanded = 0n;
        this.landedNow = 0n;
        this.readySince = 0;
        this.save(p);
      }
      this.changed();
      this.withdrawn(now);
      return true;
    } catch (e) {
      console.warn('[PerWithdrawal] background payout: ' + ((e as Error).message ?? e));
      return false;
    }
  }

  private static ready(p: Pending, landed: bigint, now: number): boolean {
    return landed > 0n && (landed >= p.Expected
      // Part arrived and nothing more for a while (a fee, or the rest is slow): that part can be paid out.
      || (landed > p.Baseline && now - p.LastChangeAt >= PARTIAL_QUIET_SECONDS && now - p.StartedAt >= PARTIAL_MIN_SECONDS));
  }

  // ---------------------------------------------------------------------------- saved state

  private static load(): Pending | null {
    try {
      const s = PlayerPrefs.getString(PREF_KEY, '');
      return s.length === 0 ? null : parsePending(s);
    } catch (e) {
      console.warn('[PerWithdrawal] saved state: ' + ((e as Error).message ?? e));
      return null;
    }
  }

  private save(p: Pending): void {
    this.p = p;
    PlayerPrefs.setString(PREF_KEY, serializePending(p));
  }

  private clear(): void {
    this.p = null;
    this.landedNow = 0n;
    this.readySince = 0;
    PlayerPrefs.deleteKey(PREF_KEY);
  }
}
