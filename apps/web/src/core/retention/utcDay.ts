/**
 * Calendar day in UTC, counted from the Unix epoch. Retention loops use this, not local time.
 * Port of Core/Retention/UtcDay.cs. The clock is injectable everywhere it is used (see `Clock`).
 */
export const UtcDay = {
  /** (int)(utc.Date - Epoch).TotalDays: whole UTC days since 1970-01-01. */
  fromUtc(utc: Date | number): number {
    const ms = typeof utc === 'number' ? utc : utc.getTime();
    return Math.floor(ms / 86_400_000);
  },

  /** Epoch.AddDays(dayNumber). */
  toDate(dayNumber: number): Date {
    return new Date(dayNumber * 86_400_000);
  },
};

/** Injectable UTC clock (C# `Func<DateTime> Clock = () => DateTime.UtcNow`), in epoch milliseconds. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
