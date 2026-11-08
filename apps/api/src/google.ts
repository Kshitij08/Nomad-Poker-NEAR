import { base64urlDecode, fail, utf8 } from '@nomad/db/util';

/**
 * Verifies a Google ID token (RS256 JWT) against Google's published keys: signature, issuer, audience (one of
 * our client ids), expiry. Keys are cached in the isolate for as long as Google's Cache-Control allows.
 */

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

interface Jwk extends JsonWebKey {
  kid: string;
}

let cache: { keys: Map<string, CryptoKey>; expires: number } | null = null;

async function googleKeys(now: number): Promise<Map<string, CryptoKey>> {
  if (cache && cache.expires > now) return cache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) fail(502, 'internal', 'Could not reach Google to check the sign-in.');
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  cache = { keys, expires: now + maxAge * 1000 };
  return keys;
}

/** For tests. */
export function resetGoogleKeyCache(): void {
  cache = null;
}

export interface GoogleClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
}

export async function verifyGoogleIdToken(idToken: string, clientIds: string[], now = Date.now()): Promise<GoogleClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) fail(401, 'unauthorized', 'Not a Google ID token.');
  let header: { alg?: string; kid?: string };
  let claims: GoogleClaims & { iss?: string; aud?: string; exp?: number; iat?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
  } catch {
    return fail(401, 'unauthorized', 'Not a Google ID token.');
  }
  if (header.alg !== 'RS256' || !header.kid) fail(401, 'unauthorized', 'Unexpected token algorithm.');
  let key = (await googleKeys(now)).get(header.kid);
  if (!key) {
    cache = null; // Google rotated its keys since we cached them
    key = (await googleKeys(now)).get(header.kid);
  }
  if (!key) fail(401, 'unauthorized', 'Unknown Google signing key.');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64urlDecode(parts[2]), utf8(`${parts[0]}.${parts[1]}`));
  if (!ok) fail(401, 'unauthorized', 'Bad Google token signature.');
  if (!claims.iss || !ISSUERS.has(claims.iss)) fail(401, 'unauthorized', 'Token is not from Google.');
  if (!claims.aud || !clientIds.includes(claims.aud)) fail(401, 'unauthorized', 'Token is for another app.');
  if (!claims.exp || claims.exp * 1000 <= now - 60_000) fail(401, 'expired', 'Google sign-in expired; try again.');
  if (!claims.sub) fail(401, 'unauthorized', 'Token has no subject.');
  return claims;
}
