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

/**
 * Protects /internal/* routes. When INTERNAL_API_KEY is set, every request must
 * present it via `X-API-Key` or `Authorization: Bearer <key>`.
 * When unset (local dev only), routes remain open with a startup warning.
 */
export function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_KEY?.trim();
  if (!expected) {
    next();
    return;
  }

  const provided = readApiKey(req);
  if (!provided || provided !== expected) {
    res.status(401).json({ error: "Unauthorized — invalid or missing internal API key" });
    return;
  }

  next();
}

export function warnIfInternalApiKeyMissing() {
  if (!process.env.INTERNAL_API_KEY?.trim()) {
    console.warn(
      "[backend] INTERNAL_API_KEY is not set — /internal/* routes are unauthenticated. " +
        "Set INTERNAL_API_KEY before exposing the backend publicly."
    );
  }
}
