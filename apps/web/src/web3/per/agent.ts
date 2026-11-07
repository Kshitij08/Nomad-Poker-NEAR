/**
 * M12: Agents on SOL tables (programs/poker-per/src/instructions/agent.rs). Port of Per/Core/PerAgent.cs. The
 * player's play key sets an Agent key on the wallet's private Agent record (stake, until when); the Agent runner holds
 * that key and can only buy in from the game balance as the wallet's seat (one at a time, within the stake), play it
 * with the seat's table key, and cash it out into the game balance.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { toBase64, utf8 } from '../lib/bytes';
import type { PerHttp } from '../lib/http';
import { findPda, perConfigAddress, permissionOf, PerIds, type PerTableAddresses } from './addresses';
import { buildPerIx } from './ix';
import type { FeeTerms } from './types';
import { vaultOf, vaultTokenOf, walletStateOf, type PlayKey } from './vault';

const NONE = new PublicKey(new Uint8Array(32));
const dlp = (tag: string, account: PublicKey) => findPda(PerIds.delegationProgram, utf8(tag), account.toBytes());

/** Agents v2 moved the record to new seeds for its bigger layout (copy-strategy fee terms and counts). */
const stateAddress = (wallet: PublicKey): PublicKey => findPda(PerIds.program, utf8('agent2'), wallet.toBytes());
const sponsor = (): PublicKey => findPda(PerIds.program, utf8('agent-sponsor'));
const hostTab = (wallet: PublicKey): PublicKey => findPda(PerIds.program, utf8('host-tab'), wallet.toBytes());

/** The wallet's Agent record (readable only by its Agent key and the play key that set it). */
export class AgentState {
  wallet!: PublicKey;
  agent!: PublicKey;
  table!: PublicKey;
  reader!: PublicKey;
  expires = 0n;
  keySet = 0;
  stake = 0n;
  committed = 0n;
  seat = 0;
  /** v2: the copied strategy's creator (none = the player's own strategy) and the agreed shares of new profit. */
  creator!: PublicKey;
  creatorFeeBps = 0;
  platformFeeBps = 0;
  seatIn = 0n;
  netIn = 0n;
  netOut = 0n;
  highWater = 0n;

  get hasSeat(): boolean {
    return !!this.table && !this.table.equals(NONE);
  }
  get copying(): boolean {
    return !!this.creator && !this.creator.equals(NONE);
  }
  running(now: bigint | number): boolean {
    return !!this.agent && !this.agent.equals(NONE) && BigInt(now) < this.expires;
  }

  /** The v2 record (254 bytes; offsets pinned by the program's record_layout test). */
  static decode(d: Uint8Array | null | undefined): AgentState | null {
    if (!d || d.length < 254) return null;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 8;
    const key = () => {
      const k = new PublicKey(d.slice(o, o + 32));
      o += 32;
      return k;
    };
    const s = new AgentState();
    s.wallet = key();
    s.agent = key();
    s.expires = v.getBigInt64(o, true); o += 8;
    s.keySet = v.getUint32(o, true); o += 4;
    s.stake = v.getBigUint64(o, true); o += 8;
    s.committed = v.getBigUint64(o, true); o += 8;
    s.table = key();
    s.seat = d[o]!; o += 1;
    s.reader = key();
    o += 1; // bump
    s.creator = key();
    s.creatorFeeBps = v.getUint16(o, true); o += 2;
    s.platformFeeBps = v.getUint16(o, true); o += 2;
    s.seatIn = v.getBigUint64(o, true); o += 8;
    s.netIn = v.getBigUint64(o, true); o += 8;
    s.netOut = v.getBigUint64(o, true); o += 8;
    s.highWater = v.getBigInt64(o, true);
    return s;
  }
}

function cashOutAs(t: PerTableAddresses, signer: PublicKey, wallet: PublicKey, seat: number, creator: PublicKey | null, treasury: PublicKey | null): TransactionInstruction {
  return buildPerIx('agent_cash_out', { seat }, {
    signer, wallet, agent_state: stateAddress(wallet), vault: vaultOf(wallet), wallet_state: walletStateOf(wallet),
    vault_token: vaultTokenOf(wallet), table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
    hand: t.hand(seat), hand_permission: t.handPermission(seat), escrow: t.escrow, config: perConfigAddress(),
    // Anchor reads the program id in an optional account's place as "none".
    creator_wallet_state: creator ? walletStateOf(creator) : PerIds.program,
    creator_vault_token: creator ? vaultTokenOf(creator) : PerIds.program,
    treasury_wallet_state: treasury ? walletStateOf(treasury) : PerIds.program,
    treasury_vault_token: treasury ? vaultTokenOf(treasury) : PerIds.program,
  });
}

const terms = (creator: PublicKey, creatorFeeBps: number, platformFeeBps: number): FeeTerms =>
  ({ creator: creator.toBytes(), creatorFeeBps: creatorFeeBps & 0xffff, platformFeeBps: platformFeeBps & 0xffff });
const noTerms = (): FeeTerms => ({ creator: new Uint8Array(32), creatorFeeBps: 0, platformFeeBps: 0 });

function set(k: PlayKey, agent: PublicKey | null, until: bigint | number, stake: bigint, feeTerms: FeeTerms | null = null): TransactionInstruction[] {
  const state = stateAddress(k.wallet);
  return [k.check(), buildPerIx('agent_set', { expires: k.expires, agent: (agent ?? NONE).toBytes(), until: BigInt(until), stake, terms: feeTerms ?? noTerms() }, {
    play_key: k.key.publicKey, wallet: k.wallet, wallet_state: walletStateOf(k.wallet), agent_state: state,
    agent_permission: permissionOf(state), sponsor: sponsor(),
    vault: vaultOf(k.wallet), vault_token: vaultTokenOf(k.wallet), config: perConfigAddress(),
  })];
}

/** The runner's JSON response (a JObject). */
export type AgentJson = Record<string, any>;

export const NO_PER_BACKEND = "The private-tables backend isn't configured in this build (pass ?perbackend=, or ?web3deployed=1).";

export const PerAgent = {
  /** The program's longest Agent run (MAX_AGENT_SECS). */
  MAX_SECONDS: 7 * 24 * 3600,

  stateAddress,
  get sponsor(): PublicKey {
    return sponsor();
  },

  /** L1, the program admin, once: create the Agent sponsor with `lamports` for records' rent, and hand it to the rollup. */
  createSponsor(admin: PublicKey, lamports: bigint): TransactionInstruction[] {
    const sp = sponsor();
    const config = perConfigAddress();
    return [
      buildPerIx('create_agent_sponsor', { lamports }, { admin, config, sponsor: sp }),
      buildPerIx('delegate_agent_sponsor', {}, {
        admin, config, sponsor: sp, buffer_sponsor: findPda(PerIds.program, utf8('buffer'), sp.toBytes()),
        delegation_record_sponsor: dlp('delegation', sp), delegation_metadata_sponsor: dlp('delegation-metadata', sp),
      }),
    ];
  },

  /** A copied strategy's fee terms: the creator's and Nomad's shares of new profit (basis points). */
  terms,
  /** The player's own strategy: no fee. */
  get noTerms(): FeeTerms {
    return noTerms();
  },

  /**
   * Rollup, the player's play key (its check first): let `agent` play until `until` with at most `stake` at risk,
   * under `terms` (a copied strategy's fees; null = none). Signing it is the player's consent to those fees. `agent`
   * null stops the Agent (its terms stay).
   */
  set,
  stop: (k: PlayKey): TransactionInstruction[] => set(k, null, 0, 0n),

  /** Rollup, the play key: remove the wallet's Agent record (no seat held); its rent goes back. */
  close(k: PlayKey): TransactionInstruction[] {
    const state = stateAddress(k.wallet);
    return [k.check(), buildPerIx('agent_close', { expires: k.expires }, {
      play_key: k.key.publicKey, wallet: k.wallet, wallet_state: walletStateOf(k.wallet), agent_state: state,
      agent_permission: permissionOf(state), sponsor: sponsor(),
    })];
  },

  /** Rollup, the Agent key: sit down (or rebuy) at `seat` as `wallet`, from its game balance. */
  buyIn: (t: PerTableAddresses, agentKey: PublicKey, wallet: PublicKey, seat: number, amount: bigint, reader: PublicKey): TransactionInstruction =>
    buildPerIx('agent_buy_in', { seat, amount, reader: reader.toBytes() }, {
      agent_key: agentKey, wallet, agent_state: stateAddress(wallet), vault: vaultOf(wallet), wallet_state: walletStateOf(wallet),
      vault_token: vaultTokenOf(wallet), config: perConfigAddress(), table: t.table, ledger: t.ledger, ledger_permission: t.ledgerPermission,
      hand: t.hand(seat), hand_permission: t.handPermission(seat), invites: PerIds.program, escrow: t.escrow,
    }),

  /**
   * Rollup, the Agent key (or the seat's table key): leave the Agent's seat into the game balance. Copying a strategy,
   * `creator` and `treasury` (config.dev_wallet) name the game balances the fees go to. The plain cash-outs refuse an
   * Agent's seat (AgentSeat): this is its only way out.
   */
  cashOut: (t: PerTableAddresses, signer: PublicKey, wallet: PublicKey, seat: number, creator: PublicKey | null = null, treasury: PublicKey | null = null) =>
    cashOutAs(t, signer, wallet, seat, creator, treasury),

  /** Rollup, the player's play key: take the stopped Agent's seat back into the game balance (stop first). */
  leaveAgentSeat: (k: PlayKey, t: PerTableAddresses, seat: number, creator: PublicKey | null = null, treasury: PublicKey | null = null) =>
    cashOutAs(t, k.key.publicKey, k.wallet, seat, creator, treasury),

  // ---------------------------------------------------------------------------- table hosting fees (Quick Play)

  hostTab,

  /**
   * Rollup, the play key (its check first): pay `amount` of the game balance to `hostWallet`'s (the keeper that hosts
   * a table for you; config.host_wallet), capped by the program. No wallet prompt.
   */
  payHostFee(k: PlayKey, amount: bigint, hostWallet: PublicKey): TransactionInstruction[] {
    const tab = hostTab(k.wallet);
    return [k.check(), buildPerIx('pay_host_fee', { expires: k.expires, amount }, {
      play_key: k.key.publicKey, 'pay.wallet': k.wallet, 'pay.wallet_state': walletStateOf(k.wallet), 'pay.vault': vaultOf(k.wallet),
      'pay.vault_token': vaultTokenOf(k.wallet), 'pay.config': perConfigAddress(), 'pay.host_wallet_state': walletStateOf(hostWallet),
      'pay.host_vault_token': vaultTokenOf(hostWallet), 'pay.host_tab': tab, 'pay.host_tab_permission': permissionOf(tab), 'pay.sponsor': sponsor(),
    })];
  },

  // ---------------------------------------------------------------------------- the Agent runner (backend)

  /**
   * A request to the runner (backend agents.ts): `data` as a JSON string, signed by the play key, with the wallet's
   * signed authorization of that key, so only the wallet's owner can deploy, stop or read their Agent.
   */
  signedRequest(k: PlayKey, path: string, data: Record<string, unknown> | null = null, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
    const ts = Math.floor(nowSeconds);
    const body = JSON.stringify(data ?? {});
    const sig = ed25519.sign(utf8(`nomad-agent|${path}|${ts}|${body}`), k.key.secretKey.slice(0, 32));
    // Hand-built so `expires` (an i64) stays a JSON number, in Newtonsoft's field order.
    return `{"wallet":${JSON.stringify(k.wallet.toBase58())},"playKey":${JSON.stringify(k.key.publicKey.toBase58())},"expires":${k.expires.toString()},"keySet":${k.keySet >>> 0},`
      + `"walletSig":${JSON.stringify(toBase64(k.signature))},"ts":${ts},"data":${JSON.stringify(body)},"sig":${JSON.stringify(toBase64(sig))}}`;
  },

  /** Posts a signed request to the runner; the response's JSON, or an error with its message. */
  async call(http: PerHttp, backendUrl: string, k: PlayKey, path: string, data: Record<string, unknown> | null = null): Promise<AgentJson> {
    if (!backendUrl) throw new Error(NO_PER_BACKEND);
    const { status, body } = await http.post(backendUrl + path, PerAgent.signedRequest(k, path, data));
    let j: AgentJson;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      j = parsed as AgentJson;
    } catch {
      throw new Error(`Agent service: HTTP ${status}`);
    }
    if (status !== 200) throw new Error(j.error != null ? String(j.error) : `Agent service: HTTP ${status}`);
    return j;
  },

  /**
   * A public GET from the same backend (NomadUiHost.LoadSol's unsigned path: the SOL marketplace listings). The JSON
   * object, or an error with the backend's `error` (else "HTTP <code>").
   */
  async get(http: PerHttp, backendUrl: string, path: string): Promise<AgentJson> {
    if (!backendUrl) throw new Error(NO_PER_BACKEND);
    const { status, body } = await http.get(backendUrl + path);
    let j: AgentJson;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      j = parsed as AgentJson;
    } catch {
      throw new Error(`HTTP ${status}`);
    }
    if (status !== 200) throw new Error(j.error != null ? String(j.error) : `HTTP ${status}`);
    return j;
  },

  /** Rollup, anyone: the Agent's seat was left another way; free its record for a new seat. */
  release: (t: PerTableAddresses, wallet: PublicKey): TransactionInstruction =>
    buildPerIx('agent_release', {}, { wallet, agent_state: stateAddress(wallet), table: t.table, ledger: t.ledger }),
};
