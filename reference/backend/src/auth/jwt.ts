import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const DEFAULT_TTL = "7d";

export type PlayerJwtPayload = JWTPayload & {
  sub: string;
  typ: "player";
};

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new Error(
      "JWT_SECRET is required (min 16 chars). Set it in backend/.env / Railway."
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signPlayerToken(pubkey: string): Promise<string> {
  return new SignJWT({ typ: "player" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(pubkey)
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_TTL?.trim() || DEFAULT_TTL)
    .sign(getSecret());
}

export async function verifyPlayerToken(token: string): Promise<PlayerJwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"],
  });
  if (payload.typ !== "player" || typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Invalid player token claims");
  }
  return payload as PlayerJwtPayload;
}

export type PlayFabJwtPayload = JWTPayload & {
  sub: string;
  typ: "pf";
};

/**
 * A short-lived token for a PlayFab player, issued after the backend has checked their session ticket
 * with PlayFab. Separate from the wallet ("player") tokens: one never stands in for the other.
 */
export async function signPlayFabToken(playFabId: string): Promise<string> {
  return new SignJWT({ typ: "pf" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(playFabId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getSecret());
}

export async function verifyPlayFabToken(token: string): Promise<PlayFabJwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
  if (payload.typ !== "pf" || typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Invalid PlayFab token claims");
  }
  return payload as PlayFabJwtPayload;
}

export function hasJwtSecretConfigured(): boolean {
  const secret = process.env.JWT_SECRET?.trim();
  return Boolean(secret && secret.length >= 16);
}
