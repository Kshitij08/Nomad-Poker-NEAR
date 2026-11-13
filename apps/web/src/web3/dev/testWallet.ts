/**
 * DEV ONLY — a devnet test wallet for exercising the SOL flows on localhost without a browser extension.
 *
 * It registers itself through the Wallet Standard (so the game's wallet picker lists it like Phantom) and signs with
 * a fresh ed25519 keypair generated in this browser and kept in localStorage under DEV_KEY. It is impossible to
 * reach in production:
 *  - web3/install.ts imports this file dynamically only inside `if (import.meta.env.DEV)`, so production builds
 *    don't contain it;
 *  - `testWalletAllowed` additionally requires localhost / 127.0.0.1 and the `?testwallet=1` flag;
 *  - it only ever talks to devnet and refuses any mainnet RPC.
 * The secret key is never logged or shown; "Forget test wallet" deletes it.
 */
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

export const DEV_KEY = 'nomad.dev.testWallet.devnetSecret';
const FLAG_KEY = 'nomad.dev.testWallet.on';
export const TEST_WALLET_NAME = 'Nomad Test Wallet (devnet)';
const DEVNET_RPC = 'https://api.devnet.solana.com';
export const FAUCET_URL = 'https://faucet.solana.com';

/** Whether the test wallet may run here: dev build, localhost, and the ?testwallet=1 flag (remembered per tab). */
export function testWalletAllowed(dev: boolean, hostname: string, search: string, remembered = false): boolean {
  if (!dev) return false;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return false;
  return /[?&]testwallet=1\b/.test(search) || remembered;
}

/** Refuses anything that isn't devnet. */
export function assertDevnetRpc(url: string): void {
  if (!/devnet/i.test(url) || /mainnet/i.test(url)) throw new Error('The test wallet only works on Solana devnet.');
}

/**
 * The key comes from VITE_DEV_TEST_WALLET_SECRET (base58 32-byte seed) in a git-ignored `.env.development.local`
 * when set, so a funded test wallet survives browser storage resets (cleared site data lost a funded key once).
 * Otherwise from localStorage, else a fresh one.
 */
function loadSecret(): Uint8Array {
  const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DEV_TEST_WALLET_SECRET;
  if (fromEnv) {
    try {
      const b = bs58.decode(fromEnv.trim());
      if (b.length === 32) return b;
    } catch {
      /* ignore a malformed value: fall back below */
    }
  }
  try {
    const saved = localStorage.getItem(DEV_KEY);
    if (saved) {
      const b = bs58.decode(saved);
      if (b.length === 32) return b;
    }
  } catch {
    /* fall through to a new key */
  }
  const fresh = ed25519.utils.randomPrivateKey();
  try {
    localStorage.setItem(DEV_KEY, bs58.encode(fresh));
  } catch {
    /* session-only key */
  }
  return fresh;
}

/** compact-u16 (shortvec) decode → [value, bytes read]. */
function shortvec(b: Uint8Array, at: number): [number, number] {
  let len = 0;
  let size = 0;
  for (;;) {
    const elem = b[at + size]!;
    len |= (elem & 0x7f) << (size * 7);
    size++;
    if ((elem & 0x80) === 0) break;
  }
  return [len, size];
}

/** Signs a serialized legacy or v0 transaction in place for `pubkey`. */
export function signSerializedTx(tx: Uint8Array, secret: Uint8Array, pubkey: Uint8Array): Uint8Array {
  const out = tx.slice();
  const [numSigs, sigLen] = shortvec(out, 0);
  const msgStart = sigLen + numSigs * 64;
  const msg = out.subarray(msgStart);
  const headerAt = msg[0]! & 0x80 ? 1 : 0; // versioned messages start with a 0x80|version prefix
  const numRequired = msg[headerAt]!;
  const [numKeys, keysLen] = shortvec(msg, headerAt + 3);
  const keysAt = headerAt + 3 + keysLen;
  let index = -1;
  for (let i = 0; i < Math.min(numKeys, numRequired); i++) {
    const k = msg.subarray(keysAt + i * 32, keysAt + (i + 1) * 32);
    if (k.every((v, j) => v === pubkey[j])) {
      index = i;
      break;
    }
  }
  if (index < 0 || index >= numSigs) throw new Error('This transaction does not need the test wallet’s signature.');
  const sig = ed25519.sign(msg, secret);
  out.set(sig, sigLen + index * 64);
  return out;
}

interface StdAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}

/** The Wallet Standard wallet object. */
function makeWallet(secret: Uint8Array) {
  const publicKey = ed25519.getPublicKey(secret);
  const address = bs58.encode(publicKey);
  const account: StdAccount = Object.freeze({
    address,
    publicKey,
    chains: ['solana:devnet'],
    features: ['solana:signTransaction', 'solana:signMessage'],
  });
  let connected = false;
  const icon =
    'data:image/svg+xml;base64,' +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#6a35e0"/><text x="24" y="31" font-size="18" font-family="sans-serif" font-weight="900" text-anchor="middle" fill="#ffe36b">DEV</text></svg>');
  const wallet = {
    version: '1.0.0',
    name: TEST_WALLET_NAME,
    icon,
    chains: ['solana:devnet'] as const,
    get accounts() {
      return connected ? [account] : [];
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          connected = true;
          return { accounts: [account] };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          connected = false;
        },
      },
      'standard:events': { version: '1.0.0', on: () => () => undefined },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { transaction: Uint8Array; chain?: string }[]) =>
          inputs.map((i) => {
            if (i.chain && i.chain !== 'solana:devnet') throw new Error('The test wallet only signs on devnet.');
            return { signedTransaction: signSerializedTx(i.transaction, secret, publicKey) };
          }),
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          inputs.map((i) => ({ signedMessage: i.message, signature: ed25519.sign(i.message, secret) })),
      },
    },
  };
  return { wallet, address };
}

/** Asks devnet for 1 SOL. Returns the signature, or throws a player-readable message (rate limits are common). */
export async function airdrop(address: string, rpc = DEVNET_RPC, lamports = 1_000_000_000): Promise<string> {
  assertDevnetRpc(rpc);
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [address, lamports] }),
  });
  const j = (await res.json().catch(() => ({}))) as { result?: string; error?: { message?: string } };
  if (j.result) return j.result;
  const m = j.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 410 || /faucet is closed/i.test(m))
    throw new Error(`Devnet's RPC airdrop is closed. Get test SOL at ${FAUCET_URL} for ${address} (or send devnet SOL from another devnet wallet), then refresh the balance.`);
  if (res.status === 429 || /rate|limit|faucet|airdrop/i.test(m))
    throw new Error(`Devnet's airdrop is rate-limited right now. Use ${FAUCET_URL} with the address ${address}, then refresh the balance.`);
  throw new Error(`Airdrop failed: ${m}`);
}

export async function devnetBalance(address: string, rpc = DEVNET_RPC): Promise<number> {
  assertDevnetRpc(rpc);
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
  });
  const j = (await res.json()) as { result?: { value: number } };
  return (j.result?.value ?? 0) / 1e9;
}

/** Registers the wallet (Wallet Standard) and adds a small dev panel: address, balance, airdrop, forget. */
export function maybeInstallTestWallet(dev: boolean): boolean {
  if (typeof window === 'undefined') return false;
  let remembered = false;
  try {
    remembered = sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {
    /* no storage */
  }
  if (!testWalletAllowed(dev, location.hostname, location.search, remembered)) return false;
  try {
    sessionStorage.setItem(FLAG_KEY, '1');
  } catch {
    /* ignore */
  }
  const { wallet, address } = makeWallet(loadSecret());
  const register = (api: { register(w: unknown): unknown }) => api.register(wallet);
  window.addEventListener('wallet-standard:app-ready', ((e: CustomEvent<{ register(w: unknown): unknown }>) => register(e.detail)) as EventListener);
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  mountPanel(address);
  return true;
}

function mountPanel(address: string): void {
  const el = document.createElement('div');
  el.setAttribute('data-dev-test-wallet', '');
  el.dataset.address = address; // the public address only
  el.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:2500;font:600 12px/1.3 Nunito,system-ui,sans-serif;color:#fff;background:rgba(14,10,48,.92);border:1px dashed #ffd54a;border-radius:10px;padding:8px 10px;max-width:260px;display:flex;flex-direction:column;gap:6px';
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  el.innerHTML = `<b style="color:#ffd54a">DEV · test wallet (devnet)</b><span>Address ${short} <button data-copy style="font:inherit;color:#9cf;background:none;border:0;cursor:pointer;padding:0">copy</button></span><span data-bal>Balance …</span><span style="display:flex;gap:6px"><button data-air style="font:inherit;cursor:pointer;border-radius:6px;border:0;padding:4px 8px;background:#ffd54a;color:#3a2200">Airdrop 1 devnet SOL</button><button data-refresh style="font:inherit;cursor:pointer;border-radius:6px;border:1px solid #4b3fa6;padding:4px 8px;background:none;color:#fff">Refresh</button><button data-hide style="font:inherit;cursor:pointer;border-radius:6px;border:1px solid #4b3fa6;padding:4px 8px;background:none;color:#fff">Hide</button></span><span data-msg style="color:#b9b3e6"></span>`;
  document.body.append(el);
  const bal = el.querySelector<HTMLElement>('[data-bal]')!;
  const msg = el.querySelector<HTMLElement>('[data-msg]')!;
  const refresh = () => devnetBalance(address).then((b) => (bal.textContent = `Balance ◎ ${b.toFixed(4)} (devnet)`), () => (bal.textContent = 'Balance unavailable'));
  void refresh();
  el.querySelector('[data-copy]')!.addEventListener('click', () => void navigator.clipboard?.writeText(address).catch(() => undefined));
  el.querySelector('[data-hide]')!.addEventListener('click', () => el.remove());
  el.querySelector('[data-refresh]')!.addEventListener('click', () => void refresh());
  el.querySelector('[data-air]')!.addEventListener('click', async () => {
    msg.textContent = 'Requesting airdrop…';
    try {
      const sig = await airdrop(address);
      msg.textContent = `Airdrop sent (${sig.slice(0, 8)}…). Balance updates in a few seconds.`;
      setTimeout(() => void refresh(), 4000);
      setTimeout(() => void refresh(), 12000);
    } catch (e) {
      msg.textContent = (e as Error).message;
    }
  });
}
