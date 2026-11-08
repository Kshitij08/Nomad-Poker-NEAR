import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ProgressRoutes,
  Routes,
  walletSignInMessage,
  type ApiErrorBody,
  type EmailStartRequest,
  type EmailStartResponse,
  type EmailVerifyRequest,
  type GoogleSignInRequest,
  type GuestRequest,
  type HealthResponse,
  type LedgerResponse,
  type MeResponse,
  type MissionClaimRequest,
  type WalletChallengeRequest,
  type WalletChallengeResponse,
  type WalletVerifyRequest,
} from '@nomad/contract';
import {
  cleanDisplayName,
  completeSignIn,
  createPlayer,
  deleteSession,
  guestName,
  identities,
  profile,
  session,
  sessionPlayer,
} from '@nomad/db/accounts';
import type { AppEnv, Env, PlayerRow } from './env';
import { verifyGoogleIdToken } from './google';
import * as ledger from '@nomad/db/ledger';
import * as progress from '@nomad/db/progress';
import { ApiError, base58Decode, fail, iso, randomId, readJson, requireString, sha256Hex, utf8 } from '@nomad/db/util';

export const VERSION = '0.1.0';
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const EMAIL_LINK_TTL_MS = 15 * 60 * 1000;

const allowedOrigins = (env: Env): string[] =>
  env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The app origin a request comes from, if it is one we serve; else the first allowed origin. */
function appOrigin(c: Context<AppEnv>, wanted?: string): string {
  const allowed = allowedOrigins(c.env);
  const candidate = wanted ?? c.req.header('origin');
  if (candidate && allowed.includes(candidate)) return candidate;
  if (wanted) fail(400, 'bad_request', 'returnTo is not an allowed app origin.');
  return allowed[0] ?? 'https://localhost';
}

function bearer(c: Context<AppEnv>): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** The signed-in caller, if the request carries a valid session; never fails. */
async function optionalPlayer(c: Context<AppEnv>): Promise<PlayerRow | null> {
  const token = bearer(c);
  return token ? ((await sessionPlayer(c.env.DB, token))?.player ?? null) : null;
}

const requirePlayer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  const s = token ? await sessionPlayer(c.env.DB, token) : null;
  if (!s) fail(401, 'unauthorized', 'Sign in first.');
  c.set('player', s.player);
  c.set('tokenHash', s.tokenHash);
  await next();
};

const authLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.AUTH_LIMITER;
  if (limiter) {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await limiter.limit({ key: `auth:${ip}` });
    if (!success) fail(429, 'rate_limited', 'Too many sign-in attempts; wait a minute.');
  }
  await next();
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    cors({
      origin: (origin, c: Context<AppEnv>) => (allowedOrigins(c.env).includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 86400,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json<ApiErrorBody>({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
    }
    console.error('[api] unhandled', err);
    return c.json<ApiErrorBody>({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
  });
  app.notFound((c) => c.json<ApiErrorBody>({ error: { code: 'not_found', message: 'No such route.' } }, 404));

  app.get(Routes.health, (c) => c.json<HealthResponse>({ ok: true, stage: c.env.STAGE, version: VERSION }));

  // ---- Sign-in ----------------------------------------------------------------------------------

  app.use('/v1/auth/*', authLimit);

  app.post(Routes.guest, async (c) => {
    const body = await readJson<GuestRequest>(c.req.raw);
    const player = await createPlayer(c.env.DB, { displayName: cleanDisplayName(body.displayName, guestName()) });
    return c.json(await session(c.env.DB, player, true, false), 201);
  });

  app.post(Routes.walletChallenge, async (c) => {
    const { address } = await readJson<WalletChallengeRequest>(c.req.raw);
    const addr = requireString(address, 'address', 64);
    if (base58Decode(addr)?.length !== 32) fail(400, 'bad_request', 'Not a Solana address.');
    const now = Date.now();
    const nonce = randomId('', 16);
    const origin = appOrigin(c);
    const expiresAt = now + WALLET_CHALLENGE_TTL_MS;
    const message = walletSignInMessage({
      domain: new URL(origin).host,
      address: addr,
      uri: origin,
      chainId: c.env.WALLET_CHAIN_ID,
      nonce,
      issuedAt: iso(now),
      expiresAt: iso(expiresAt),
    });
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?1').bind(now),
      c.env.DB.prepare("INSERT INTO auth_challenges (id, kind, subject, payload, created_at, expires_at) VALUES (?1, 'wallet', ?2, ?3, ?4, ?5)").bind(
        nonce,
        addr,
        message,
        now,
        expiresAt,
      ),
    ]);
    return c.json<WalletChallengeResponse>({ nonce, message, expiresAt: iso(expiresAt) });
  });

  app.post(Routes.walletVerify, async (c) => {
    const body = await readJson<WalletVerifyRequest>(c.req.raw);
    const address = requireString(body.address, 'address', 64);
    const nonce = requireString(body.nonce, 'nonce', 64);
    const signature = base58Decode(requireString(body.signature, 'signature', 128));
    const pub = base58Decode(address);
    if (pub?.length !== 32 || signature?.length !== 64) fail(400, 'bad_request', 'Bad address or signature encoding.');
    // Single use: the challenge is deleted whether or not the signature checks out.
    const ch = await c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?1 AND kind = 'wallet' RETURNING subject, payload, expires_at")
      .bind(nonce)
      .first<{ subject: string; payload: string; expires_at: number }>();
    if (!ch || ch.subject !== address) fail(401, 'unauthorized', 'Unknown or used sign-in challenge; ask for a new one.');
    if (ch.expires_at <= Date.now()) fail(401, 'expired', 'The sign-in challenge expired; ask for a new one.');
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify('Ed25519', key, signature, utf8(ch.payload)))) fail(401, 'unauthorized', 'The wallet signature does not match.');
    const label = address;
    const res = await completeSignIn(c.env.DB, { provider: 'wallet', subject: address, label }, `${address.slice(0, 4)}…${address.slice(-4)}`, await optionalPlayer(c));
    return c.json(res, res.created ? 201 : 200);
  });

  app.post(Routes.google, async (c) => {
    const clientIds = (c.env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (clientIds.length === 0) fail(501, 'not_configured', 'Google sign-in is not set up on this server yet.');
    const { idToken } = await readJson<GoogleSignInRequest>(c.req.raw);
    const claims = await verifyGoogleIdToken(requireString(idToken, 'idToken', 4096), clientIds);
    const label = claims.email && claims.email_verified ? claims.email : `Google account ${claims.sub.slice(-4)}`;
    const name = cleanDisplayName(claims.given_name ?? claims.name, 'Player');
    const res = await completeSignIn(c.env.DB, { provider: 'google', subject: claims.sub, label }, name, await optionalPlayer(c));
    return c.json(res, res.created ? 201 : 200);
  });

  app.post(Routes.emailStart, async (c) => {
    const body = await readJson<EmailStartRequest>(c.req.raw);
    const email = requireString(body.email, 'email', 254).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'bad_request', 'Not an email address.');
    if (c.env.EMAIL_DEV_ECHO !== '1') fail(501, 'not_configured', 'Email sign-in is not set up on this server yet.');
    const returnTo = appOrigin(c, body.returnTo);
    const now = Date.now();
    const token = randomId('ne_', 32);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?1').bind(now),
      c.env.DB.prepare("INSERT INTO auth_challenges (id, kind, subject, payload, created_at, expires_at) VALUES (?1, 'email', ?2, ?3, ?4, ?5)").bind(
        await sha256Hex(token),
        email,
        returnTo,
        now,
        now + EMAIL_LINK_TTL_MS,
      ),
    ]);
    const link = `${returnTo}/?emailToken=${encodeURIComponent(token)}`;
    // No mail provider yet: staging hands the link back (EMAIL_DEV_ECHO). Production answers not_configured above.
    return c.json<EmailStartResponse>({ sent: false, devLink: link });
  });

  app.post(Routes.emailVerify, async (c) => {
    const { token } = await readJson<EmailVerifyRequest>(c.req.raw);
    const ch = await c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?1 AND kind = 'email' RETURNING subject, expires_at")
      .bind(await sha256Hex(requireString(token, 'token', 128)))
      .first<{ subject: string; expires_at: number }>();
    if (!ch) fail(401, 'unauthorized', 'This sign-in link was already used or is not valid.');
    if (ch.expires_at <= Date.now()) fail(401, 'expired', 'This sign-in link expired; ask for a new one.');
    const name = cleanDisplayName(ch.subject.split('@')[0], 'Player');
    const res = await completeSignIn(c.env.DB, { provider: 'email', subject: ch.subject, label: ch.subject }, name, await optionalPlayer(c));
    return c.json(res, res.created ? 201 : 200);
  });

  app.post(Routes.signOut, requirePlayer, async (c) => {
    await deleteSession(c.env.DB, c.get('tokenHash'));
    return c.body(null, 204);
  });

  // ---- Player -----------------------------------------------------------------------------------

  app.get(Routes.me, requirePlayer, async (c) => {
    const p = c.get('player');
    const [ids, bal] = await Promise.all([identities(c.env.DB, p.id), ledger.balances(c.env.DB, p.id)]);
    return c.json<MeResponse>({ player: profile(p), identities: ids, balances: bal });
  });

  app.get(Routes.ledger, requirePlayer, async (c) => {
    const p = c.get('player');
    const before = Number(c.req.query('before'));
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
    const [bal, page] = await Promise.all([
      ledger.balances(c.env.DB, p.id),
      ledger.entries(c.env.DB, p.id, { before: Number.isSafeInteger(before) && before > 0 ? before : undefined, limit }),
    ]);
    return c.json<LedgerResponse>({ balances: bal, ...page });
  });

  // ---- Progress and rewards: the server decides --------------------------------------------------

  app.get(ProgressRoutes.progress, requirePlayer, async (c) => c.json(await progress.snapshot(c.env.DB, c.get('player').id)));

  app.post(ProgressRoutes.spin, requirePlayer, async (c) => {
    if (!c.env.SPIN_SECRET) fail(501, 'not_configured', 'The daily spin is not set up on this server yet.');
    return c.json(await progress.spin(c.env.DB, c.get('player').id, c.env.SPIN_SECRET));
  });

  app.post(ProgressRoutes.login, requirePlayer, async (c) => c.json(await progress.claimLogin(c.env.DB, c.get('player').id)));

  app.post(ProgressRoutes.missionClaim, requirePlayer, async (c) => {
    const { id } = await readJson<MissionClaimRequest>(c.req.raw);
    return c.json(await progress.claimMission(c.env.DB, c.get('player').id, requireString(id, 'id', 64)));
  });

  return app;
}
