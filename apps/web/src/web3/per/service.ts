/**
 * The private-tables runtime behind `ctx.services.per` (loaded on first use, so the offline game never downloads
 * @solana/web3.js). One object holding what the Unity statics hold: PerGameWallet, PerEntry, PerWithdrawal, the
 * hosted-table list, and the table factory.
 */
import { PublicKey } from '@solana/web3.js';
import type { TableScreenParams, TableSessionHost } from '../../table/tableScreen';
import type { Web3Config } from '../config';
import type { PerHttp } from '../lib/http';
import { setPerProgram } from './addresses';
import { PerAgent } from './agent';
import { PerEntry, type PerSeat, type Stakes } from './entry';
import { PerGameWallet, type PerWalletPort, type Status } from './gameWallet';
import { PerHost } from './host';
import { PerHostedTables } from './hostedTables';
import { PerInvites } from './invites';
import { PerBuyIn, sol, solExact, STAKES, stakeMaxBuyIn, stakeMinBuyIn } from './money';
import { isPerTournamentTable, perTableParams } from './perTableController';
import { PerTourney } from './tourney';
import { PerWithdrawal } from './withdrawal';

export class PerRuntime {
  readonly gameWallet: PerGameWallet;
  readonly entry: PerEntry;
  readonly withdrawal: PerWithdrawal;
  // Pure helpers, re-exported for screens.
  readonly host = PerHost;
  readonly invites = PerInvites;
  readonly tourney = PerTourney;
  readonly agent = PerAgent;
  readonly hostedTables = PerHostedTables;
  readonly buyIn = PerBuyIn;
  readonly stakes = { list: STAKES, minBuyIn: stakeMinBuyIn, maxBuyIn: stakeMaxBuyIn };
  readonly format = { sol, solExact };

  constructor(
    readonly config: Web3Config,
    readonly http: PerHttp,
    wallet: PerWalletPort,
  ) {
    setPerProgram(config.perProgram);
    this.gameWallet = new PerGameWallet(http, config.solanaRpcUrl, config.teeUrl, wallet);
    this.entry = new PerEntry(http, config.teeUrl, () => config.perBackendUrl, this.gameWallet);
    this.withdrawal = new PerWithdrawal(this.gameWallet, { http, backendUrl: config.perBackendUrl });
  }

  /** PerEntry.Join, then the table screen's params (the caller navigates: router.navigate('table', params)). */
  async join(table: string | PublicKey, buyIn: bigint, status: Status, expect?: Stakes | null): Promise<TableScreenParams | null> {
    const seat = await this.entry.join(typeof table === 'string' ? new PublicKey(table) : table, buyIn, status, expect);
    return seat ? this.tableParams(seat) : null;
  }

  async joinTourney(tourney: string | PublicKey, tableIndex: number, status: Status): Promise<TableScreenParams | null> {
    const seat = await this.entry.joinTourney(typeof tourney === 'string' ? new PublicKey(tourney) : tourney, tableIndex, status);
    return seat ? this.tableParams(seat) : null;
  }

  tableParams(seat: PerSeat): TableScreenParams {
    return perTableParams({ config: this.config, http: this.http, entry: this.entry }, seat);
  }

  /** The game balance (lamports), null when the vault isn't open; may ask the wallet to sign the play-key message. */
  balance(status?: Status): Promise<bigint | null> {
    return this.gameWallet.balance(status);
  }

  deposit(lamports: bigint, status: Status): Promise<string> {
    return this.gameWallet.deposit(lamports, status);
  }

  /** PerTableController.IsTournament for a table visit (the menu's leave dialog). */
  isTournamentTable(host: TableSessionHost): boolean {
    return isPerTournamentTable(host);
  }

  listTables(creator?: string | null): Promise<Record<string, unknown>[]> {
    return this.entry.listTables(creator ? new PublicKey(creator) : null);
  }
}
