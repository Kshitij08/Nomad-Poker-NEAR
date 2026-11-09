import { EscrowClient } from '@nomad/chain/escrowClient';
import { ESCROW_PROGRAM_ID } from '@nomad/chain/escrow';
import { SolanaRpc } from '@nomad/chain/rpc';
import { signerFromSecret } from '@nomad/chain/transaction';
import type { Env } from './env';

const DEVNET = 'https://api.devnet.solana.com';

/** SOL tables are on: the stage switches them on and a settlement key is configured. */
export function moneyTablesOn(env: Env): boolean {
  return env.MONEY_TABLES === '1' && !!env.ESCROW_AUTHORITY_SECRET;
}

let cached: { secret: string; client: Promise<EscrowClient> } | null = null;

/** The game server's escrow client (one per isolate), or null when SOL tables are off. */
export function escrowClient(env: Env, log: (level: 'info' | 'warn' | 'error', m: string) => void = () => {}): Promise<EscrowClient> | null {
  if (!moneyTablesOn(env)) return null;
  const secret = env.ESCROW_AUTHORITY_SECRET!;
  if (cached?.secret !== secret) {
    const client = (async () => new EscrowClient(new SolanaRpc(env.SOLANA_RPC_URL || DEVNET), await signerFromSecret(secret), { log }))();
    cached = { secret, client };
    client.catch(() => {
      if (cached?.client === client) cached = null; // a bad secret: try again next time, and say so each time
    });
  }
  return cached.client;
}

/** GET /v1/chain/config: what the web client needs to buy in at a SOL table (no secrets). */
export async function chainConfig(env: Env): Promise<Record<string, unknown>> {
  const client = escrowClient(env);
  if (!client) return { moneyTables: false, programId: ESCROW_PROGRAM_ID, rpcUrl: DEVNET, cluster: 'devnet' };
  const c = await client;
  // The key's balance (it pays table rent and fees); null with the reason when the RPC can't be reached.
  let authorityLamports: number | null = null;
  let rpcError: string | undefined;
  try {
    authorityLamports = await c.rpc.balance(c.authority);
  } catch (e) {
    rpcError = (e as Error).message.slice(0, 300);
  }
  // rpcUrl is the public devnet endpoint for clients: the server's own URL is a secret (providers put the key in it).
  return { moneyTables: true, programId: c.programId, settlementAuthority: c.authority, rpcUrl: DEVNET, cluster: 'devnet', lamportsPerChip: 100_000, authorityLamports, rpcError };
}
