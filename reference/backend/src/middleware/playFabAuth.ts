import type { NextFunction, Request, Response } from "express";
import { verifyPlayFabToken } from "../auth/jwt.js";

export type PlayFabRequest = Request & { playFabId?: string };

function bearer(req: Request): string | undefined {
  const header = req.header("authorization")?.trim();
  if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

/** Routes that act for a player: a token from POST /api/auth/playfab is required. */
export async function requirePlayFabJwt(req: PlayFabRequest, res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: "Sign in to continue.", code: "sign_in" });
    return;
  }
  try {
    req.playFabId = (await verifyPlayFabToken(token)).sub;
    next();
  } catch {
    res.status(401).json({ error: "Your sign-in has expired. Sign in again.", code: "sign_in" });
  }
}

/** Routes anyone may read, which say more to a signed-in player (their own entry, a private code). */
export async function optionalPlayFabJwt(req: PlayFabRequest, _res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (token) {
    try {
      req.playFabId = (await verifyPlayFabToken(token)).sub;
    } catch {
      // A stale token on a public read is just an anonymous read.
    }
  }
  next();
}
