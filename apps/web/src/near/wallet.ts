/**
 * The player's NEAR wallet, through NEAR Connect (@hot-labs/near-connect, the wallet connector NEAR's docs recommend).
 * NEAR Connect loads on first use, so the game's first screen stays light. Testnet in this fork.
 */
import type { NearConnector } from '@hot-labs/near-connect';

export const NEAR_NETWORK = 'testnet' as const;

/** What NEAR sign-in needs from a wallet (account/session.ts): the account, and a NEP-413 signed message. */
export interface NearSigner {
  /** Connects (showing the wallet picker if needed). The account id, or null when the player backs out. */
  connect(): Promise<string | null>;
  /** NEP-413 `signMessage`: the wallet signs the exact message, recipient and 32-byte nonce. */
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ accountId: string; publicKey: string; signature: string }>;
}

let connector: Promise<NearConnector> | null = null;

function load(): Promise<NearConnector> {
  connector ??= import('@hot-labs/near-connect').then(({ NearConnector }) => new NearConnector({ network: NEAR_NETWORK }));
  connector.catch(() => (connector = null));
  return connector;
}

/** The connected account id, or null. Never opens the picker. */
export async function nearAccount(): Promise<string | null> {
  try {
    const w = await (await load()).wallet();
    return (await w.getAccounts())[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

export const nearSigner: NearSigner = {
  async connect() {
    const c = await load();
    try {
      const w = await c.connect();
      return (await w.getAccounts())[0]?.accountId ?? null;
    } catch (e) {
      // Closing the picker rejects: that's a cancel, not an error.
      if (/cancel|closed|reject|abort/i.test(String((e as Error)?.message ?? e))) return null;
      throw e;
    }
  },
  async signMessage(p) {
    const w = await (await load()).wallet();
    const signed = await w.signMessage({ message: p.message, recipient: p.recipient, nonce: p.nonce, network: NEAR_NETWORK });
    return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature };
  },
};

/** Calls a contract method through the player's wallet (connecting first if needed). `deposit` is in yoctoNEAR. */
export async function nearCall(contractId: string, methodName: string, args: Record<string, unknown>, deposit = 0n, tgas = 50n): Promise<void> {
  const c = await load();
  const w = await c.wallet().catch(() => c.connect());
  await w.signAndSendTransaction({
    receiverId: contractId,
    actions: [{ type: 'FunctionCall', params: { methodName, args, gas: String(tgas * 10n ** 12n), deposit: String(deposit) } }],
  });
}

export async function nearSignOut(): Promise<void> {
  if (!connector) return;
  try {
    const c = await connector;
    await c.disconnect(await c.wallet());
  } catch {
    /* nothing connected */
  }
}
