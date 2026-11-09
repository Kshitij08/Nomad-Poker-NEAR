/**
 * Every network endpoint and program id the web3 module uses, in one place. Ports of
 * Chain/PokerChainConfig.cs, Per/Core/PerAddresses.cs (PerIds), Per/Unity/PerPlatform.cs (PerSettings) and
 * Per/Unity/PerGameWallet.cs (SolanaRpcUrl).
 *
 * Defaults are DEVNET and OFFLINE:
 *  - nothing here is contacted at boot; every call starts from a player action (connect, join, deposit…);
 *  - the deployed backends (Railway) the Unity build talks to are listed but NOT used unless the page is opened with
 *    `?web3deployed=1` (PORTING-RULES: live calls behind a flag that is off by default). Without it the game
 *    backend and the private-tables backend are whatever `?web3backend=` / `?perbackend=` name (e.g. a local
 *    `cd backend && npm run dev` on http://localhost:8787), else "not configured";
 *  - mainnet is refused outright (`assertAllowedUrl`).
 */
import { buildEndpoint, endpointParam } from '../app/flags';

export type Cluster = 'devnet';

/** Program ids and fixed accounts (PerIds / PokerChainConfig). */
export const IDS = {
  /** poker-escrow (Chain/PokerEscrowProgram.cs ProgramIdBase58). The backend's /api/config may replace it. */
  escrowProgram: 'GdduGzsoiEamv285Z4DnBapmkMScnHLDdUAdWPywHozo',
  escrowSettlementAuthority: 'FcjrYf725azTnMao6xEzKPSrT4hD5YKYhKUHnVbWCUMH',
  /** poker-per: the live program (PerIds.LiveProgramId) and the internal test program (the IDL's address). */
  perLiveProgram: '7q2vxh2rNioeY5wsTpfvVGDR2yg3xhkqRYC5Urq4gwpv',
  perTestProgram: '4A3DZW5zvmG6v6C47UqooVbnTvNtgRQJ5fKDMZ62FNMZ',
  /** The new stack's own devnet instance (deployed 9 Nov 2026 for apps/per; its own keeper and auditor). */
  perNomadProgram: '7LcbAnHBFHkviM6AhGgmm871VYNkTU8HTt2bTWVWLKBn',
  teeValidator: 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
  permissionProgram: 'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1',
  delegationProgram: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh',
  esplProgram: 'SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  nativeMint: 'So11111111111111111111111111111111111111112',
  systemProgram: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  ed25519Program: 'Ed25519SigVerify111111111111111111111111111',
  instructionsSysvar: 'Sysvar1nstructions1111111111111111111111111',
} as const;

/** The deployed services the Unity build uses. Only reachable with ?web3deployed=1. */
export const DEPLOYED = {
  /** PokerChainConfig.DevnetBackendUrl: the LIVE game backend (wallet auth, /api/config, /host/*). */
  gameBackend: 'https://poker-production-5326.up.railway.app',
  /** PerSettings: private-tables backends (lobby list, quick play, agents, archive). */
  perLiveBackend: 'https://poker-per-api-production-a435.up.railway.app',
  perTestBackend: 'https://poker-per-api-production.up.railway.app',
  perAgentsV2Backend: 'https://per-api-v3-production.up.railway.app',
} as const;

/** The new stack's PER service (apps/per) for the perNomadProgram. Its own staging, so no ?web3deployed=1 needed. */
export const NOMAD_PER_STAGING = 'https://nomad-poker-per-staging.kshitijiitgn.workers.dev';

export interface Web3Config {
  readonly cluster: Cluster;
  /** Solana devnet JSON-RPC for reads and wallet-signed L1 transactions (PerGameWallet.SolanaRpcUrl). */
  readonly solanaRpcUrl: string;
  /** Escrow reads (PokerChainConfig.DevnetRpcUrl falls back to the public devnet RPC here: no API key in the web build). */
  readonly escrowRpcUrl: string;
  /** MagicBlock's devnet TEE rollup (PerSettings.TeeUrl). */
  readonly teeUrl: string;
  /** The poker-per program the client addresses. Test builds (editor/staging) use the IDL's test program. */
  readonly perProgram: string;
  readonly perIsTestProgram: boolean;
  /** Game backend (SIWS auth, /api/config, /host/*); '' = not configured. */
  readonly gameBackendUrl: string;
  /** Private-tables backend (lobby /tables, /quickplay, agents); '' = not configured. */
  readonly perBackendUrl: string;
  /** Whether DEPLOYED backends may be contacted (only via ?web3deployed=1). */
  readonly allowDeployed: boolean;
  /** POKER_WEB2_ONLY: no wallet chrome, Solana never boots. `?web2only=1`. */
  readonly web2Only: boolean;
  /** Seconds before an auth request gives up (WalletAuthService.RequestTimeoutSeconds). */
  readonly requestTimeoutSeconds: number;
  /** Where the TEE attestation bundle is served (Unity: StreamingAssets/per-attest.js). */
  readonly attestScriptUrl: string;
  /** The enclave measurements observed on devnet (PerSettings.AttestationPinsJson). */
  readonly attestationPins: Readonly<Record<'mrTd' | 'rtMr0' | 'rtMr1' | 'rtMr2' | 'rtMr3' | 'mrConfigId' | 'mrOwner', string>>;
  /** The game's floor for a private-table buy-in, lamports (PerSettings.MinBuyIn). */
  readonly perMinBuyIn: bigint;
  readonly explorerTx: (sig: string) => string;
}

const ZERO96 = '0'.repeat(96);

/** Builds the config from the page's query string (and nothing else: no network). */
export function makeConfig(params: URLSearchParams = new URLSearchParams()): Web3Config {
  const allowDeployed = params.get('web3deployed') === '1';
  // Test builds of Unity (editor, POKER_STAGING) use the test program; the web port is a test build.
  // ?perprogram=live | nomad | (default) test. 'nomad' is the new stack's instance and service (apps/per); a build
  // can default to it (VITE_PER_PROGRAM=nomad, the staging web build).
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const which = params.get('perprogram') ?? (env.VITE_PER_PROGRAM === 'nomad' ? 'nomad' : 'test');
  const perIsTestProgram = which !== 'live';
  const gameBackendUrl = clean(endpointParam(params, 'web3backend')) ?? (allowDeployed ? DEPLOYED.gameBackend : '');
  const perBackendUrl =
    clean(endpointParam(params, 'perbackend')) ??
    (which === 'nomad'
      ? clean(buildEndpoint('VITE_PER_BACKEND')) ?? NOMAD_PER_STAGING
      : allowDeployed
        ? perIsTestProgram
          ? DEPLOYED.perAgentsV2Backend
          : DEPLOYED.perTestBackend
        : '');
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return Object.freeze({
    cluster: 'devnet',
    solanaRpcUrl: clean(endpointParam(params, 'web3rpc')) ?? 'https://api.devnet.solana.com',
    escrowRpcUrl: clean(endpointParam(params, 'web3rpc')) ?? 'https://api.devnet.solana.com',
    teeUrl: 'https://devnet-tee.magicblock.app',
    perProgram: which === 'nomad' ? IDS.perNomadProgram : perIsTestProgram ? IDS.perTestProgram : IDS.perLiveProgram,
    perIsTestProgram,
    gameBackendUrl,
    perBackendUrl,
    allowDeployed,
    // Store builds (VITE_STORE_BUILD=1, the Capacitor apps) ship without SOL features: no wallet chrome, no on-chain
    // tables (store rules: virtual coins only; plan Phase 8).
    web2Only: params.get('web2only') === '1' || (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_STORE_BUILD === '1',
    requestTimeoutSeconds: 20,
    attestScriptUrl: base + 'assets/web3/per-attest.js',
    attestationPins: Object.freeze({
      mrTd: 'c1ee9c16e3afc506cfe042c5b846a368528f3b37618eafb27469bc114cf914e9222c91618470e7f2b28ac360968270a5',
      rtMr0: 'c1f1f2bff33b16d1469134987fcdf0ea3bd9707350cc70e73f086c635a5fc4e96e0d214a7f775608e64d251382f20564',
      rtMr1: 'b4fe8751e5d96b726a0dabb86ba821783626d80638caf6ca0045f31f5e4c4e90e20aee96fca711421db5bdc60e5c91ed',
      rtMr2: '51c09b72276c8bcd0e274865a7e0a408ee956a6ccfae8b4edd43467d7585ff352bb89e28f5cb62105114cad7225e11ef',
      rtMr3: ZERO96,
      mrConfigId: ZERO96,
      mrOwner: '44eeaee2768dd9b3a52b41747367e5751b18f7653f087febd7de11bffabbd1d75d4ff353a68154541215863ee7fc2903',
    }),
    perMinBuyIn: 2_000_000n,
    explorerTx: (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  });
}

function clean(v: string | null): string | undefined {
  const s = (v ?? '').trim().replace(/\/+$/, '');
  return s ? s : undefined;
}

/** Thrown when a call would leave the sandbox the porting rules allow. */
export class NetworkPolicyError extends Error {}

/**
 * Every fetch in the module goes through this. Refuses mainnet anywhere, and the deployed backends unless
 * ?web3deployed=1 was given.
 */
export function assertAllowedUrl(cfg: Web3Config, url: string): void {
  const u = url.toLowerCase();
  if (u.includes('mainnet')) throw new NetworkPolicyError(`refused: ${url} looks like mainnet (the web port is devnet-only)`);
  if (!cfg.allowDeployed) {
    for (const d of Object.values(DEPLOYED)) {
      if (u.startsWith(d.toLowerCase())) throw new NetworkPolicyError(`refused: ${d} is a deployed backend (open the page with ?web3deployed=1 to allow it)`);
    }
  }
}

/** The backend URL, or a clear error when none is configured (offline build). */
export function requireBackend(url: string, what: string): string {
  if (!url) throw new NetworkPolicyError(`${what} isn't configured in this build (pass ?web3backend= / ?perbackend=, or ?web3deployed=1)`);
  return url;
}
