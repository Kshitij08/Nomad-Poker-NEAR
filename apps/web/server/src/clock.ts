/**
 * The server's notion of time — Unity's Time.time / WaitForSeconds / `yield return null` for the async port of
 * PokerServerGame. `speed` scales everything (tests run tables 10–50× faster); real wall-clock otherwise.
 */
export interface ServerClock {
  /** Game seconds since the clock started (Time.time). */
  now(): number;
  /** WaitForSeconds(seconds); resolves early (without throwing) when `signal` aborts. */
  wait(seconds: number, signal?: AbortSignal): Promise<void>;
  /** `yield return null`: one tick (lets other tasks run). */
  frame(): Promise<void>;
  /** A repeating Update(); returns a stop function. Interval in game seconds. */
  every(seconds: number, fn: () => void): () => void;
}

export function realClock(speed = 1): ServerClock {
  const t0 = performance.now();
  const s = speed > 0 ? speed : 1;
  return {
    now: () => ((performance.now() - t0) / 1000) * s,
    wait: (seconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
          clearTimeout(id);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const id = setTimeout(done, Math.max(0, (seconds * 1000) / s));
        signal?.addEventListener('abort', done, { once: true });
      }),
    frame: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    every: (seconds, fn) => {
      const id = setInterval(fn, Math.max(5, (seconds * 1000) / s));
      return () => clearInterval(id);
    },
  };
}
