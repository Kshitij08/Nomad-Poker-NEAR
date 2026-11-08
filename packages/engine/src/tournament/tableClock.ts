import { ArgumentOutOfRangeError } from '../errors';

const INT_MAX = 2147483647;

/**
 * One table's blind clock, in milliseconds of whatever monotonic clock the caller uses. It starts on the table's
 * first hand, not when the table is created, and each round's tables get a new one.
 *
 * The speed-up halves what is left of the current level and makes every later level half length. The clock keeps
 * one anchor — the level that starts at `anchorMs` and how long levels last from there — so a speed-up only moves
 * the anchor, and earlier times keep their levels. Port of Core/Tournament/TableClock.cs.
 */
export class TableClock {
  private readonly normalLevelMs: number;
  private _levelMs: number;
  private anchorMs = 0;
  private anchorLevel = 1;
  private _isStarted = false;
  private _isSpedUp = false;

  constructor(levelMs: number) {
    if (levelMs < 2) throw new ArgumentOutOfRangeError(`levelMs: ${levelMs}. Level length too short.`);
    this.normalLevelMs = levelMs;
    this._levelMs = levelMs;
  }

  get isStarted(): boolean {
    return this._isStarted;
  }
  get isSpedUp(): boolean {
    return this._isSpedUp;
  }
  get levelMs(): number {
    return this._levelMs;
  }

  /** Starts level 1 at `nowMs`. Later calls do nothing. */
  start(nowMs: number): void {
    if (this._isStarted) return;
    this._isStarted = true;
    this.anchorMs = nowMs;
    this.anchorLevel = 1;
  }

  /** The level in force at `nowMs`; level 1 until the clock starts. */
  levelAt(nowMs: number): number {
    if (!this._isStarted) return 1;
    // Only right after a speed-up: the remainder of the level that was running.
    if (nowMs < this.anchorMs) return Math.max(1, this.anchorLevel - 1);
    const steps = Math.floor((nowMs - this.anchorMs) / this._levelMs);
    const level = this.anchorLevel + steps;
    return level > INT_MAX ? INT_MAX : level;
  }

  /** Milliseconds until the next level begins; a whole level until the clock starts. */
  msToNextLevel(nowMs: number): number {
    if (!this._isStarted) return this._levelMs;
    if (nowMs < this.anchorMs) return this.anchorMs - nowMs;
    return this._levelMs - ((nowMs - this.anchorMs) % this._levelMs);
  }

  /**
   * Switches to half-length levels from `nowMs`. Before the clock starts it simply makes every level half length
   * from level 1. Later calls do nothing.
   */
  enableSpeedUp(nowMs: number): void {
    if (this._isSpedUp) return;
    this._isSpedUp = true;
    const half = Math.max(1, Math.trunc(this.normalLevelMs / 2));
    if (!this._isStarted) {
      this._levelMs = half;
      return;
    }
    const current = this.levelAt(nowMs);
    const remaining = this.msToNextLevel(nowMs);
    this.anchorLevel = current + 1;
    this.anchorMs = nowMs + Math.trunc(remaining / 2);
    this._levelMs = half;
  }
}
