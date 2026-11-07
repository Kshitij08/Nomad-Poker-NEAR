/**
 * The browser's private-table keys. Ports of Per/Unity/PerPlatform.cs PerSecrets + PerSessionKeys and
 * Plugins/WebGL/PerKeys.jslib:
 *  - PerSecrets seals secrets before they go into PlayerPrefs with one NON-EXTRACTABLE WebCrypto AES-GCM key per
 *    site, kept in IndexedDB ("nomad-per-keys"/"k"/"aes", the same store the WebGL build uses). Sealed values start
 *    with "enc1:"; anything else is a value saved before (read as is, sealed on the next save).
 *  - PerSessionKeys: the per-table session key (signs the seat's routine transactions and is the seat's reader),
 *    one per wallet and table, in PlayerPrefs "per.session.<wallet>.<table>", so a reload resumes the seat.
 */
import { Keypair, type PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PlayerPrefs } from '../../app/services';
import { fromBase64, toBase64 } from '../lib/bytes';

const PREFIX = 'enc1:';
let siteKey: Promise<CryptoKey> | null = null;

function getSiteKey(): Promise<CryptoKey> {
  if (siteKey) return siteKey;
  siteKey = new Promise<CryptoKey>((resolve, reject) => {
    const open = indexedDB.open('nomad-per-keys', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('k');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = (then: (k: CryptoKey | undefined) => void) => {
        const get = db.transaction('k', 'readonly').objectStore('k').get('aes');
        get.onsuccess = () => then(get.result as CryptoKey | undefined);
        get.onerror = () => reject(get.error);
      };
      read((found) => {
        if (found) return resolve(found);
        crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']).then((key) => {
          const tx = db.transaction('k', 'readwrite');
          const add = tx.objectStore('k').add(key, 'aes'); // `add`: two tabs can't replace each other's key
          add.onerror = (e) => e.preventDefault();
          tx.oncomplete = () => resolve(key);
          tx.onerror = tx.onabort = () => read((k) => (k ? resolve(k) : reject(tx.error)));
        }, reject);
      });
    };
  });
  siteKey.catch(() => (siteKey = null));
  return siteKey;
}

export const PerSecrets = {
  isSealed: (stored: string | null | undefined): boolean => !!stored && stored.startsWith(PREFIX),

  /** The value to store. Falls back to the plain value if the browser can't seal (logged). */
  async seal(plain: string): Promise<string> {
    try {
      const key = await getSiteKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0);
      out.set(ct, 12);
      return PREFIX + toBase64(out);
    } catch (e) {
      console.warn("[PerSecrets] couldn't seal, storing as before:", (e as Error).message ?? e);
      return plain;
    }
  },

  /** The stored value opened. Throws if a sealed value can't be opened (its key is gone). */
  async open(stored: string): Promise<string> {
    if (!PerSecrets.isSealed(stored)) return stored;
    const key = await getSiteKey();
    const all = fromBase64(stored.slice(PREFIX.length));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12));
    return new TextDecoder().decode(pt);
  },
};

/** A Keypair from a stored base58 secret: 32-byte seed (the C# saves PrivateKey.KeyBytes) or 64-byte secret key. */
export function keypairFromStored(b58: string): Keypair {
  const bytes = bs58.decode(b58);
  return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
}

/** What the C# stores for a key: Account.PrivateKey.KeyBytes in base58 (Solana.Unity: the 64-byte secret key). */
export const keypairToStored = (k: Keypair): string => bs58.encode(k.secretKey);

export const PerSessionKeys = {
  pref: (wallet: PublicKey, table: PublicKey) => `per.session.${wallet.toBase58()}.${table.toBase58()}`,

  async forKey(wallet: PublicKey, table: PublicKey): Promise<Keypair> {
    const saved = PlayerPrefs.getString(PerSessionKeys.pref(wallet, table), '');
    if (saved) {
      try {
        const known = keypairFromStored(await PerSecrets.open(saved));
        if (!PerSecrets.isSealed(saved)) await save(wallet, table, known); // saved before sealing: seal it now
        return known;
      } catch (e) {
        // Unreadable (the browser's key store was cleared): a new key; Join cashes the old seat out.
        console.warn('[PerSessionKeys] saved table key unreadable, using a new one:', (e as Error).message ?? e);
      }
    }
    const fresh = Keypair.generate();
    await save(wallet, table, fresh);
    return fresh;
  },

  /** Forget it once the seat is cashed out (a new sit-down gets a new key). */
  forget(wallet: PublicKey, table: PublicKey): void {
    PlayerPrefs.deleteKey(PerSessionKeys.pref(wallet, table));
  },
};

async function save(wallet: PublicKey, table: PublicKey, key: Keypair): Promise<void> {
  PlayerPrefs.setString(PerSessionKeys.pref(wallet, table), await PerSecrets.seal(keypairToStored(key)));
}
