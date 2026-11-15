import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  ProgressRoutes,
  ShopRoutes,
  type ShopBuyRequest,
  SocialRoutes,
  StrategyRoutes,
  TournamentRoutes,
  AdminRoutes,
  type ProfileUpdateRequest,
  type PlayerSearchResponse,
  Routes,
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
  type NearChallengeRequest,
  type NearChallengeResponse,
  type NearVerifyRequest,
  type NearAccountRequest,
  type NearAccountResponse,
  type NearRelayRequest,
  type NearRelayResponse,
} from '@nomad/contract';
import { createPlayerAccount, isAppMadeAccount, relay } from './nearAccounts';
import {
  findPlayer,
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
import { mountAgentMarket } from './agentMarket';
import { accessKeyOf, base64Decode, base64Encode, isAccountId, parseEd25519Key, tournamentEscrow, verifyNep413 } from './near';
import * as ledger from '@nomad/db/ledger';
import * as progress from '@nomad/db/progress';
import * as shop from '@nomad/db/shop';
import * as socialDb from '@nomad/db/social';
import { isLeaderboardKind, leaderboard } from '@nomad/db/leaderboards';
import * as tournaments from '@nomad/db/tournaments';
import * as strategies from '@nomad/db/strategies';
import * as admin from '@nomad/db/admin';
import { reconcile } from '@nomad/db/reconcile';
import { integrityReport } from '@nomad/db/integrity';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { ApiError, fail, iso, randomId, readJson, requireString, sha256Hex } from '@nomad/db/util';

export const VERSION = '0.1.0';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const EMAIL_LINK_TTL_MS = 15 * 60 * 1000;
const EMAIL_RESEND_MS = 60 * 1000;

const PICTURE_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);
const MAX_PICTURE_BYTES = 200_000;

/** The file's first bytes match the type it claims (no HTML or SVG served as a picture). */
function looksLike(type: string, b: Uint8Array): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (type === 'image/png') return at(0, 0x89, 0x50, 0x4e, 0x47);
  if (type === 'image/jpeg') return at(0, 0xff, 0xd8, 0xff);
  return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50); // RIFF....WEBP
}

/** The sign-in email: a plain message with one button (the link works once, for 15 minutes). */
function signInEmail(link: string): { html: string; text: string } {
  const safe = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const text = `Sign in to Nomad Poker

Open this link to sign in. It works once and expires in 15 minutes:
${link}

If you didn't ask for this, ignore this email: nobody can sign in without the link.
`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1fb;font-family:Arial,Helvetica,sans-serif;color:#1d1832">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:22px;font-weight:bold;color:#3a208e">Nomad Poker</td></tr>
<tr><td style="padding:8px 28px;font-size:16px;line-height:1.5">Tap the button to sign in. The link works once and expires in 15 minutes.</td></tr>
<tr><td style="padding:16px 28px"><a href="${safe}" style="display:inline-block;background:#5a35d6;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:12px 24px;border-radius:999px">Sign in to Nomad Poker</a></td></tr>
<tr><td style="padding:8px 28px 4px;font-size:13px;color:#605a78;line-height:1.5">Or paste this address into your browser:<br><span style="word-break:break-all">${safe}</span></td></tr>
<tr><td style="padding:12px 28px 28px;font-size:13px;color:#605a78;line-height:1.5">If you didn't ask for this, ignore this email: nobody can sign in without the link.</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text };
}

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

/** Writes outside sign-in: limited per session token (or per address without one). */
const writeLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.WRITE_LIMITER;
  if (limiter && c.req.method === 'POST' && !c.req.path.startsWith('/v1/auth/')) {
    const token = bearer(c);
    const key = token ? `w:${(await sha256Hex(token)).slice(0, 24)}` : `w:ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}`;
    const { success } = await limiter.limit({ key });
    if (!success) fail(429, 'rate_limited', 'Slow down a little and try again in a minute.');
  }
  await next();
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Server-to-server and HMAC-signed, so it sits ahead of CORS and the per-address write limit (agentMarket.ts).
  mountAgentMarket(app);

  app.use(
    '*',
    cors({
      origin: (origin, c: Context<AppEnv>) => (allowedOrigins(c.env).includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 86400,
    }),
  );

  app.use('*', writeLimit);

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

  // NEAR sign-in: the wallet signs a NEP-413 message (src/near.ts). The key must be a full-access key of the account.
  app.post(Routes.nearChallenge, async (c) => {
    if (!c.env.NEAR_RPC_URL) fail(501, 'not_configured', 'NEAR sign-in is not set up on this server yet.');
    const { accountId } = await readJson<NearChallengeRequest>(c.req.raw);
    const account = requireString(accountId, 'accountId', 64).toLowerCase();
    if (!isAccountId(account)) fail(400, 'bad_request', 'Not a NEAR account id.');
    const now = Date.now();
    const expiresAt = now + CHALLENGE_TTL_MS;
    const nonce = base64Encode(crypto.getRandomValues(new Uint8Array(32)));
    const recipient = new URL(appOrigin(c)).host;
    const message = `Sign in to Nomad Poker as ${account}.\n\nThis signs nothing on chain and costs nothing.\nIssued ${iso(now)}; valid until ${iso(expiresAt)}.`;
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?1').bind(now),
      c.env.DB.prepare("INSERT INTO auth_challenges (id, kind, subject, payload, created_at, expires_at) VALUES (?1, 'near', ?2, ?3, ?4, ?5)").bind(
        nonce,
        account,
        JSON.stringify({ message, recipient }),
        now,
        expiresAt,
      ),
    ]);
    return c.json<NearChallengeResponse>({ message, recipient, nonce, expiresAt: iso(expiresAt) });
  });

  app.post(Routes.nearVerify, async (c) => {
    const rpc = c.env.NEAR_RPC_URL;
    if (!rpc) fail(501, 'not_configured', 'NEAR sign-in is not set up on this server yet.');
    const body = await readJson<NearVerifyRequest>(c.req.raw);
    const account = requireString(body.accountId, 'accountId', 64).toLowerCase();
    const publicKey = requireString(body.publicKey, 'publicKey', 128);
    const nonceText = requireString(body.nonce, 'nonce', 64);
    const key = parseEd25519Key(publicKey);
    const signature = base64Decode(requireString(body.signature, 'signature', 128));
    const nonce = base64Decode(nonceText);
    if (!key || signature?.length !== 64 || nonce?.length !== 32) fail(400, 'bad_request', 'Bad key, signature or nonce encoding.');
    // Single use: the challenge is deleted whether or not the signature checks out.
    const ch = await c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?1 AND kind = 'near' RETURNING subject, payload, expires_at")
      .bind(nonceText)
      .first<{ subject: string; payload: string; expires_at: number }>();
    if (!ch || ch.subject !== account) fail(401, 'unauthorized', 'Unknown or used sign-in challenge; ask for a new one.');
    if (ch.expires_at <= Date.now()) fail(401, 'expired', 'The sign-in challenge expired; ask for a new one.');
    const { message, recipient } = JSON.parse(ch.payload) as { message: string; recipient: string };
    if (!(await verifyNep413(key, signature, message, nonce, recipient))) fail(401, 'unauthorized', 'The wallet signature does not match.');
    let access: Awaited<ReturnType<typeof accessKeyOf>>;
    try {
      access = await accessKeyOf(rpc, account, publicKey);
    } catch (e) {
      console.warn('[near sign-in] RPC', e);
      fail(503, 'internal', "Couldn't reach NEAR to check your key. Try again in a moment.");
    }
    if (access !== 'full-access') fail(401, 'unauthorized', `That key can't sign in for ${account}: it must be one of the account's full-access keys.`);
    const caller = await optionalPlayer(c);
    // An account made here (k3j9x2ab1q.nomad-players.testnet) is no name to play under: keep the player's own.
    const name = isAppMadeAccount(c.env, account) ? (caller?.display_name ?? 'Player') : account.length > 24 ? `${account.slice(0, 10)}…${account.slice(-10)}` : account;
    const res = await completeSignIn(c.env.DB, { provider: 'near', subject: account, label: account }, name, caller);
    return c.json(res, res.created ? 201 : 200);
  });

  // NEAR without a wallet (src/nearAccounts.ts): an account made for you, and gasless moves through the relayer.
  app.post(Routes.nearAccount, requirePlayer, async (c) => {
    const { publicKey } = await readJson<NearAccountRequest>(c.req.raw);
    const res = await createPlayerAccount(c.env, c.get('player').id, requireString(publicKey, 'publicKey', 128));
    return c.json<NearAccountResponse>(res, 201);
  });

  app.post(Routes.nearRelay, requirePlayer, async (c) => {
    const { signedDelegate } = await readJson<NearRelayRequest>(c.req.raw);
    return c.json<NearRelayResponse>(await relay(c.env, c.get('player').id, requireString(signedDelegate, 'signedDelegate', 12_000)));
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
    const echo = c.env.EMAIL_DEV_ECHO === '1';
    const mailer = !echo && c.env.EMAIL && c.env.EMAIL_FROM ? { send: c.env.EMAIL, from: c.env.EMAIL_FROM } : null;
    if (!echo && !mailer) fail(501, 'not_configured', 'Email sign-in is not set up on this server yet.');
    const returnTo = appOrigin(c, body.returnTo);
    const now = Date.now();
    if (mailer) {
      // One link a minute per address: nobody can use the form to flood someone's inbox.
      const recent = await c.env.DB.prepare("SELECT 1 FROM auth_challenges WHERE kind = 'email' AND subject = ?1 AND created_at > ?2 LIMIT 1")
        .bind(email, now - EMAIL_RESEND_MS)
        .first();
      if (recent) fail(429, 'rate_limited', 'We just sent a link to that address. Check your inbox, or try again in a minute.');
    }
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
    // Staging and dev hand the link back (EMAIL_DEV_ECHO); production mails it.
    if (!mailer) return c.json<EmailStartResponse>({ sent: false, devLink: link });
    try {
      await mailer.send.send({ to: email, from: mailer.from, subject: 'Your Nomad Poker sign-in link', ...signInEmail(link) });
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      console.error('[email] send failed', code, (e as Error).message);
      if (code === 'E_RECIPIENT_SUPPRESSED') fail(400, 'bad_request', 'Mail to that address keeps bouncing. Check the address or use another sign-in.');
      if (code === 'E_RATE_LIMIT_EXCEEDED' || code === 'E_DAILY_LIMIT_EXCEEDED') fail(429, 'rate_limited', 'Too many sign-in emails right now; try again in a few minutes.');
      fail(502, 'internal', "Couldn't send the sign-in email. Try again, or play as a guest.");
    }
    return c.json<EmailStartResponse>({ sent: true });
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
    // Unlimited spins for local testing, in the development stage only (cf dev); staging and production: one a day.
    return c.json(await progress.spin(c.env.DB, c.get('player').id, c.env.SPIN_SECRET, Date.now(), { unlimited: c.env.STAGE === 'development' }));
  });

  app.post(ProgressRoutes.login, requirePlayer, async (c) => c.json(await progress.claimLogin(c.env.DB, c.get('player').id)));

  app.post(ProgressRoutes.missionClaim, requirePlayer, async (c) => {
    const { id } = await readJson<MissionClaimRequest>(c.req.raw);
    return c.json(await progress.claimMission(c.env.DB, c.get('player').id, requireString(id, 'id', 64)));
  });

  // ---- Shop (Phase 3) ---------------------------------------------------------------------------
  // Purchases are paid in Coins and debit the ledger.

  app.get(ShopRoutes.catalog, requirePlayer, async (c) => c.json(await shop.catalog(c.env.DB, c.get('player').id)));

  app.post(ShopRoutes.buy, requirePlayer, async (c) => {
    const b = await readJson<ShopBuyRequest>(c.req.raw);
    return c.json(await shop.buyWithCoins(c.env.DB, c.get('player').id, requireString(b.itemId, 'itemId', 64), requireString(b.requestId, 'requestId', 64)));
  });

  // ---- Social, profile, leaderboards (Phase 4) ---------------------------------------------------

  type Body = { idOrName?: string; friendId?: string; fromId?: string; session?: string; money?: boolean };
  const body = (c: Context<AppEnv>) => readJson<Body>(c.req.raw);

  app.get(SocialRoutes.social, requirePlayer, async (c) => c.json(await socialDb.social(c.env.DB, c.get('player'))));
  app.post(SocialRoutes.request, requirePlayer, async (c) => c.json(await socialDb.sendRequest(c.env.DB, c.get('player'), String((await body(c)).idOrName ?? ''))));
  app.post(SocialRoutes.accept, requirePlayer, async (c) => c.json(await socialDb.acceptRequest(c.env.DB, c.get('player'), String((await body(c)).friendId ?? ''))));
  app.post(SocialRoutes.remove, requirePlayer, async (c) => c.json(await socialDb.removeFriend(c.env.DB, c.get('player'), String((await body(c)).friendId ?? ''))));
  app.post(SocialRoutes.invite, requirePlayer, async (c) => {
    const b = await body(c);
    return c.json(await socialDb.sendInvite(c.env.DB, c.get('player'), String(b.friendId ?? ''), String(b.session ?? ''), b.money === true));
  });
  // ---- Profile pictures: uploaded once (the client crops and shrinks them), served from R2 by key.
  app.post(SocialRoutes.picture, requirePlayer, async (c) => {
    const { success } = (await c.env.WRITE_LIMITER?.limit({ key: c.get('player').id })) ?? { success: true };
    if (!success) fail(429, 'rate_limited', 'Slow down a little and try again in a minute.');
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!PICTURE_TYPES.has(type)) fail(400, 'bad_request', 'Use a PNG, JPEG or WebP image.');
    const body = new Uint8Array(await c.req.raw.arrayBuffer());
    if (body.length === 0 || body.length > MAX_PICTURE_BYTES) fail(400, 'bad_request', 'That image is too big (200 KB at most).');
    if (!looksLike(type, body)) fail(400, 'bad_request', "That file isn't the image it says it is.");
    const key = randomId('pic', 16).replace(/[^A-Za-z0-9_-]/g, '');
    await c.env.HANDS.put(`pictures/${key}.webp`, body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
    const old = await socialDb.setPicture(c.env.DB, c.get('player').id, key);
    if (old) await c.env.HANDS.delete(`pictures/${old}.webp`).catch(() => undefined);
    return c.json({ picture: key });
  });
  app.delete(SocialRoutes.picture, requirePlayer, async (c) => {
    const old = await socialDb.setPicture(c.env.DB, c.get('player').id, null);
    if (old) await c.env.HANDS.delete(`pictures/${old}.webp`).catch(() => undefined);
    return c.json({ picture: null });
  });
  app.get(`${SocialRoutes.pictures}/:file`, async (c) => {
    const m = /^([A-Za-z0-9_-]{6,48})\.webp$/.exec(c.req.param('file'));
    if (!m) return c.body(null, 404);
    const obj = await c.env.HANDS.get(`pictures/${m[1]}.webp`);
    if (!obj) return c.body(null, 404);
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.get(SocialRoutes.search, requirePlayer, async (c) => {
    // Reads, but a name search can enumerate players: it shares the per-session write limit.
    const { success } = (await c.env.WRITE_LIMITER?.limit({ key: c.get('player').id })) ?? { success: true };
    if (!success) fail(429, 'rate_limited', 'Slow down a little and try again in a minute.');
    return c.json<PlayerSearchResponse>({ players: await socialDb.searchPlayers(c.env.DB, c.get('player'), c.req.query('q') ?? '') });
  });
  app.post(SocialRoutes.dismiss, requirePlayer, async (c) => c.json(await socialDb.dismissInvite(c.env.DB, c.get('player'), String((await body(c)).fromId ?? ''))));

  app.post(SocialRoutes.profile, requirePlayer, async (c) => {
    const req = await readJson<ProfileUpdateRequest>(c.req.raw);
    const r = await socialDb.updateProfile(c.env.DB, c.get('player'), req, AvatarCatalog.count);
    if (!r.ok) fail(400, 'bad_request', r.error);
    const p = await findPlayer(c.env.DB, c.get('player').id);
    return c.json(profile(p!));
  });

  app.get(`${SocialRoutes.leaderboards}/:kind`, requirePlayer, async (c) => {
    const kind = Number(c.req.param('kind'));
    if (!isLeaderboardKind(kind)) fail(404, 'not_found', 'No such leaderboard.');
    return c.json(await leaderboard(c.env.DB, c.get('player').id, kind, Number(c.req.query('page')) || 0));
  });

  // ---- Tournaments (the game server runs them; the API hosts, registers and shows them) --------

  const json = (c: Context<AppEnv>) => readJson<Record<string, unknown>>(c.req.raw);

  const rules = (env: Env): tournaments.TournamentRules => ({
    ...tournaments.DEFAULT_RULES,
    minLeadMs: Number(env.TOURNAMENT_MIN_LEAD_SECONDS) > 0 ? Number(env.TOURNAMENT_MIN_LEAD_SECONDS) * 1000 : tournaments.DEFAULT_RULES.minLeadMs,
  });
  app.get(TournamentRoutes.list, async (c) =>
    c.json(await tournaments.listTournaments(c.env.DB, c.req.query('filter') ?? 'upcoming', Number(c.req.query('limit')) || 50)),
  );
  app.get(TournamentRoutes.mine, requirePlayer, async (c) => c.json(await tournaments.myTournaments(c.env.DB, c.get('player').id)));
  app.get(`${TournamentRoutes.byCode}/:code`, async (c) =>
    c.json(await tournaments.tournamentByCode(c.env.DB, c.req.param('code'), (await optionalPlayer(c))?.id ?? null)),
  );
  app.get(`${TournamentRoutes.one}/:id`, async (c) =>
    c.json(await tournaments.tournamentView(c.env.DB, c.req.param('id'), (await optionalPlayer(c))?.id ?? null)),
  );
  /** NEAR tournaments' stakes are on the escrow; these views check what players' wallets did there. */
  const escrowOf = (env: Env) => (env.NEAR_RPC_URL && env.NEAR_ESCROW ? tournamentEscrow(env.NEAR_RPC_URL, env.NEAR_ESCROW) : undefined);
  const needEscrow = (env: Env) => escrowOf(env) ?? fail(501, 'not_configured', 'NEAR tournaments are not set up on this server.');
  /** An escrow view that failed (RPC down) is a 503, not a 500. */
  const viaEscrow = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      console.warn('[near tournaments] escrow view', e);
      return fail(503, 'internal', "Couldn't reach NEAR to check the escrow. Try again in a moment.");
    }
  };
  app.post(TournamentRoutes.list, requirePlayer, async (c) => {
    const b = await json(c);
    if (b.currency === 'near') needEscrow(c.env);
    return c.json(await tournaments.createTournament(c.env.DB, c.get('player').id, b, rules(c.env)));
  });
  app.post(`${TournamentRoutes.one}/:id/:action`, requirePlayer, async (c) => {
    const db = c.env.DB;
    const me = c.get('player');
    const id = c.req.param('id');
    const b = await json(c);
    switch (c.req.param('action')) {
      case 'confirm-escrow':
        return c.json(await viaEscrow(tournaments.confirmEscrow(db, needEscrow(c.env), me.id, id)));
      case 'register':
        return c.json(await viaEscrow(tournaments.register(db, me, id, Date.now(), escrowOf(c.env))));
      case 'unregister':
        return c.json(await viaEscrow(tournaments.unregister(db, me.id, id, Date.now(), escrowOf(c.env))));
      case 'edit':
        return c.json(await tournaments.editTournament(db, me.id, id, b, rules(c.env)));
      case 'raise-prize':
        return c.json(await tournaments.raisePrize(db, me.id, id, b.amount));
      case 'cancel':
        return c.json(await tournaments.cancelTournament(db, me.id, id, Date.now(), escrowOf(c.env)));
      case 'remove':
        return c.json(await tournaments.removePlayer(db, me.id, id, String(b.playFabId ?? b.friendId ?? '')));
      default:
        return fail(404, 'not_found', 'No such route.');
    }
  });

  // ---- Strategies market, My Twin, coach -------------------------------------------------------

  const listing = (env: Env): strategies.ListingRules => {
    const r = { ...strategies.DEFAULT_LISTING };
    if (Number(env.LISTING_MIN_HANDS) > 0) r.minHands = Number(env.LISTING_MIN_HANDS);
    if (env.LISTING_MIN_DAYS && Number(env.LISTING_MIN_DAYS) >= 0) r.minDays = Number(env.LISTING_MIN_DAYS);
    return r;
  };
  app.get(StrategyRoutes.strategies, async (c) =>
    c.json({
      strategies: await strategies.listStrategies(
        c.env.DB,
        { sort: c.req.query('sort') ?? 'top', limit: Number(c.req.query('limit')) || 30, style: c.req.query('style') || null },
        listing(c.env),
      ),
    }),
  );
  app.get(StrategyRoutes.mine, requirePlayer, async (c) => c.json(await strategies.creatorDashboard(c.env.DB, c.get('player').id, listing(c.env))));
  app.get(`${StrategyRoutes.one}/:id`, async (c) => c.json(await strategies.getStrategy(c.env.DB, c.req.param('id'), listing(c.env))));
  app.post(StrategyRoutes.strategies, requirePlayer, async (c) =>
    c.json(await strategies.publishStrategy(c.env.DB, c.get('player'), await json(c), listing(c.env))),
  );
  app.post(`${StrategyRoutes.one}/:id/unlist`, requirePlayer, async (c) => {
    await strategies.unlistStrategy(c.env.DB, c.get('player').id, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get(StrategyRoutes.twin, requirePlayer, async (c) => c.json(await strategies.twin(c.env.DB, c.get('player').id)));
  app.get(StrategyRoutes.coach, requirePlayer, async (c) =>
    c.json(await strategies.coachReport(c.env.DB, c.get('player').id, { apiKey: c.env.NEAR_AI_API_KEY, model: c.env.COACH_MODEL })),
  );

  // ---- Support tools (admins listed in admin_users) ---------------------------------------------

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = bearer(c);
    const s = token ? await sessionPlayer(c.env.DB, token) : null;
    if (!s) fail(401, 'unauthorized', 'Sign in first.');
    const role = await admin.adminRole(c.env.DB, s.player.id);
    if (!role) fail(404, 'not_found', 'No such route.'); // not an admin: the routes don't exist for you
    c.set('player', s.player);
    c.set('tokenHash', s.tokenHash);
    c.set('adminRole', role);
    await next();
  };
  const me = (c: Context<AppEnv>) => ({ player_id: c.get('player').id, role: c.get('adminRole')! });
  app.use('/v1/admin/*', requireAdmin);
  app.get(AdminRoutes.me, (c) => c.json(me(c)));
  app.get(AdminRoutes.players, async (c) => c.json({ players: await admin.searchPlayers(c.env.DB, c.req.query('q') ?? '') }));
  app.get(`${AdminRoutes.player}/:id`, async (c) => c.json(await admin.playerDetail(c.env.DB, c.get('player').id, c.req.param('id'))));
  app.post(`${AdminRoutes.player}/:id/adjust`, async (c) => c.json({ balances: await admin.adjustBalance(c.env.DB, me(c), c.req.param('id'), await readJson<Record<string, unknown>>(c.req.raw)) }));
  app.post(`${AdminRoutes.player}/:id/ban`, async (c) =>
    c.json(await admin.setBan(c.env.DB, me(c), c.req.param('id'), true, String((await readJson<Record<string, unknown>>(c.req.raw)).reason ?? ''))),
  );
  app.post(`${AdminRoutes.player}/:id/unban`, async (c) => c.json(await admin.setBan(c.env.DB, me(c), c.req.param('id'), false, '')));
  app.get(AdminRoutes.reconcile, async (c) => c.json(await reconcile(c.env.DB, { sinceMs: Number(c.req.query('since')) || undefined })));
  app.get(AdminRoutes.integrity, async (c) => c.json(await integrityReport(c.env.DB, { sinceMs: Number(c.req.query('since')) || undefined })));
  app.get(AdminRoutes.audit, async (c) =>
    c.json(await admin.auditLog(c.env.DB, { before: Number(c.req.query('before')) || undefined, limit: Number(c.req.query('limit')) || 50 })),
  );

  return app;
}
