import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Routes } from '@nomad/contract';
import { decodeSignedDelegate, fromBase64, parsePublicKey, TGAS, verifyDelegate } from '@nomad/contract/near';
import { backupJson, createNearAccount, loadLocalKey, localSigner, nep413Hash, pendingKey, relayCall, restoreBackup, setLocalAccount, type SessionLike } from '../localKey';
import { nearCall, nearRoute } from '../wallet';

class MemoryStorage {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

/** NEP-413's hash written out independently: sha256(u32le(2^31+413) ‖ borsh payload with no callback). */
async function referenceNep413(message: string, nonce: Uint8Array, recipient: string): Promise<Uint8Array> {
  const s = (t: string) => {
    const b = new TextEncoder().encode(t);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, true);
    return [...len, ...b];
  };
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2 ** 31 + 413, true);
  const bytes = Uint8Array.from([...tag, ...s(message), ...nonce, ...s(recipient), 0]);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function verify(publicKey: string, signature: Uint8Array, hash: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', parsePublicKey(publicKey)!, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signature, hash);
}

describe('the key kept in this browser', () => {
  it('makes a key once and reuses it until the API made its account', () => {
    const a = pendingKey();
    expect(a.accountId).toBeNull();
    expect(a.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(pendingKey().secretKey).toBe(a.secretKey);
    setLocalAccount('abcdefghij.nomad-players.testnet');
    expect(loadLocalKey()).toEqual({ ...a, accountId: 'abcdefghij.nomad-players.testnet' });
    // With an account, a new account request gets a new key (never re-sends a used one).
    expect(pendingKey().secretKey).not.toBe(a.secretKey);
  });

  it('signs NEP-413 sign-in messages that check out against the key', async () => {
    const k = setLocalAccount('abcdefghij.nomad-players.testnet', (pendingKey(), storage));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const message = 'Sign in to Nomad Poker as abcdefghij.nomad-players.testnet.';
    expect([...nep413Hash(message, nonce, 'localhost:5180')]).toEqual([...(await referenceNep413(message, nonce, 'localhost:5180'))]);
    const signer = localSigner(k);
    expect(await signer.connect()).toBe(k.accountId);
    const signed = await signer.signMessage({ message, recipient: 'localhost:5180', nonce });
    expect(signed).toMatchObject({ accountId: k.accountId, publicKey: k.publicKey });
    expect(await verify(k.publicKey, fromBase64(signed.signature)!, await referenceNep413(message, nonce, 'localhost:5180'))).toBe(true);
  });

  it('backs up as near-cli JSON and restores from it; refuses garbage and a damaged key', () => {
    pendingKey();
    const k = setLocalAccount('abcdefghij.nomad-players.testnet');
    const json = backupJson(k);
    expect(JSON.parse(json)).toEqual({ account_id: k.accountId, public_key: k.publicKey, private_key: k.secretKey });
    storage.m.clear();
    expect(restoreBackup(json)).toEqual(k);
    expect(loadLocalKey()).toEqual(k);
    expect(() => restoreBackup('hello')).toThrow(/whole backup/);
    expect(() => restoreBackup('{"account_id":"a.testnet","private_key":"ed25519:abc"}')).toThrow(/isn't a NEAR key/);
    const other = (storage.m.clear(), pendingKey());
    const damaged = JSON.stringify({ account_id: 'a.testnet', private_key: `${k.secretKey.slice(0, 20)}${other.secretKey.slice(20)}` });
    expect(() => restoreBackup(damaged)).toThrow();
  });
});

describe('moves through the relayer', () => {
  const rpc = (nonce: number, height = 5000) =>
    (async <T,>(method: string) => (method === 'block' ? { header: { height } } : { nonce, permission: 'FullAccess' }) as T) as <T>(m: string, p: unknown) => Promise<T>;

  it('signs a delegate action with the next nonce, valid ~5 minutes, that verifies', async () => {
    pendingKey();
    const k = setLocalAccount('abcdefghij.nomad-players.testnet');
    const sent: string[] = [];
    const send = async (b64: string) => (sent.push(b64), { txHash: 'h', value: null });
    await relayCall(k, send, 'nomad-escrow.testnet', 'buy_in', { table_id: 'poker-money-st50', amount: '50000000000000000000000' }, 10n ** 22n, 30n, rpc(41));
    const d = decodeSignedDelegate(fromBase64(sent[0]!)!);
    expect(await verifyDelegate(d)).toBe(true);
    expect(d.delegate).toMatchObject({ senderId: k.accountId, receiverId: 'nomad-escrow.testnet', nonce: 42n, maxBlockHeight: 5300n });
    const a = d.delegate.actions[0]!;
    expect(a.type).toBe('FunctionCall');
    if (a.type !== 'FunctionCall') return;
    expect(a).toMatchObject({ methodName: 'buy_in', gas: 30n * TGAS, deposit: 10n ** 22n });
    expect(JSON.parse(new TextDecoder().decode(a.args))).toEqual({ table_id: 'poker-money-st50', amount: '50000000000000000000000' });
    // A second move before the node shows the first one's nonce still gets a fresh nonce.
    await relayCall(k, send, 'nomad-escrow.testnet', 'withdraw', { amount: '1' }, 0n, 50n, rpc(41));
    expect(decodeSignedDelegate(fromBase64(sent[1]!)!).delegate.nonce).toBe(43n);
  });

  it('nearCall goes through the relayer only when you play as the account kept here', async () => {
    pendingKey();
    const k = setLocalAccount('abcdefghij.nomad-players.testnet');
    const relayed: string[] = [];
    nearRoute.relay = async (b64) => (relayed.push(b64), { txHash: 'h', value: null });
    nearRoute.identity = () => k.accountId;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      const result = method === 'block' ? { header: { height: 10 } } : { nonce: 7, permission: 'FullAccess' };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result }));
    });
    await nearCall('nomad-escrow.testnet', 'deposit', {}, 5n, 30n);
    expect(relayed).toHaveLength(1);
    expect(decodeSignedDelegate(fromBase64(relayed[0]!)!).delegate.senderId).toBe(k.accountId);
    nearRoute.identity = () => null;
    nearRoute.relay = null;
  });
});

describe('Create my NEAR account', () => {
  it('sends the public key, keeps the account it gets back, and signs in with that key', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const session: SessionLike = {
      signedIn: false,
      error: null,
      call: async <T,>(_m: string, path: string, body?: unknown) => {
        calls.push({ path, body });
        return { accountId: 'qwertyuiop.nomad-players.testnet', funded: '1', txHash: 't' } as T;
      },
      near: async (signer) => {
        expect(await signer.connect()).toBe('qwertyuiop.nomad-players.testnet');
        const s = await signer.signMessage({ message: 'm', recipient: 'r', nonce: new Uint8Array(32) });
        session.signedIn = await verify(s.publicKey, fromBase64(s.signature)!, nep413Hash('m', new Uint8Array(32), 'r'));
      },
    };
    const k = await createNearAccount(session);
    expect(calls).toEqual([{ path: Routes.nearAccount, body: { publicKey: k.publicKey } }]);
    expect(session.signedIn).toBe(true);
    expect(loadLocalKey()?.accountId).toBe('qwertyuiop.nomad-players.testnet');
  });

  it('keeps the unused key when the API fails, and offers it again', async () => {
    const session: SessionLike = { signedIn: true, error: null, call: async () => Promise.reject(new Error('down')), near: async () => undefined };
    await expect(createNearAccount(session)).rejects.toThrow('down');
    const k = loadLocalKey()!;
    expect(k.accountId).toBeNull();
    expect(pendingKey().publicKey).toBe(k.publicKey);
  });
});
