import type { NextFunction, Request, Response } from "express";
import { verifyPlayerToken } from "../auth/jwt.js";

export type AuthedRequest = Request & { playerPubkey?: string };

export async function requirePlayerJwt(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.header("authorization")?.trim();
  if (!header?.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Unauthorized — missing Bearer token" });
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Unauthorized — empty Bearer token" });
    return;
  }

  try {
    const payload = await verifyPlayerToken(token);
    req.playerPubkey = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized — invalid or expired token" });
  }
}
