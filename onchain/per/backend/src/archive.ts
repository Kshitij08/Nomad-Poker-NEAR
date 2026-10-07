// Archived action logs hold every bet, so they're stored encrypted (AES-256-GCM, a fresh nonce per
// log, the table and hand number as associated data so a log can't be swapped onto another hand).
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "./config";

const aad = (table: string, handNo: string) => Buffer.from(`${table}/${handNo}`);

export function seal(table: string, handNo: string, plain: object): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.archiveKey, iv);
  c.setAAD(aad(table, handNo));
  const body = Buffer.concat([c.update(JSON.stringify(plain)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function open(table: string, handNo: string, sealed: Buffer): any {
  const d = createDecipheriv("aes-256-gcm", config.archiveKey, sealed.subarray(0, 12));
  d.setAAD(aad(table, handNo));
  d.setAuthTag(sealed.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString());
}
