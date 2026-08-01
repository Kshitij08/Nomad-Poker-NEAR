import { Router } from "express";
import type { Pool } from "pg";
import { hasJwtSecretConfigured, signPlayerToken } from "./jwt.js";
import {
  buildSignInMessage,
  createNonce,
  isValidSolanaPubkey,
  NONCE_TTL_MS,
  verifySignInSignature,
} from "./siws.js";
import { requirePlayerJwt, type AuthedRequest } from "../middleware/playerAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthRouter(pool: Pool): Router {
  const router = Router();

  const authLimit = rateLimit({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => `${req.ip}:${String(req.body?.pubkey ?? "")}`,
  });

  router.post("/auth/nonce", authLimit, async (req, res) => {
    if (!hasJwtSecretConfigured()) {
      res.status(503).json({ error: "Auth not configured (JWT_SECRET missing)" });
      return;
    }

    const pubkey = String(req.body?.pubkey ?? "").trim();
    if (!isValidSolanaPubkey(pubkey)) {
      res.status(400).json({ error: "Invalid Solana pubkey" });
      return;
    }

    const nonce = createNonce();
    const issuedAt = new Date().toISOString();
    const message = buildSignInMessage(pubkey, nonce, issuedAt);
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    await pool.query(`DELETE FROM auth_nonces WHERE expires_at < NOW()`);
    await pool.query(
      `INSERT INTO auth_nonces (pubkey, nonce, message, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pubkey, nonce) DO UPDATE SET message = EXCLUDED.message, expires_at = EXCLUDED.expires_at`,
      [pubkey, nonce, message, expiresAt.toISOString()]
    );

    res.json({ pubkey, nonce, message, issuedAt, expiresAt: expiresAt.toISOString() });
  });

  router.post("/auth/verify", authLimit, async (req, res) => {
    if (!hasJwtSecretConfigured()) {
      res.status(503).json({ error: "Auth not configured (JWT_SECRET missing)" });
      return;
    }

    const pubkey = String(req.body?.pubkey ?? "").trim();
    const message = String(req.body?.message ?? "");
    const signature = String(req.body?.signature ?? "").trim();
    const displayName =
      typeof req.body?.displayName === "string" ? req.body.displayName.trim().slice(0, 64) : null;

    if (!isValidSolanaPubkey(pubkey) || !message || !signature) {
      res.status(400).json({ error: "pubkey, message, and signature are required" });
      return;
    }

    const { rows } = await pool.query<{ nonce: string; message: string }>(
      `SELECT nonce, message FROM auth_nonces
       WHERE pubkey = $1 AND message = $2 AND expires_at > NOW()
       LIMIT 1`,
      [pubkey, message]
    );
    const row = rows[0];
    if (!row) {
      res.status(401).json({ error: "Unknown or expired sign-in message" });
      return;
    }

    if (!verifySignInSignature(pubkey, message, signature)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    await pool.query(`DELETE FROM auth_nonces WHERE pubkey = $1 AND nonce = $2`, [
      pubkey,
      row.nonce,
    ]);

    const { rows: playerRows } = await pool.query(
      `INSERT INTO players (pubkey, display_name, last_login_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (pubkey) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, players.display_name),
         last_login_at = NOW()
       RETURNING pubkey, display_name, email, marketing_opt_in, created_at, last_login_at`,
      [pubkey, displayName || null]
    );

    const token = await signPlayerToken(pubkey);
    res.json({ token, player: playerRows[0] });
  });

  router.get("/me", requirePlayerJwt, async (req: AuthedRequest, res) => {
    const pubkey = req.playerPubkey!;
    const { rows } = await pool.query(
      `SELECT pubkey, display_name, email, marketing_opt_in, created_at, last_login_at
       FROM players WHERE pubkey = $1`,
      [pubkey]
    );
    if (!rows[0]) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const { rows: ledger } = await pool.query(
      `SELECT table_id, chips, net_deposited_lamports, net_rake_paid_lamports, updated_at
       FROM player_ledger WHERE player_pubkey = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [pubkey]
    );

    res.json({ player: rows[0], ledger });
  });

  router.put("/me/email", requirePlayerJwt, async (req: AuthedRequest, res) => {
    const pubkey = req.playerPubkey!;
    const emailRaw = req.body?.email;
    const marketingOptIn = Boolean(req.body?.marketingOptIn);

    let email: string | null = null;
    if (emailRaw != null && String(emailRaw).trim() !== "") {
      email = String(emailRaw).trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) {
        res.status(400).json({ error: "Invalid email format" });
        return;
      }
    }

    const { rows } = await pool.query(
      `UPDATE players
       SET email = $2, marketing_opt_in = $3
       WHERE pubkey = $1
       RETURNING pubkey, display_name, email, marketing_opt_in, created_at, last_login_at`,
      [pubkey, email, marketingOptIn]
    );

    if (!rows[0]) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    res.json({ player: rows[0] });
  });

  return router;
}
