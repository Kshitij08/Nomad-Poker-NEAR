// Decodes the saved v1 config bytes and the live config field by field, to check that migration
// preserved every v1 field. Raw-byte comparison is wrong here: `pending_admin: Option<Pubkey>`
// serializes to 1 byte when None and 33 when Some, and Anchor does not zero the bytes after the
// serialized data, so a v1 account that once had a pending admin carries stale bytes at its tail.
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { connection, CONFIG_PDA } from "./lib";

function decode(buf: Buffer, withReserved: boolean) {
  let o = 8;
  const version = buf[o++], bump = buf[o++];
  const admin = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const hasPending = buf[o++] === 1;
  let pendingAdmin: string | null = null;
  if (hasPending) { pendingAdmin = new PublicKey(buf.subarray(o, o + 32)).toBase58(); o += 32; }
  const devWallet = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const rakeBps = buf.readUInt16LE(o); o += 2;
  const maxBuyIn = buf.readBigUInt64LE(o).toString(); o += 8;
  const paused = buf[o++] === 1;
  let reservedAllZero: boolean | null = null;
  if (withReserved) { reservedAllZero = buf.subarray(o, o + 128).every((b) => b === 0); o += 128; }
  const tail = buf.subarray(o);
  return { fields: { version, bump, admin: admin.toBase58(), pendingAdmin, devWallet: devWallet.toBase58(), rakeBps, maxBuyIn, paused }, reservedAllZero, serializedLen: o, slackLen: tail.length, slackHex: tail.toString("hex") };
}

async function main() {
  const dir = path.join(__dirname, "../results");
  const file = fs.readdirSync(dir).filter((f) => f.startsWith("m1-migrate-")).sort().pop()!;
  const snap = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const old = decode(Buffer.from(snap.v1Snapshot.hex, "hex"), false);
  const now = decode((await connection.getAccountInfo(CONFIG_PDA))!.data, true);
  const same = (["bump", "admin", "pendingAdmin", "devWallet", "rakeBps", "maxBuyIn", "paused"] as const)
    .every((k) => JSON.stringify((old.fields as any)[k]) === JSON.stringify((now.fields as any)[k]));
  const result = { snapshotFile: file, v1: old, v2: now, v1FieldsPreserved: same, versionBumped: old.fields.version === 1 && now.fields.version === 2 };
  fs.writeFileSync(path.join(dir, `m1-migrate-verify-${Date.now()}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(same && result.versionBumped && now.reservedAllZero ? 0 : 1);
}
main();
