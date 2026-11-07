/**
 * `ctx.services.chain`: escrow money tables. Ports of Chain/PokerChain.cs (reads, quote, buy-in / rebuy /
 * request-leave via the player's wallet, /api/config adoption), Chain/PokerChainHostApi.cs (the host's JWT-authorized
 * /host/* calls), Net/Chain/ChainLobbyProbe.cs (economy of a room code, over a session lister the net module
 * provides) and Net/Chain/ChainTableSession.cs (the host loop's escrow adapter, coroutines → async).
 *
 * Nothing here runs at boot. Reads go to devnet RPC; the backend calls need a configured backend (config.ts).
 * PokerChainBackend.cs (/internal/*, INTERNAL_API_KEY) is server-only and deliberately not ported: no API keys in a
 * browser bundle.
 */
import { PublicKey, Transaction } from '@solana/web3.js';
import { requireBackend, type Web3Config } from '../config';
import type { PerHttp } from '../lib/http';
import { PerRpc } from '../per/rpc';
import {
  decodeConfigDevWallet, decodeSeat, decodeTable, EscrowProgram, quoteBuyIn, tableIdToBytes, type BuyInQuote, type ChainConfig,
  type SeatState, type TableAddresses, type TableState, type TxResult,
} from './escrow';

/** What chain buy-ins need from the browser wallet (SolanaService implements it). */
export interface ChainWalletPort {
  readonly address: string | null;
  signTransactionBytes(tx: Uint8Array): Promise<Uint8Array>;
}

export enum TableMode { Unknown, Free, Chain }

/** A room as the Photon lobby lists it (net module). */
export interface ListedSession {
  name: string;
  properties?: Record<string, unknown>;
}
/** Lists the poker lobby's sessions (Fusion JoinSessionLobby + OnSessionListUpdated), within a time budget. */
export type SessionLister = (lobby: string, budgetSeconds: number) => Promise<ListedSession[] | null>;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChainService {
  readonly program = new EscrowProgram();
  private rpc: PerRpc;
  private rpcUrl: string;
  private configApplied = false;
  private readonly seatListeners = new Set<(s: SeatState) => void>();

  constructor(
    readonly config: Web3Config,
    private readonly http: PerHttp,
    private readonly wallet: ChainWalletPort,
  ) {
    this.rpcUrl = config.escrowRpcUrl;
    this.rpc = new PerRpc(http, this.rpcUrl);
  }

  /** PokerChain.OnSeatChanged. */
  onSeatChanged(fn: (s: SeatState) => void): () => void {
    this.seatListeners.add(fn);
    return () => this.seatListeners.delete(fn);
  }

  private backend(): string {
    return requireBackend(this.config.gameBackendUrl, 'The game backend (money tables)').replace(/\/+$/, '');
  }

  // ---- config (PokerChain.FetchChainConfigAsync / ApplyChainConfig / EnsureConfiguredAsync)

  async fetchChainConfig(): Promise<ChainConfig> {
    const r = await this.http.get(this.backend() + '/api/config');
    if (r.status !== 200) throw new Error(r.body || 'Failed to fetch backend config');
    const p = JSON.parse(r.body) as { programId?: string; settlementAuthority?: string; rpcUrl?: string };
    return { programId: p.programId ?? '', settlementAuthority: p.settlementAuthority ?? '', rpcUrl: p.rpcUrl ?? '' };
  }

  /** The backend's program id wins over the compiled one; its RPC replaces ours (mainnet still refused by policy). */
  applyChainConfig(c: ChainConfig): void {
    this.program.setProgramId(c.programId);
    if (c.rpcUrl && c.rpcUrl !== this.rpcUrl) {
      this.rpcUrl = c.rpcUrl;
      this.rpc = new PerRpc(this.http, c.rpcUrl);
    }
  }

  async initializeFromBackend(): Promise<ChainConfig> {
    const c = await this.fetchChainConfig();
    this.applyChainConfig(c);
    this.configApplied = true;
    return c;
  }

  async ensureConfigured(): Promise<void> {
    if (!this.configApplied) await this.initializeFromBackend();
  }

  // ---- reads

  addresses(tableId: string, player: string): TableAddresses {
    return this.program.addresses(tableId, new PublicKey(player));
  }

  async getTable(tableId: string): Promise<TableState> {
    const id = this.program.deriveTable(tableIdToBytes(tableId));
    const data = await this.rpc.getAccount(id, 'confirmed');
    if (!data) throw new Error(`Table '${tableId}' not found on chain.`);
    return decodeTable(tableId, data);
  }

  async tryGetTable(tableId: string): Promise<TableState | null> {
    try {
      return await this.getTable(tableId);
    } catch {
      return null;
    }
  }

  async getTableWithRetry(tableId: string, maxAttempts = 5, delayMs = 1500): Promise<TableState> {
    let last: unknown = null;
    for (let a = 1; a <= maxAttempts; a++) {
      try {
        return await this.getTable(tableId);
      } catch (e) {
        last = e;
        if (a < maxAttempts) await delay(delayMs);
      }
    }
    throw last ?? new Error(`Table '${tableId}' not found.`);
  }

  async tryGetSeat(tableId: string, player: string): Promise<SeatState | null> {
    const data = await this.rpc.getAccount(this.program.deriveSeat(tableIdToBytes(tableId), new PublicKey(player)), 'confirmed');
    return data ? decodeSeat(data) : null;
  }

  async quoteBuyIn(tableId: string): Promise<BuyInQuote> {
    const t = await this.getTable(tableId);
    return quoteBuyIn(t.buyInLamports, t.rakeBps);
  }

  // ---- player transactions (wallet-signed; only ever on the player's button)

  private requireWallet(): PublicKey {
    if (!this.wallet.address) throw new Error('Wallet not connected.');
    return new PublicKey(this.wallet.address);
  }

  private async devWallet(): Promise<PublicKey> {
    const data = await this.rpc.getAccount(this.program.deriveConfig(), 'confirmed');
    if (!data) throw new Error('escrow config not found on chain');
    return decodeConfigDevWallet(data);
  }

  /** Builds (does not send) the buy-in transaction: tests and previews use this. */
  async buildBuyIn(tableId: string): Promise<Transaction> {
    const player = this.requireWallet();
    return EscrowProgram.tx(this.program.buyInIx(player, tableId, await this.devWallet()), player, await this.rpc.latestBlockhash());
  }

  async buildRebuy(tableId: string, buyInLamports: bigint): Promise<Transaction> {
    const player = this.requireWallet();
    return EscrowProgram.tx(this.program.rebuyIx(player, tableId, buyInLamports, await this.devWallet()), player, await this.rpc.latestBlockhash());
  }

  async buildRequestLeave(tableId: string): Promise<Transaction> {
    const player = this.requireWallet();
    return EscrowProgram.tx(this.program.requestLeaveIx(player, tableId), player, await this.rpc.latestBlockhash());
  }

  async buyIn(tableId: string): Promise<TxResult> {
    return this.signAndSend(tableId, () => this.buildBuyIn(tableId), 'BuyIn');
  }

  async rebuy(tableId: string, buyInLamports: bigint): Promise<TxResult> {
    return this.signAndSend(tableId, () => this.buildRebuy(tableId, buyInLamports), 'Rebuy');
  }

  /** Top up with the table's configured buy-in. */
  async rebuyTableBuyIn(tableId: string): Promise<TxResult> {
    return this.rebuy(tableId, (await this.getTable(tableId)).buyInLamports);
  }

  /** Mark the seat as leaving; the server cashes out after the current hand. */
  async requestLeave(tableId: string): Promise<TxResult> {
    return this.signAndSend(tableId, () => this.buildRequestLeave(tableId), 'RequestLeave');
  }

  /** First visit buys in; a busted player whose 0-chip seat survived tops up with rebuy. */
  async rebuyOrBuyIn(tableId: string): Promise<TxResult> {
    const player = this.requireWallet().toBase58();
    let seat = await this.tryGetSeat(tableId, player);
    if (!seat) seat = await this.tryGetSeat(tableId, player);
    const table = await this.getTable(tableId);
    return seat ? this.rebuy(tableId, table.buyInLamports) : this.buyIn(tableId);
  }

  private async signAndSend(tableId: string, build: () => Promise<Transaction>, what: string): Promise<TxResult> {
    try {
      const tx = await build();
      const signed = await this.wallet.signTransactionBytes(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
      const sig: string = await this.rpc.call('sendTransaction', btoa(String.fromCharCode(...signed)), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' });
      void this.notifySeatChanged(tableId);
      return { success: true, signature: sig };
    } catch (e) {
      console.error(`[PokerChain] ${what} failed:`, e);
      return { success: false, signature: null, error: (e as Error).message ?? String(e) };
    }
  }

  private async notifySeatChanged(tableId: string): Promise<void> {
    const player = this.wallet.address;
    if (!player) return;
    for (let a = 1; a <= 5; a++) {
      try {
        const s = await this.tryGetSeat(tableId, player);
        if (s) {
          for (const fn of this.seatListeners) fn(s);
          return;
        }
      } catch {
        /* retry */
      }
      if (a < 5) await delay(1500);
    }
    console.warn('[PokerChain] Seat refresh failed');
  }

  // ---- host API (PokerChainHostApi: Bearer = the host's player JWT)

  readonly host = {
    createTable: (jwt: string, tableId: string, buyInLamports: bigint, smallBlindChips: bigint, bigBlindChips: bigint, maxSeats: number) =>
      this.post('/host/tables', { tableId, buyInLamports: Number(buyInLamports), smallBlindChips: Number(smallBlindChips), bigBlindChips: Number(bigBlindChips), maxSeats }, jwt)
        .then((r) => (r.ok ? { success: true, signature: r.json?.signature ?? null, tablePda: r.json?.tablePda ?? null, vaultPda: r.json?.vaultPda ?? null } : { success: false, signature: null, tablePda: null, vaultPda: null, error: r.error })),
    beginHand: (jwt: string, tableId: string) =>
      this.post(`/host/tables/${encodeURIComponent(tableId)}/hand/start`, {}, jwt)
        .then((r) => ({ success: r.ok, alreadyActive: !!r.json?.alreadyActive, roundNonce: BigInt(r.json?.roundNonce ?? 0), signature: r.json?.signature ?? null, error: r.error })),
    settleHand: (jwt: string, tableId: string, deltas: { player: string; chipDelta: number }[], potChips: number, pendingSeatPdas: string[] = []): Promise<TxResult> => {
      if (deltas.reduce((a, d) => a + d.chipDelta, 0) !== 0) return Promise.resolve({ success: false, signature: null, error: 'Settlement deltas must sum to zero.' });
      return this.post(`/host/tables/${encodeURIComponent(tableId)}/hand/end`, { deltas, potChips, pendingSeatPdas }, jwt).then(sigResult);
    },
    cashOut: (jwt: string, tableId: string, playerPubkey: string) =>
      this.post(`/host/tables/${encodeURIComponent(tableId)}/cash-out`, { playerPubkey }, jwt).then(sigResult),
    closeTable: (jwt: string, tableId: string) => this.post(`/host/tables/${encodeURIComponent(tableId)}/close`, {}, jwt).then(sigResult),
    /** Verify a joiner's JWT via the backend; the wallet it was issued for, or null. */
    introspect: (token: string) => this.post('/api/auth/introspect', { token }, null).then((r) => (r.ok && r.json?.pubkey ? (r.json.pubkey as string) : null)),
  };

  private async post(path: string, payload: unknown, jwt: string | null): Promise<{ ok: boolean; json: any; error?: string }> {
    const r = await this.http.post(this.backend() + path, JSON.stringify(payload), jwt ? { Authorization: `Bearer ${jwt}` } : {});
    if (r.status < 200 || r.status >= 300) return { ok: false, json: null, error: r.body || `HTTP ${r.status}` };
    try {
      return { ok: true, json: JSON.parse(r.body) };
    } catch {
      return { ok: true, json: null };
    }
  }

  // ---- lobby probe (ChainLobbyProbe.LookUpAsync): fails OPEN

  async lookUpTableMode(code: string, lister: SessionLister, budgetSeconds = 4): Promise<TableMode> {
    if (!code.trim()) return TableMode.Unknown;
    try {
      const list = await lister('poker', budgetSeconds);
      if (!list) return TableMode.Unknown;
      const s = list.find((x) => x.name.toLowerCase() === code.toLowerCase());
      if (!s) return TableMode.Unknown;
      // A session with no mode property predates the split — those were all free tables.
      return s.properties?.mode === 'chain' ? TableMode.Chain : TableMode.Free;
    } catch (e) {
      console.warn(`[ChainLobbyProbe] Lookup of '${code}' failed (${(e as Error).message}); joining unchecked.`);
      return TableMode.Unknown;
    }
  }
}

const sigResult = (r: { ok: boolean; json: any; error?: string }): TxResult =>
  r.ok ? { success: true, signature: r.json?.signature ?? null } : { success: false, signature: null, error: r.error };
