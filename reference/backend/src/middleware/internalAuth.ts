import type { NextFunction, Request, Response } from "express";

const HEADER = "x-api-key";

function readApiKey(req: Request): string | undefined {
  const header = req.header(HEADER)?.trim();
  if (header) {
    return header;
  }

  const auth = req.header("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return undefined;
}

/** Local development only: INTERNAL_API_KEY_OPTIONAL=1 lets /internal/* run open without a key. */
const keyOptional = () => process.env.INTERNAL_API_KEY_OPTIONAL === "1";

/**
 * Protects /internal/* routes: every request must present INTERNAL_API_KEY via `X-API-Key` or
 * `Authorization: Bearer <key>`. Without a key configured they're refused (review A3: they used to be open), unless
 * INTERNAL_API_KEY_OPTIONAL=1 (local development).
 */
export function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_KEY?.trim();
  if (!expected) {
    if (keyOptional()) { next(); return; }
    res.status(503).json({ error: "Internal routes are disabled: INTERNAL_API_KEY is not configured" });
    return;
  }

  const provided = readApiKey(req);
  if (!provided || provided !== expected) {
    res.status(401).json({ error: "Unauthorized — invalid or missing internal API key" });
    return;
  }

  next();
}

/** At startup: no INTERNAL_API_KEY means no start (the game servers' routes would be open), unless
 *  INTERNAL_API_KEY_OPTIONAL=1 (local development), which only warns. */
export function requireInternalApiKeyConfigured() {
  if (process.env.INTERNAL_API_KEY?.trim()) return;
  if (keyOptional()) {
    console.warn("[backend] INTERNAL_API_KEY is not set and INTERNAL_API_KEY_OPTIONAL=1: /internal/* routes are open (local development only).");
    return;
  }
  console.error("[backend] INTERNAL_API_KEY is not set: refusing to start. Set it (or INTERNAL_API_KEY_OPTIONAL=1 for local development).");
  process.exit(1);
}
