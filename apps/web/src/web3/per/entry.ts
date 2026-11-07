/**
 * Private tables (MagicBlock TEE rollup) in the game: joining a table buys in from the game balance, then the usual
 * table screen opens, driven by the PER table controller instead of the offline engine. Port of
 * Per/Unity/PerEntry.cs. Unity loads the Test scene and hooks PerTableController in; here `join` returns the seat and
 * the caller navigates to 'table' with `perTableSession(seat)` (see perTableController.ts).
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { bytesEq } from '../lib/bytes';
import type { PerHttp } from '../lib/http';
import { PerTableAddresses } from './addresses';
import type { PerGameWallet, Status } from './gameWallet';
import { PerHost } from './host';
import { PerInvites } from './invites';
import { PerSessionKeys } from './keys';
import { PerGame } from './legal';
import { sol } from './money';
import { LocalSigner, PerRpc, PerTxException, TeeAuth } from './rpc';
import { PerTourney } from './tourney';
import { decode, type Entrant, type Table } from './types';
import { PerVault, type PlayKey } from './vault';

/** The table being played (PerEntry.Seat), read by the table controller. */
export interface PerSeat {
  table: PublicKey;
  sessionKey: Keypair;
  /** The session key's rollup login (it also carries wallet-signed transactions). */
  sessionRpc: PerRpc;
  publicRpc: PerRpc;
  seatIndex: number;
  wallet: PublicKey;
  /** M11: the tournament this table belongs to (null at a cash table). */
  tourney: PublicKey | null;
}

/** The stakes the player was shown; join compares them with the table on chain (a null field isn't checked). */
export interface Stakes {
  smallBlind?: bigint | null;
  bigBlind?: bigint | null;
  minBuyIn?: bigint | null;
  maxBuyIn?: bigint | null;
}

export enum Hosted { Open, Opening, Closing, Closed, Gone }

export class PerEntry {
  /** The table being played, set when a join succeeds. */
  current: PerSeat | null = null;

  constructor(
    private readonly http: PerHttp,
    private readonly teeUrl: string,
    private readonly backendUrl: () => string,
    readonly gameWallet: PerGameWallet,
  ) {}

  publicRpc(): PerRpc {
    return new PerRpc(this.http, this.teeUrl);
  }

  private async sessionRpcFor(session: Keypair): Promise<PerRpc> {
    return new PerRpc(this.http, `${this.teeUrl}?token=${await TeeAuth.login(this.http, this.teeUrl, new LocalSigner(session))}`);
  }

  /**
   * Joins `table`: wallet, session key, rollup login, buy-in from the game balance (unless resuming a seat). Returns
   * the seat once seated; otherwise null and the last status says why not. `expect` (review #8): the stakes the
   * player was shown, which must match the table on chain.
   */
  async join(table: PublicKey, buyIn: bigint, status: Status, expect?: Stakes | null): Promise<PerSeat | null> {
    status('Connecting your wallet…');
    if (!(await this.gameWallet.wallet.connect())) {
      status('Connect a wallet to play private tables.');
      return null;
    }
    const wallet = this.gameWallet.address!;
    const session = await PerSessionKeys.forKey(wallet, table);
    status('Logging in to the private rollup (no wallet prompt: your table key signs)…');
    const sessionRpc = await this.sessionRpcFor(session);
    const publicRpc = this.publicRpc();
    const addrs = new PerTableAddresses(table);

    let t = decode.table(await publicRpc.getAccount(table));
    if (!t || t.status !== PerGame.StatusOpen) {
      status("That table isn't open.");
      return null;
    }

    // Already seated with this key (a reload, or rejoining after leaving the screen)?
    let seat = -1;
    const ledger = decode.ledger(await sessionRpc.getAccount(addrs.ledger));
    if (ledger)
      for (let i = 0; i < ledger.seats.length; i++)
        if (bytesEq(ledger.seats[i]!.reader, session.publicKey.toBytes()) && bytesEq(ledger.seats[i]!.player, wallet.toBytes())) seat = i;

    if (seat < 0) {
      const mismatch = stakesMismatch(t, expect);
      if (mismatch) {
        status(mismatch);
        return null;
      }
      // M9: the buy-in comes from the game balance and the play key signs it (no wallet transaction).
      status('Checking your game balance…');
      const key = await this.gameWallet.playKey(status);
      let balance = await this.gameWallet.balance(status);
      if (balance === null) {
        status('Deposit into your game balance first (Deposit, above).');
        return null;
      }
      // A seat from before whose table key this browser no longer has: the play key can still cash it out.
      const earlier = await this.findEarlierSeat(t, addrs, key, wallet);
      if (earlier >= 0) {
        status('You still had a seat here from before. Cashing it out into your game balance…');
        await this.gameWallet.sendAsKey(key, PerVault.cashOut(addrs, key.key.publicKey, wallet, earlier, key.expires));
        t = decode.table(await publicRpc.getAccount(table))!;
        balance = (await this.gameWallet.balance(status)) ?? 0n;
      }
      if (balance < buyIn) {
        status(`Your game balance is ${sol(balance)}; this table's buy-in is ${sol(buyIn)}. Deposit first.`);
        return null;
      }
      if (buyIn < t.minBuyIn || buyIn > t.maxBuyIn) {
        status(balance < t.minBuyIn
          ? `Your game balance is ${sol(balance)}; this table's buy-in starts at ${sol(t.minBuyIn)}. Deposit first.`
          : `This table's buy-in is ${sol(t.minBuyIn)} to ${sol(t.maxBuyIn)}; ${sol(buyIn)} doesn't fit. Nothing was bought in.`);
        return null;
      }
      for (let i = 0; i < t.maxSeats; i++)
        if ((t.seatMask & (1 << i)) === 0) {
          seat = i;
          break;
        }
      if (seat < 0) {
        status('The table is full.');
        return null;
      }
      status(`Buying in ${sol(buyIn)} from your game balance (no wallet prompt)…`);
      // M9c: tables hosted before keep their L1 list; newer ones a private list in the rollup, which also admits
      // the code of an invite link this browser opened.
      let invites: PublicKey | null = null;
      let code: Uint8Array | null = null;
      if (t.inviteOnly) {
        const legacy = PerHost.invitesAddress(table);
        invites = (await this.gameWallet.l1.getAccount(legacy, 'confirmed')) !== null ? legacy : PerHost.privateInvitesAddress(table);
        if (!invites.equals(legacy)) code = PerInvites.joinCode(table) ?? PerInvites.hostCode(table);
      }
      try {
        await this.gameWallet.sendAsKey(key, PerVault.buyIn(addrs, key, seat, buyIn, session.publicKey, invites, code));
      } catch (e) {
        if (e instanceof PerTxException && e.message.includes('NotInvited')) {
          status(code
            ? 'This invite link no longer works (the host made a new one). Ask the host for the current link.'
            : 'This table is invite-only. Ask the host for an invite link, or to add your wallet (Copy my wallet).');
          return null;
        }
        if (e instanceof PerTxException) {
          status('Buy-in failed: ' + e.message);
          return null;
        }
        throw e;
      }
    }

    this.current = { table, sessionKey: session, sessionRpc, publicRpc, seatIndex: seat, wallet, tourney: null };
    status('Seated. Opening the table…');
    return this.current;
  }

  /** M11: goes to this wallet's table in `tourney` for the current round (its registered table key signs). */
  async joinTourney(tourney: PublicKey, tableIndex: number, status: Status): Promise<PerSeat | null> {
    status('Connecting your wallet…');
    if (!(await this.gameWallet.wallet.connect())) {
      status('Connect a wallet to play.');
      return null;
    }
    const wallet = this.gameWallet.address!;
    const session = await PerSessionKeys.forKey(wallet, tourney);
    if (!(await this.ensureTourneyKey(tourney, wallet, session.publicKey, status))) return null;
    status('Logging in to the private rollup (your tournament table key signs)…');
    const sessionRpc = await this.sessionRpcFor(session);
    const table = PerTourney.tableAddress(tourney, tableIndex);
    this.current = { table, sessionKey: session, sessionRpc, publicRpc: this.publicRpc(), seatIndex: -1, wallet, tourney };
    status('Opening your tournament table…');
    return this.current;
  }

  /** This browser's table key for the tournament isn't the one registered: the play key moves the registration. */
  private async ensureTourneyKey(tourney: PublicKey, wallet: PublicKey, reader: PublicKey, status: Status): Promise<boolean> {
    const t = decode.tournament(await this.publicRpc().getAccount(tourney));
    if (!t) {
      status('That tournament is gone.');
      return false;
    }
    let me: Entrant | null = null;
    for (let e = 0; e < t.count; e++) if (bytesEq(t.entrants[e]!.wallet, wallet.toBytes())) me = t.entrants[e]!;
    if (!me) {
      status("This wallet isn't registered in that tournament.");
      return false;
    }
    if (bytesEq(me.reader, reader.toBytes())) return true;
    const key = await this.gameWallet.playKey(status);
    const seated = me.table !== PerTourney.NO_TABLE && me.table < PerTourney.MAX_TABLES && me.state === PerTourney.ENTRANT_PLAYING;
    for (let attempt = 0; ; attempt++) {
      status('This browser has a new table key for the tournament; moving your seat to it (no wallet prompt)…');
      try {
        try {
          await this.gameWallet.sendAsKey(key, PerTourney.setReader(tourney, key, reader, seated ? me.table : -1, seated ? me.seat : -1));
        } catch (e) {
          if (seated && e instanceof PerTxException && (e.errorName === 'NotTourneyTable' || e.errorName === 'AccountNotInitialized'))
            await this.gameWallet.sendAsKey(key, PerTourney.setReader(tourney, key, reader, -1, -1));
          else throw e;
        }
        return true;
      } catch (e) {
        if (e instanceof PerTxException && e.errorName === 'HandInProgress' && attempt < 40) {
          status('A hand is being played at your table; your seat moves to this browser when it ends…');
          await this.http.delay(3000);
          continue;
        }
        status("Couldn't move your seat to this browser: " + ((e as Error).message ?? e));
        return false;
      }
    }
  }

  /** A taken seat that belongs to this wallet (simulating the play key's cash-out of each taken seat), or -1. */
  private async findEarlierSeat(t: Table, addrs: PerTableAddresses, key: PlayKey, wallet: PublicKey): Promise<number> {
    const rpc = await this.gameWallet.keyRpcFor(key);
    for (let i = 0; i < t.maxSeats; i++) {
      if ((t.seatMask & (1 << i)) === 0) continue;
      try {
        await rpc.simulateReturn([key.check(), PerVault.cashOut(addrs, key.key.publicKey, wallet, i, key.expires)], new LocalSigner(key.key));
        return i;
      } catch (e) {
        if (!(e instanceof PerTxException)) throw e;
      }
    }
    return -1;
  }

  /** Whether `wallet` is on a pre-M9c table's L1 invite list (newer lists are private: the buy-in decides). */
  async isInvited(table: PublicKey, wallet: PublicKey): Promise<boolean> {
    try {
      return PerHost.isInvited(decode.invites(await this.gameWallet.l1.getAccount(PerHost.invitesAddress(table), 'confirmed')), table, wallet);
    } catch {
      return false;
    }
  }

  /** Where a hosted table is, from its Solana account. */
  async hostedState(table: PublicKey): Promise<Hosted> {
    const v = await this.gameWallet.l1.getAccountWithOwner(table, 'confirmed');
    if (!v) return Hosted.Gone;
    if (v.owner === 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh') return Hosted.Open;
    const t = v.data.length >= 11 ? decode.table(v.data) : null;
    if (!t) return Hosted.Gone;
    return t.status === PerGame.StatusClosed ? Hosted.Closed : t.status === PerGame.StatusOpen ? Hosted.Closing : Hosted.Opening;
  }

  /** M10: whether a table handed to the rollup is open there; its buy-in limits and big blind when it is. */
  async openInRollup(table: PublicKey): Promise<{ min: bigint; max: bigint; bigBlind: bigint } | null> {
    const t = decode.table(await this.publicRpc().getAccount(table));
    return t && t.status === PerGame.StatusOpen ? { min: t.minBuyIn, max: t.maxBuyIn, bigBlind: t.bigBlind } : null;
  }

  /** Lobby rows from the private-tables backend: live tables, or every table `creator` hosted. */
  async listTables(creator?: PublicKey | null): Promise<Record<string, unknown>[]> {
    const base = this.backendUrl();
    if (!base) throw new Error("The private-tables lobby isn't configured in this build (pass ?perbackend=, or ?web3deployed=1).");
    const r = await this.http.get(base + '/tables' + (creator ? '?creator=' + creator.toBase58() : ''));
    if (r.status !== 200) return [];
    return JSON.parse(r.body) as Record<string, unknown>[];
  }

  left(): void {
    this.current = null;
  }
}

/** Why the table on chain isn't the one the player was shown, or null. */
export function stakesMismatch(t: Table, expect?: Stakes | null): string | null {
  if (!expect) return null;
  const differs = (want: bigint | null | undefined, got: bigint) => want != null && want !== got;
  if (differs(expect.smallBlind, t.smallBlind) || differs(expect.bigBlind, t.bigBlind) || differs(expect.minBuyIn, t.minBuyIn) || differs(expect.maxBuyIn, t.maxBuyIn))
    return `This table's stakes on chain (blinds ${sol(t.smallBlind)} / ${sol(t.bigBlind)}, buy-in ${sol(t.minBuyIn)} to ${sol(t.maxBuyIn)}) aren't the ones shown. Nothing was bought in; pick the table again.`;
  return null;
}
