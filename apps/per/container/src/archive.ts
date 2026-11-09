// Archived action logs hold every bet, so they're stored encrypted (AES-256-GCM, a fresh nonce per
// log, the table and hand number as associated data so a log can't be swapped onto another hand).
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "./config";

// Layout: version (1 byte) | nonce (12) | tag (16) | ciphertext. Version 1 = this key and scheme;
// a key rotation adds version 2 next to it. Logs sealed before the version byte existed (the
// first M7 deploys) are read as version 0.
const VERSION = 1;
const aad = (table: string, handNo: string) => Buffer.from(`${table}/${BigInt(handNo).toString()}`);

export function seal(table: string, handNo: string, plain: object): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.archiveKey, iv, { authTagLength: 16 });
  c.setAAD(aad(table, handNo));
  const body = Buffer.concat([c.update(JSON.stringify(plain)), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
}

export function open(table: string, handNo: string, sealed: Buffer): any {
  const at = sealed[0] === VERSION ? 1 : 0;
  try { return decrypt(table, handNo, sealed.subarray(at)); }
  catch (e) { if (at) return decrypt(table, handNo, sealed); throw e; } // a version-0 log whose nonce began with 0x01
}

function decrypt(table: string, handNo: string, s: Buffer) {
  const d = createDecipheriv("aes-256-gcm", config.archiveKey, s.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(aad(table, handNo));
  d.setAuthTag(s.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(s.subarray(28)), d.final()]).toString());
}
