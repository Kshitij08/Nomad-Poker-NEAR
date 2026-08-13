import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const AUTH_DOMAIN = process.env.AUTH_DOMAIN?.trim() || "poker.app";
export const NONCE_TTL_MS = 5 * 60 * 1000;

export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Deterministic SIWS-style message the client must sign exactly. */
export function buildSignInMessage(pubkey: string, nonce: string, issuedAt: string): string {
  return [
    `${AUTH_DOMAIN} wants you to sign in with your Solana account:`,
    pubkey,
    "",
    "URI: https://" + AUTH_DOMAIN,
    "Version: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/**
 * A wallet address: on the ed25519 curve, so something can sign for it. The curve test is the point
 * here — it rejects a PDA, which no one holds a key for. Never use it on a program address.
 */
export function isValidSolanaPubkey(pubkey: string): boolean {
  try {
    const key = new PublicKey(pubkey);
    return PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

/**
 * Any 32-byte account address, wallet or PDA. Program addresses are derived by searching for a
 * bump that lands OFF the curve, so `isValidSolanaPubkey` rejects every one of them by design —
 * use this for seat/table/vault PDAs.
 */
export function isValidAccountAddress(address: string): boolean {
  try {
    return new PublicKey(address).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * Verify an ed25519 detached signature over the UTF-8 message bytes.
 * Accepts signature as base58 or standard base64.
 */
export function verifySignInSignature(
  pubkey: string,
  message: string,
  signatureEncoded: string
): boolean {
  try {
    const publicKey = new PublicKey(pubkey);
    const messageBytes = new TextEncoder().encode(message);
    const signature = decodeSignature(signatureEncoded);
    if (signature.length !== 64) return false;
    return nacl.sign.detached.verify(messageBytes, signature, publicKey.toBytes());
  } catch {
    return false;
  }
}

function decodeSignature(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  try {
    return bs58.decode(trimmed);
  } catch {
    return Uint8Array.from(Buffer.from(trimmed, "base64"));
  }
}
