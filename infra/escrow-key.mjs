#!/usr/bin/env node
/**
 * The game server's escrow settlement key (docs/phase-6-design.md), devnet only.
 *
 *   node infra/escrow-key.mjs <stage> create     generate a key into apps/game-server/.secrets.<stage>.json (git-ignored)
 *   node infra/escrow-key.mjs <stage> show       print its public key and devnet balance
 *   node infra/escrow-key.mjs <stage> airdrop N  ask the devnet faucet for N SOL (often rate-limited; the web faucet
 *                                                at faucet.solana.com is the fallback)
 *
 * The secret only ever lives in that file and in the Worker's secrets (deploy:<stage> uploads the file). It is never
 * printed. Refuses to run against anything but devnet.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';

const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (!/devnet/.test(RPC)) throw new Error('devnet only');

const [stage, cmd, arg] = process.argv.slice(2);
if (!stage || !cmd) {
  console.error('usage: node infra/escrow-key.mjs <stage> create|show|airdrop <sol>');
  process.exit(2);
}
const file = fileURLToPath(new URL(`../apps/game-server/.secrets.${stage}.json`, import.meta.url));
const secrets = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
function unb58(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

const rpc = async (method, params) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const pubkeyOf = () => {
  if (!secrets.ESCROW_AUTHORITY_SECRET) throw new Error(`no key in ${file}; run create first`);
  return b58(unb58(secrets.ESCROW_AUTHORITY_SECRET).slice(32));
};

if (cmd === 'create') {
  if (secrets.ESCROW_AUTHORITY_SECRET) throw new Error(`a key already exists in ${file} (${pubkeyOf()}); refusing to replace it`);
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pkcs8.slice(-32), 0); // the 32-byte seed ends the PKCS#8 document
  secret.set(raw, 32);
  secrets.ESCROW_AUTHORITY_SECRET = b58(secret);
  writeFileSync(file, JSON.stringify(secrets, null, 2) + '\n');
  console.log(`created ${pubkeyOf()} in ${file}`);
} else if (cmd === 'show') {
  const pk = pubkeyOf();
  console.log(pk, (await rpc('getBalance', [pk, { commitment: 'confirmed' }])).value / 1e9, 'SOL');
} else if (cmd === 'airdrop') {
  const pk = pubkeyOf();
  const sol = Number(arg || 1);
  const sig = await rpc('requestAirdrop', [pk, Math.round(sol * 1e9)]);
  console.log('airdrop', sig);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
  }
  console.log(pk, (await rpc('getBalance', [pk, { commitment: 'confirmed' }])).value / 1e9, 'SOL');
} else throw new Error(`unknown command ${cmd}`);
