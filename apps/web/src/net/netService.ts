/**
 * `ctx.services.net` — the client side of Unity's multiplayer (PokerMenuConnection + PokerNetworkLauncher +
 * PokerClientGame + TableDisconnectButton), against the local table server:
 *
 *   quickPlay({ tier, buyIn })   Quick Play at a stake (pool, then overflow) — FusionMenuUIMain.OnPlayButtonPressed
 *   freePlayJoin({ tier, buyIn }) FreePlayJoinBridge: the same Quick Play
 *   createParty() / joinParty(code)  Party Create (spawn a private room, then join it) / Join by code
 *   reconnect()                  rejoin the last session (e.g. after a reload) inside the seat's grace
 *   cancelSearch()               MenuConnectCancel.Request
 *   current                      the live table session (ClientGame, chat, voice) the chrome draws from
 *
 * Every join ends at `router.navigate('table', { session })` with a TableSession that drives the 3D table.
 */
import type { AppContext } from '../app/app';
import type { StakeTier } from '../core/stakes/stakes';
import { tickerWait } from '../table/tableView';
import type { TableSession, TableSessionFactory, TableSessionHost } from '../table/tableScreen';
import { browserIdentity, browserWallet, selectedStake, type BrowserIdentity } from './browserIdentity';
import { ClientGame, type WalletPort } from './clientGame';
import { connectTable, type ConnectRoute } from './matchmaking';
import type { NetConnection } from './netConnection';
import { NetTableView } from './netTableView';
import { DEFAULT_SERVER_PORT } from './shared/protocol';
import { ChainTableMode } from './shared/sessions';
import { TableChat } from './tableChat';
import { TableVoice } from './voice/tableVoice';
import { PokerEventCodec, type WireEvent } from '../core/events/pokerEventCodec';
import { FreePlayLeaderboardMath } from '../core/leaderboards/freePlayLeaderboardMath';
import { RewardGrant } from '../app/services';
import { VirtualEconomy } from '../economy/virtualEconomy';
import type { TournamentClientState } from '../tournaments/clientState';
import { buildEndpoint, endpointParam } from '../app/flags';

const LastSessionKey = 'Poker.Net.LastSession';

/** One visit to a networked table: the connection, the client game, chat and voice. */
export class NetTableSession implements TableSession {
  game!: ClientGame;
  view!: NetTableView;
  chat!: TableChat;
  voice: TableVoice | null = null;
  status: 'playing' | 'reconnecting' | 'closed' = 'playing';
  private stopped = false;
  private offClose: (() => void) | null = null;
  private offTournament: (() => void) | null = null;

  constructor(
    private readonly service: NetService,
    private conn: NetConnection,
    private readonly host: TableSessionHost,
  ) {}

  get connection(): NetConnection {
    return this.conn;
  }

  start(): void {
    this.view = new NetTableView(this.host.stage);
    this.view.voiceEnabled = this.service.voiceEnabled;
    this.chat = new TableChat(this.conn, this.service.chatUserId, () => this.service.identity.playerName);
    this.bind(this.conn);
    if (this.service.voiceEnabled) {
      this.voice = new TableVoice(this.conn, (talking, muted) => this.game?.sendVoiceState(talking, muted));
      void this.voice.join();
    }
    this.service.setCurrent(this);
  }

  private bind(conn: NetConnection): void {
    this.conn = conn;
    this.game?.stop();
    this.game = new ClientGame({
      view: this.view,
      audio: this.host.audio,
      conn,
      identity: this.service.identity,
      wallet: this.service.wallet,
      wait: tickerWait,
      log: (level, m) => console[level === 'info' ? 'log' : level](m),
      onPresented: (event, catchUp) => {
        if (!catchUp) {
          this.host.ctx.events.emit('table:event', { event });
          this.trackProgress(event);
        }
      },
    });
    this.game.onChange((what) => {
      if (what === 'seat') this.onSeatChanged();
    });
    this.game.privateBuyInPrompt = this.service.privateBuyInPrompt;
    this.chat.join(conn.session ?? '', conn.region);
    this.offClose?.();
    this.offClose = conn.onClose((reason) => {
      if (reason === 'lost' && !this.stopped) void this.recover();
    });
    this.bindTournament(conn);
    econ(this.host.ctx).friends?.setCurrentTable?.(conn.session ? { session: conn.session, money: false } : null);
    this.game.start();
    try {
      sessionStorage.setItem(LastSessionKey, conn.session ?? '');
    } catch {
      /* ignore */
    }
    this.service.changed();
  }

  private lastSeat = -1;
  private handTracked = false;
  private handStartStack = 0;
  private wonThisHand = false;

  private get stakeMinBuyIn(): number {
    return ChainTableMode.resolveStake(this.conn.session ?? '', this.conn.properties[ChainTableMode.StakeProperty] ?? null).minBuyIn;
  }

  /** PokerClientGame's free-play bookkeeping: hand played / won, the leaderboard score and the funnel. */
  private trackProgress(e: WireEvent): void {
    const g = this.game;
    const svc = econ(this.host.ctx);
    if (e.type === 'HandStarted') {
      this.wonThisHand = false;
      this.handTracked = false;
      const s = g.localSeat >= 0 ? e.seats[g.localSeat] : undefined;
      if (s?.isOccupied && !s.isPendingNextHand) {
        this.handStartStack = s.stack;
        this.handTracked = true;
      }
    } else if (e.type === 'PotAwarded') {
      if (e.seat === g.localSeat && e.amount > 0) this.wonThisHand = true;
    } else if (e.type === 'HandEnded' && this.handTracked) {
      this.handTracked = false;
      const net = FreePlayLeaderboardMath.clampScore(g.localChips() - this.handStartStack);
      svc.leaderboards?.recordHand?.(net, this.wonThisHand);
      svc.telemetry?.funnel?.recordHand?.(net, this.wonThisHand, this.stakeMinBuyIn);
    }
  }

  /** PokerClientGame.OnSeatAssigned side effects other modules hang off (retention progress, the stake skin). */
  private onSeatChanged(): void {
    const seat = this.game.localSeat;
    if (seat === this.lastSeat) return;
    const ctx = this.host.ctx;
    const wasSeated = this.lastSeat >= 0;
    this.lastSeat = seat;
    ctx.events.emit('table:seat', seat);
    if (seat >= 0 && !wasSeated) {
      ctx.events.emit('table:joined', { localSeat: seat, moneyTable: false, roomCode: this.game.roomCode });
      const stake = ChainTableMode.resolveStake(this.conn.session ?? '', this.conn.properties[ChainTableMode.StakeProperty] ?? null);
      theme(ctx)?.applyTableSkinForStake?.(stake.minBuyIn, false);
      econ(ctx).telemetry?.funnel?.beginTable?.(this.game.roomCode, stake.minBuyIn, this.service.identity.selectedBuyInChips(), false);
      econ(ctx).economy?.markAtTable?.();
    } else if (seat < 0 && wasSeated) {
      econ(ctx).economy?.clearAtTable?.();
      econ(ctx).telemetry?.funnel?.endTable?.();
    }
  }

  /**
   * A TRN… session: feed TournamentClientState (the tournaments module's overlay) from the out-of-band tournament
   * events, and give it the watch / leave hooks (PokerClientGame.OnTournamentView/Result + RequestTournamentWatch).
   */
  private bindTournament(conn: NetConnection): void {
    this.offTournament?.();
    this.offTournament = null;
    const state = this.service.tournamentState;
    const session = conn.session ?? '';
    if (!state || !ChainTableMode.isTournamentSession(session)) return;
    state.begin(session);
    state.watchHandler = (tableId) => conn.send({ t: 'tournamentWatch', tableId });
    state.leaveHandler = () => this.host.leave();
    this.offTournament = conn.onBinary((bytes) => {
      let e;
      try {
        e = PokerEventCodec.decode(bytes).event;
      } catch {
        return;
      }
      if (!e) return;
      if (e.type === 'TournamentStatus') state.onStatus(e);
      else if (e.type === 'TournamentView') state.onView(e);
      else if (e.type === 'TournamentResult') {
        state.onResult(e);
        if (e.xpEarned > 0 && state.tryClaimXp(session, e.finished)) {
          try {
            VirtualEconomy.grant(RewardGrant.xp(e.xpEarned, 'tournament'));
          } catch {
            /* economy module absent */
          }
        }
      }
    });
  }

  /** The socket dropped: rejoin the same session inside the disconnect grace, else back to the menu. */
  private async recover(): Promise<void> {
    const session = this.conn.session ?? this.lastSession();
    this.status = 'reconnecting';
    this.service.changed();
    for (let attempt = 0; attempt < 3 && !this.stopped && session; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 1500));
      const r = await connectTable({ kind: 'join', code: session }, { url: this.service.serverUrl, delay: async () => {} });
      if (r.ok && r.conn && !this.stopped) {
        this.status = 'playing';
        this.view.clearTable();
        this.bind(r.conn);
        return;
      }
    }
    if (this.stopped) return;
    this.status = 'closed';
    this.service.changed();
    this.host.leave();
  }

  private lastSession(): string | null {
    try {
      return sessionStorage.getItem(LastSessionKey);
    } catch {
      return null;
    }
  }

  /**
   * TableDisconnectButton.Disconnect: leave the seat (the server cashes the stack out), give the RPC a moment to land
   * (0.75 s), then shut the runner down. The menu's Leave button calls host.leave(), which lands here.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.status = 'closed';
    this.offClose?.();
    this.offTournament?.();
    if (ChainTableMode.isTournamentSession(this.conn.session ?? '')) this.service.tournamentState?.clear();
    // ApplyOptimisticCashOutCredit: the seat assignment (-1) and the balance push both land after this session has
    // stopped listening, so the stack goes back on the HUD wallet now (the server records the same figure).
    if (this.game && this.game.localSeat >= 0 && !ChainTableMode.isTournamentSession(this.conn.session ?? '')) {
      const stack = this.game.localChips();
      if (stack > 0) this.service.wallet.adopt(this.service.wallet.coins + stack);
    }
    this.game?.requestLeaveTable();
    this.game?.stop();
    this.chat?.end();
    this.voice?.leave();
    this.view?.dispose();
    const conn = this.conn;
    setTimeout(() => conn.close(), 750);
    try {
      sessionStorage.removeItem(LastSessionKey);
    } catch {
      /* ignore */
    }
    this.service.setCurrent(null);
    this.host.ctx.events.emit('table:left');
    const e = econ(this.host.ctx);
    e.friends?.setCurrentTable?.(null);
    if (this.lastSeat >= 0) {
      e.economy?.clearAtTable?.();
      e.telemetry?.funnel?.endTable?.();
    }
    theme(this.host.ctx)?.restorePlayerTheme?.();
  }
}

/** The economy module's optional services (leaderboards, funnel, friends, wallet-at-table), read by name. */
function econ(ctx: AppContext): {
  leaderboards?: { recordHand?(net: number, won: boolean): void };
  telemetry?: { funnel?: { beginTable?(s: string, min: number, buyIn: number, money: boolean): void; recordHand?(net: number, won: boolean, min: number): void; endTable?(): void } };
  friends?: { setCurrentTable?(t: { session: string; money: boolean } | null): void; setJoinHandler?(fn: ((invite: { session: string }) => Promise<string | null>) | null): void };
  economy?: { markAtTable?(): void; clearAtTable?(): void };
} {
  return ctx.services as never;
}

/** ThemeManager / StakeTableSkin (theming module), read by name. */
function theme(ctx: AppContext): { applyTableSkinForStake?(minBuyIn: number, money: boolean): void; restorePlayerTheme?(): void } | undefined {
  return (ctx.services as unknown as Record<string, unknown>).theme as never;
}

/** A failed join. `unreachable`: no table server answered (the menu may offer the offline table then, and only then). */
export class NetConnectError extends Error {
  constructor(message: string, readonly unreachable: boolean) {
    super(message);
    this.name = 'NetConnectError';
  }
}

export class NetService {
  readonly serverUrl: string;
  readonly identity: BrowserIdentity;
  readonly wallet: WalletPort;
  /** PokerVoiceSettings.IsEnabled is false in the shipped Unity build; `?voice=1` turns WebRTC table voice on. */
  readonly voiceEnabled: boolean;
  current: NetTableSession | null = null;
  private cancelled = false;
  private searching = false;
  /** PrivateBuyInPrompt.Open (set by the chrome). */
  privateBuyInPrompt: ((game: ClientGame) => void) | null = null;

  constructor(private readonly ctx: AppContext) {
    const host = typeof location !== 'undefined' ? location.hostname || '127.0.0.1' : '127.0.0.1';
    this.serverUrl = endpointParam(ctx.params, 'netServer') ?? buildEndpoint('VITE_NET_SERVER') ?? `ws://${host}:${DEFAULT_SERVER_PORT}`;
    this.wallet = browserWallet(ctx);
    this.identity = browserIdentity(ctx, this.wallet);
    this.voiceEnabled = ctx.params.get('voice') === '1';
    // TournamentsHud.JoinAsync → Connection.ConnectAsync(session): the tournaments module calls this.
    // FriendInvites: an accepted invite joins the inviter's session.
    econ(ctx).friends?.setJoinHandler?.(async (invite) => {
      try {
        await this.connect({ kind: 'join', code: invite.session });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    const t = this.tournaments;
    if (t) t.joinHandler = async (session: string) => {
      try {
        await this.connect({ kind: 'join', code: session });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
  }

  private get tournaments(): { state?: TournamentClientState; joinHandler: ((session: string, info: unknown) => Promise<string | null>) | null } | undefined {
    return (this.ctx.services as unknown as Record<string, unknown>).tournaments as never;
  }

  get tournamentState(): TournamentClientState | null {
    return this.tournaments?.state ?? null;
  }

  /** A stable, non-secret chat id for this device (Photon Chat UserId stand-in). */
  get chatUserId(): string {
    let h = 2166136261 >>> 0;
    const t = this.identity.token;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    return 'u' + h.toString(16).padStart(8, '0');
  }

  setCurrent(s: NetTableSession | null): void {
    this.current = s;
    this.changed();
  }

  changed(): void {
    this.ctx.events.emit('net:session', this.current);
  }

  // ---- Menu entry points -------------------------------------------------------------------------

  quickPlay(req?: { tier?: StakeTier; buyIn?: number }): Promise<void> {
    const sel = selectedStake(this.wallet.coins);
    const tier = req?.tier ?? sel.tier;
    this.identity.buyInOverride = req?.buyIn ?? sel.buyIn;
    return this.connect({ kind: 'quick', minBuyIn: tier.minBuyIn }, this.identity.buyInOverride);
  }

  freePlayJoin(req?: { tier?: StakeTier; buyIn?: number }): Promise<void> {
    return this.quickPlay(req);
  }

  createParty(): Promise<void> {
    this.identity.buyInOverride = ChainTableMode.PrivateMaxBuyIn;
    return this.connect({ kind: 'create' });
  }

  joinParty(code: string): Promise<void> {
    this.identity.buyInOverride = ChainTableMode.PrivateMaxBuyIn;
    return this.connect({ kind: 'join', code });
  }

  /** Rejoin the session this tab was last at (a reload inside the seat's grace keeps the seat and stack). */
  async reconnect(): Promise<boolean> {
    let session: string | null = null;
    try {
      session = sessionStorage.getItem(LastSessionKey);
    } catch {
      /* ignore */
    }
    if (!session) return false;
    await this.connect({ kind: 'join', code: session });
    return true;
  }

  cancelSearch(): void {
    if (this.searching) this.cancelled = true;
  }

  private async connect(route: ConnectRoute, buyIn = 0): Promise<void> {
    if (this.searching) return;
    this.searching = true;
    this.cancelled = false;
    try {
      const r = await connectTable(route, {
        url: this.serverUrl,
        cancelled: () => this.cancelled,
        coins: route.kind === 'quick' ? this.wallet.coins : undefined,
        selectedBuyIn: buyIn,
        lobbyCheck: (session, properties) => lobbyCheck(this.ctx, session, properties),
      });
      if (!r.ok || !r.conn) {
        if (this.cancelled) return;
        throw new NetConnectError(r.message || 'Could not join a table.', !!r.unreachable);
      }
      if (this.cancelled) {
        r.conn.close();
        return;
      }
      await this.ctx.router.navigate('table', { session: this.sessionFactory(r.conn) });
    } finally {
      this.searching = false;
    }
  }

  /** The TableSessionFactory for an already-joined connection (tournaments can reuse it). */
  sessionFactory(conn: NetConnection): TableSessionFactory {
    return (host) => new NetTableSession(this, conn, host);
  }
}

/**
 * ChainLobbyProbe through the web3 module: the room's economy from its listed properties (the web table server answers
 * a join with them; there is no separate lobby list), refused when it isn't the player's lobby (ChainTableMode). Fails
 * open: no web3 module, or an unknown mode, goes ahead. Rooms without the "chain" mode are free tables, which a player
 * in the free lobby may join, so only a money room loads the chain code to decide.
 */
async function lobbyCheck(ctx: AppContext, session: string, properties: Record<string, string>): Promise<string | null> {
  const chain = ctx.services.chain;
  const { ChainTableMode: Lobby } = await import('../web3/solana/identity');
  if (!chain || (properties[Lobby.MODE_PROPERTY] !== Lobby.MODE_CHAIN && !Lobby.chainLobby)) return null;
  const { TableMode } = await import('../web3/chain/service');
  const found = await (await chain.get()).lookUpTableMode(session, async () => [{ name: session, properties }]);
  if (found === TableMode.Unknown) return null;
  const isChainTable = found === TableMode.Chain;
  if (isChainTable === Lobby.chainLobby) return null;
  return isChainTable
    ? `'${session}' is a real-money table. Turn on the money table switch and connect your wallet to join it.`
    : `'${session}' is a free-play table. Turn off the money table switch to join it.`;
}
