import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { assertDevnetRpc, signSerializedTx, testWalletAllowed } from '../dev/testWallet';

describe('dev test wallet gate', () => {
  it('refuses production builds', () => {
    expect(testWalletAllowed(false, 'localhost', '?testwallet=1')).toBe(false);
    expect(testWalletAllowed(false, 'localhost', '', true)).toBe(false);
  });
  it('refuses any host but localhost / 127.0.0.1', () => {
    expect(testWalletAllowed(true, 'nomad-poker-web.vercel.app', '?testwallet=1')).toBe(false);
    expect(testWalletAllowed(true, 'staging.example.com', '?testwallet=1', true)).toBe(false);
    expect(testWalletAllowed(true, '192.168.1.5', '?testwallet=1')).toBe(false);
  });
  it('needs the flag (or a remembered flag in this tab)', () => {
    expect(testWalletAllowed(true, 'localhost', '')).toBe(false);
    expect(testWalletAllowed(true, 'localhost', '?testwallet=1')).toBe(true);
    expect(testWalletAllowed(true, '127.0.0.1', '?a=1&testwallet=1')).toBe(true);
    expect(testWalletAllowed(true, 'localhost', '', true)).toBe(true);
  });
  it('refuses mainnet RPC', () => {
    expect(() => assertDevnetRpc('https://api.mainnet-beta.solana.com')).toThrow();
    expect(() => assertDevnetRpc('https://api.devnet.solana.com')).not.toThrow();
  });
});

describe('signSerializedTx', () => {
  it('puts a valid signature in the signer slot of a legacy transaction', () => {
    const secret = ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(secret);
    const other = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
    // message: header [2 required, 0, 1], 3 keys (other, pub, program), blockhash, 0 instructions
    const msg = new Uint8Array([2, 0, 1, 3, ...other, ...pub, ...new Uint8Array(32), ...new Uint8Array(32), 0]);
    const tx = new Uint8Array([2, ...new Uint8Array(128), ...msg]);
    const signed = signSerializedTx(tx, secret, pub);
    const sig = signed.subarray(1 + 64, 1 + 128);
    expect(ed25519.verify(sig, msg, pub)).toBe(true);
    expect(signed.subarray(1, 65).every((b) => b === 0)).toBe(true);
  });
  it('refuses a transaction it is not a signer of', () => {
    const secret = ed25519.utils.randomPrivateKey();
    const pub = ed25519.getPublicKey(secret);
    const other = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
    const msg = new Uint8Array([1, 0, 0, 1, ...other, ...new Uint8Array(32), 0]);
    const tx = new Uint8Array([1, ...new Uint8Array(64), ...msg]);
    expect(() => signSerializedTx(tx, secret, pub)).toThrow();
  });
});
