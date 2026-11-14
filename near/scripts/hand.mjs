// Player-side helper for the test dealer (Node 20+, no dependencies).
//   node hand.mjs keygen                 -> a new X25519 key pair (hex); give the public key to deal()
//   node hand.mjs open <sk> <eph> <ct>   -> the two hole cards the dealer sealed for that key
import { createHash, createPrivateKey, createPublicKey, diffieHellman, createDecipheriv, generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";

const hex = (b) => Buffer.from(b).toString("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (...parts) => parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();
const cardName = (c) => "23456789TJQKA"[c >> 2] + "cdhs"[c & 3];

const publicFromRaw = (raw) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64u(raw) }, format: "jwk" });
function privateFromRaw(raw) {
  // PKCS#8 wrapper for a raw X25519 secret key.
  const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), raw]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}
const rawPublic = (keyObject) => Buffer.from(keyObject.export({ format: "jwk" }).x, "base64url");

export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { sk: hex(Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url")), pk: hex(rawPublic(publicKey)) };
}

export function open(skHex, ephHex, ctHex) {
  const sk = privateFromRaw(Buffer.from(skHex, "hex"));
  const pk = rawPublic(createPublicKey(sk));
  const eph = Buffer.from(ephHex, "hex");
  const shared = diffieHellman({ privateKey: sk, publicKey: publicFromRaw(eph) });
  const key = sha("nomad-hole-key:", shared, eph, pk);
  const ct = Buffer.from(ctHex, "hex");
  const d = createDecipheriv("chacha20-poly1305", key, Buffer.alloc(12), { authTagLength: 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  const cards = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return [...cards].map(cardName);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "keygen") console.log(JSON.stringify(keygen()));
  else if (cmd === "open" && args.length === 3) console.log(JSON.stringify(open(...args)));
  else {
    console.error("usage: hand.mjs keygen | open <sk> <eph> <ct>");
    process.exit(1);
  }
}
