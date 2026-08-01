import type { NextFunction, Request, Response } from "express";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Simple in-memory fixed-window rate limiter (per process).
 * Fine for a single Railway replica; swap for Redis if you scale out.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
}) {
  const keyFn = options.keyFn ?? ((req) => req.ip || "unknown");

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.path}:${keyFn(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}

/** Periodic cleanup so the map does not grow forever. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref?.();
