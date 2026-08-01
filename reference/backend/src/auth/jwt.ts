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

export function hasJwtSecretConfigured(): boolean {
  const secret = process.env.JWT_SECRET?.trim();
  return Boolean(secret && secret.length >= 16);
}
