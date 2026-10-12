import { randomInt } from "node:crypto";

// No 0/O or 1/I: the join code is read off a friend's screen and typed by hand.
const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The 6-letter code players type to find a private tournament. Shown to people, so easy to read. */
export function newJoinCode(): string {
  return pick(JOIN_ALPHABET, 6);
}

/**
 * The Fusion session the tournament server opens. Kept apart from the join code — knowing the code
 * lets you register, but only registered players are told where to connect.
 */
export function newSessionName(): string {
  return "TRN" + pick(SESSION_ALPHABET, 10);
}

export function normalizeJoinCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function isJoinCode(code: string): boolean {
  return code.length === 6 && [...code].every((c) => JOIN_ALPHABET.includes(c));
}

function pick(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
