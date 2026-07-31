import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const MAINNET_HOSTS = ["mainnet-beta", "api.mainnet-beta.solana.com"];

/** Valid devnet placeholder until `anchor deploy` — replace with deployed program id. */
export const DEFAULT_PROGRAM_ID = "DBKWKynzCeAFBijg9AN2WcRz3X8H3tapxSD6VnTMkGM5";

export function loadSettlementKeypair(): Keypair {
  const secret = process.env.SETTLEMENT_AUTHORITY_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "SETTLEMENT_AUTHORITY_SECRET is required for settlement. " +
        "Generate a devnet keypair and paste the base58 secret into backend/.env"
    );
  }

  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  assertDevnetOnlyKeyFromEnv(secret, rpc);

  const decoded = bs58.decode(secret);
  return Keypair.fromSecretKey(decoded);
}

export function hasSettlementKeypair(): boolean {
  return Boolean(process.env.SETTLEMENT_AUTHORITY_SECRET?.trim());
}

export function settlementAuthorityPublicKey(): PublicKey | null {
  if (!hasSettlementKeypair()) {
    return null;
  }
  return loadSettlementKeypair().publicKey;
}

export function assertDevnetOnlyKeyFromEnv(secretFromEnv: string, rpcUrl: string): void {
  const lower = rpcUrl.toLowerCase();
  const isMainnet = MAINNET_HOSTS.some((host) => lower.includes(host));
  if (isMainnet) {
    throw new Error(
      "Refusing to start: SETTLEMENT_AUTHORITY_SECRET from env is only allowed on devnet RPC endpoints."
    );
  }
}

export function createConnection(): Connection {
  return new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
}

export function programId(): PublicKey | null {
  const raw = process.env.POKER_PROGRAM_ID?.trim();
  if (!raw) {
    return null;
  }

  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(
      `POKER_PROGRAM_ID is not valid base58: "${raw}". ` +
        "Use the address from `anchor deploy` or remove it to start without the indexer."
    );
  }
}
