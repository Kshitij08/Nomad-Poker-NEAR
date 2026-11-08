/**
 * The session layer — what Photon Fusion + the VPS process spawner were for the Unity build, locally:
 *
 * - A **Room** is one Fusion session (a dedicated table process): a name, properties (`kind`, `stake`), at most 8
 *   connections (spectators count, as Photon's MaxPlayerCount did), PlayerRefs handed out per connection, and one
 *   IPokerTableServer behind a PokerTableNet-shaped wire.
 * - The **RoomRegistry** is the dedicated host: Quick Play pools (`poker-free`, `poker-free-st50`) exist on demand and
 *   persist, overflow tables (`poker-free-2`…) open when a pool is full (PokerPartyClient.RequestOverflowAsync), party
 *   rooms are spawned under a client-generated code (PokerDedicatedPartySpawner) and children quit when idle
 *   (PokerDedicatedIdleQuit: 120 s never joined, 180 s empty). Tournament porters register their own server factory.
 *
 * Side channels Unity ran elsewhere ride the same socket: table chat (Photon Chat, channel = session) and WebRTC
 * signalling for voice (Vivox).
 */
import { PlayerAction } from '@nomad/engine/actions/actions';
import { PokerChatRateLimiter, PokerChatText } from './chat';
import { encodeMessage, type ClientMessage, type JoinFailReason, type ServerMessage } from './protocol';
import { ChainTableMode, MAX_PLAYERS_PER_SESSION, PartyCodes, StakeSessionNames } from './sessions';
import type { ServerClock } from './clock';
import type { LogFn } from './chipTableSession';
import { PLAYER_NONE, type IPokerTableServer, type PlayerRef, type TableNet } from './tableNet';

/** One client connection (a NetworkRunner in Client mode). */
export interface Peer {
  readonly id: number;
  sendBinary(bytes: Uint8Array): void;
  sendJson(msg: ServerMessage): void;
  close(): void;
  /** Set when the peer joins a room. */
  room: Room | null;
  player: PlayerRef;
}

export type RoomKind = 'quick' | 'private' | 'tournament';

export interface RoomSpec {
  name: string;
  kind: RoomKind;
  properties: Record<string, string>;
  /** Dedicated children (party, overflow) quit when idle; primary pools persist. */
  child: boolean;
  maxPlayers?: number;
}

/** Builds the authority for a new room. The default is PokerServerGame; tournaments supply their own. */
export type TableServerFactory = (spec: RoomSpec) => IPokerTableServer;

const NeverJoinedQuitSeconds = 120;
const EmptyQuitSeconds = 180;

export class Room implements TableNet {
  readonly players = new Map<PlayerRef, Peer>();
  private nextPlayer = 1;
  private everHadPlayer = false;
  private emptySince: number;
  private readonly voice = new Set<PlayerRef>();
  private readonly chatLimiters = new Map<PlayerRef, PokerChatRateLimiter>();
  private readonly tokens = new Map<PlayerRef, string>();
  closed = false;

  constructor(
    readonly spec: RoomSpec,
    readonly server: IPokerTableServer,
    private readonly clock: ServerClock,
    private readonly log: LogFn,
  ) {
    this.emptySince = clock.now();
  }

  // ---- TableNet --------------------------------------------------------------------------------

  get sessionName(): string {
    return this.spec.name;
  }

  get properties(): Readonly<Record<string, string>> {
    return this.spec.properties;
  }

  get isFull(): boolean {
    return this.players.size >= (this.spec.maxPlayers ?? MAX_PLAYERS_PER_SESSION);
  }

  activePlayers(): PlayerRef[] {
    return [...this.players.keys()];
  }

  broadcastEvent(payload: Uint8Array): void {
    for (const peer of this.players.values()) peer.sendBinary(payload);
  }

  sendEventTo(player: PlayerRef, payload: Uint8Array): void {
    this.players.get(player)?.sendBinary(payload);
  }

  sendSeatAssignment(player: PlayerRef, seat: number): void {
    this.players.get(player)?.sendJson({ t: 'assignSeat', seat });
  }

  sendWalletBalance(player: PlayerRef, balance: number): void {
    if (balance < 0) return;
    this.players.get(player)?.sendJson({ t: 'walletBalance', balance });
  }

  disconnect(player: PlayerRef): void {
    const peer = this.players.get(player);
    if (!peer) return;
    peer.sendJson({ t: 'shutdown', reason: 'disconnected' });
    this.remove(peer);
    peer.close();
  }

  broadcastRetentionGrantResult(key: string, success: boolean, balance: number): void {
    for (const peer of this.players.values()) peer.sendJson({ t: 'retentionGrantResult', key, success, balance });
  }

  // ---- Membership ------------------------------------------------------------------------------

  admit(peer: Peer): PlayerRef {
    const player = this.nextPlayer++;
    this.players.set(player, peer);
    peer.room = this;
    peer.player = player;
    this.everHadPlayer = true;
    return player;
  }

  /** OnPlayerLeft: the connection went (closed socket, or the client shut its runner down). */
  remove(peer: Peer): void {
    const player = peer.player;
    if (!this.players.has(player)) return;
    this.players.delete(player);
    this.chatLimiters.delete(player);
    this.tokens.delete(player);
    peer.room = null;
    peer.player = PLAYER_NONE;
    if (this.voice.delete(player)) for (const p of this.players.values()) p.sendJson({ t: 'voiceLeft', player });
    if (this.players.size === 0) this.emptySince = this.clock.now();
    try {
      this.server.onPlayerLeft(player);
    } catch (e) {
      this.log('error', `[Room ${this.spec.name}] onPlayerLeft failed: ${(e as Error)?.stack ?? e}`);
    }
  }

  /** PokerDedicatedIdleQuit for children: true when this room should shut down. */
  idleExpired(): boolean {
    if (!this.spec.child || this.players.size > 0) return false;
    const limit = this.everHadPlayer ? EmptyQuitSeconds : NeverJoinedQuitSeconds;
    return this.clock.now() - this.emptySince >= limit;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of [...this.players.values()]) {
      peer.sendJson({ t: 'shutdown', reason });
      peer.room = null;
    }
    this.players.clear();
    this.server.dispose();
  }

  // ---- RPCs from a member ----------------------------------------------------------------------

  handle(peer: Peer, m: ClientMessage): void {
    const p = peer.player;
    const s = this.server;
    try {
      switch (m.t) {
        case 'hello':
          this.tokens.set(p, String(m.token ?? ''));
          s.onHello(p, str(m.name), str(m.token), str(m.ticket), num(m.buyIn));
          break;
        case 'action':
          s.onActionSubmitted(p, num(m.seat), PlayerAction.of(num(m.actionType), num(m.amount)));
          break;
        case 'reaction':
          s.onReaction(p, num(m.id) & 0xff);
          break;
        case 'voiceState':
          s.onVoiceState(p, !!m.talking, !!m.muted);
          break;
        case 'avatar':
          s.onAvatar(p, num(m.avatar) & 0xff);
          break;
        case 'addBot':
          s.onAddBot(p);
          break;
        case 'removeBot':
          s.onRemoveBot(p, num(m.seat, -1));
          break;
        case 'startGame':
          s.onStartGame(p);
          break;
        case 'leaveTable':
          s.onLeaveTable(p);
          break;
        case 'buyIn':
          s.onBuyIn(p, str(m.name), str(m.token), num(m.buyIn));
          break;
        case 'retentionGrant':
          s.onRetentionGrant(p, str(m.key), num(m.chips), str(m.reason));
          break;
        case 'tournamentWatch':
          s.onTournamentWatch?.(p, num(m.tableId, -1));
          break;
        case 'chat':
          this.relayChat(peer, m.name, m.body);
          break;
        case 'voiceJoin':
          this.voiceJoin(peer);
          break;
        case 'voiceLeave':
          if (this.voice.delete(p)) for (const other of this.players.values()) if (other !== peer) other.sendJson({ t: 'voiceLeft', player: p });
          break;
        case 'rtc':
          // Signalling only between two members of this table's voice mesh.
          if (this.voice.has(p) && this.voice.has(num(m.to))) this.players.get(num(m.to))?.sendJson({ t: 'rtc', from: p, data: m.data });
          break;
        default:
          break;
      }
    } catch (e) {
      this.log('error', `[Room ${this.spec.name}] ${m.t} from ${p} failed: ${(e as Error)?.stack ?? e}`);
    }
  }

  /**
   * PokerTableChat over the table socket. The chat user id is derived from the device token (Photon Chat used the
   * token as its UserId) but never reveals it. Sanitised and rate limited here too — the server is the only check
   * other clients can rely on. Photon Chat does not echo to the sender, so neither does this.
   */
  private relayChat(peer: Peer, name: unknown, body: unknown): void {
    const clean = PokerChatText.sanitize(str(body));
    if (!clean) return;
    let limiter = this.chatLimiters.get(peer.player);
    if (!limiter) this.chatLimiters.set(peer.player, (limiter = new PokerChatRateLimiter()));
    if (!limiter.tryConsume(this.clock.now())) return;
    const decoded = PokerChatText.decode([str(name), clean], chatUserId(this.tokens.get(peer.player) ?? `p${peer.player}`));
    const userId = chatUserId(this.tokens.get(peer.player) ?? `p${peer.player}`);
    for (const other of this.players.values()) if (other !== peer) other.sendJson({ t: 'chat', userId, name: decoded.name, body: decoded.body });
  }

  private voiceJoin(peer: Peer): void {
    const p = peer.player;
    if (this.voice.has(p)) return;
    peer.sendJson({ t: 'voicePeers', peers: [...this.voice] });
    for (const other of this.voice) this.players.get(other)?.sendJson({ t: 'voiceJoined', player: p });
    this.voice.add(p);
  }
}

/** A short stable id for chat colours and per-sender mute, not the reconnect token itself. */
function chatUserId(token: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619) >>> 0;
  return 'u' + h.toString(16).padStart(8, '0');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export interface RoomRegistryOptions {
  clock: ServerClock;
  log: LogFn;
  /** The default authority for cash tables (Quick Play pools, overflow, party rooms). */
  cashTable: TableServerFactory;
  appVersion: string;
}

export class RoomRegistry {
  readonly rooms = new Map<string, Room>();
  private readonly factories: { match: (session: string) => boolean; create: TableServerFactory; kind: RoomKind }[] = [];
  private readonly stopSweep: () => void;

  constructor(private readonly opts: RoomRegistryOptions) {
    this.stopSweep = opts.clock.every(1, () => this.sweepIdle());
  }

  /**
   * Hook for other server modules (tournaments): sessions whose name matches are hosted by `create` instead of a cash
   * table. Registered factories win over the built-ins, most recent first.
   */
  registerServer(match: (session: string) => boolean, create: TableServerFactory, kind: RoomKind = 'tournament'): void {
    this.factories.unshift({ match, create, kind });
  }

  /** Opens (or returns) a room by spec — the API tournament code uses to create tables directly. */
  open(spec: RoomSpec, factory?: TableServerFactory): Room {
    const existing = this.rooms.get(spec.name);
    if (existing && !existing.closed) return existing;
    const server = (factory ?? this.factoryFor(spec.name) ?? this.opts.cashTable)(spec);
    const room = new Room(spec, server, this.opts.clock, this.opts.log);
    this.rooms.set(spec.name, room);
    server.activate(room);
    this.opts.log('info', `[Rooms] Opened ${spec.kind} session '${spec.name}'${spec.child ? ' (child)' : ''}.`);
    return room;
  }

  private factoryFor(session: string): TableServerFactory | null {
    return this.factories.find((f) => f.match(session))?.create ?? null;
  }

  /** NetworkRunner.StartGame(Client, session): Quick Play pools exist on demand; everything else must be spawned first. */
  join(peer: Peer, session: string, appVersion: string): { ok: true; room: Room } | { ok: false; reason: JoinFailReason; message: string } {
    if (appVersion && appVersion !== this.opts.appVersion)
      return { ok: false, reason: 'GameNotFound', message: `No session '${session}' in universe '${appVersion}'.` };
    if (!session || session.length > 64) return { ok: false, reason: 'InvalidArguments', message: 'Bad session name.' };
    let room = this.rooms.get(session);
    if (room?.closed) room = undefined;
    if (!room) {
      const factory = this.factoryFor(session);
      // Tournament processes take up to 30 players (+ spectators) through one session.
      if (factory) room = this.open({ name: session, kind: 'tournament', properties: {}, child: true, maxPlayers: 32 }, factory);
      else if (StakeSessionNames.isPrimary(session))
        room = this.open({
          name: session, kind: 'quick', child: false,
          properties: { [ChainTableMode.KindProperty]: ChainTableMode.KindQuick, [ChainTableMode.StakeProperty]: String(StakeSessionNames.parseMinBuyIn(session)) },
        });
      else return { ok: false, reason: 'GameNotFound', message: `Room '${session}' was not found.` };
    }
    if (room.isFull) return { ok: false, reason: 'GameIsFull', message: `Session '${session}' is full.` };
    room.admit(peer);
    return { ok: true, room };
  }

  /** PokerDedicatedPartySpawner: host a private room under the client's party code. */
  spawnParty(code: string, money: boolean): string | null {
    if (money) return 'Money tables are not available on the local server.';
    const name = (code ?? '').trim().toUpperCase();
    if (!PartyCodes.isValid(name)) return 'Party Create did not generate a valid room code.';
    if (this.rooms.has(name) && !this.rooms.get(name)!.closed) return null; // already up (a retry)
    this.open({ name, kind: 'private', child: true, properties: { [ChainTableMode.KindProperty]: ChainTableMode.KindPrivate } });
    return null;
  }

  /** PokerPartyClient.RequestOverflowAsync: the next overflow table of the pool that is not full. */
  requestOverflow(money: boolean, failed: string, minBuyIn: number): { session?: string; error?: string } {
    if (money) return { error: 'Money tables are not available on the local server.' };
    const stake = minBuyIn > 0 ? minBuyIn : StakeSessionNames.parseMinBuyIn(failed);
    for (let n = 2; n < 64; n++) {
      const name = StakeSessionNames.overflow(false, stake, n);
      const room = this.rooms.get(name);
      if (room && !room.closed && room.isFull) continue;
      if (!room || room.closed)
        this.open({
          name, kind: 'quick', child: true,
          properties: { [ChainTableMode.KindProperty]: ChainTableMode.KindQuick, [ChainTableMode.StakeProperty]: String(stake) },
        });
      return { session: name };
    }
    return { error: 'Every overflow table is full.' };
  }

  private sweepIdle(): void {
    for (const [name, room] of this.rooms) {
      if (room.closed) {
        this.rooms.delete(name);
        continue;
      }
      if (!room.idleExpired()) continue;
      this.opts.log('info', `[Rooms] Dedicated child '${name}' idle — quitting.`);
      room.close('idle');
      this.rooms.delete(name);
    }
  }

  shutdown(): void {
    this.stopSweep();
    for (const room of this.rooms.values()) room.close('server shutting down');
    this.rooms.clear();
  }
}

/** Routes one decoded client message for a peer (session layer first, then the room). */
export function routeMessage(registry: RoomRegistry, peer: Peer, m: ClientMessage): void {
  switch (m.t) {
    case 'ping':
      peer.sendJson({ t: 'pong', t0: m.t0 });
      return;
    case 'join': {
      if (peer.room) peer.room.remove(peer); // one runner per peer: a new StartGame shuts the old one down
      const r = registry.join(peer, m.session, m.appVersion);
      if (!r.ok) peer.sendJson({ t: 'joinFailed', reason: r.reason, message: r.message });
      else peer.sendJson({ t: 'joined', session: r.room.sessionName, player: peer.player, kind: r.room.spec.kind, region: ChainTableMode.DedicatedRegion, properties: { ...r.room.spec.properties } });
      return;
    }
    case 'spawnRoom': {
      const error = registry.spawnParty(m.code, !!m.money);
      peer.sendJson(error ? { t: 'roomReady', code: m.code, error } : { t: 'roomReady', code: m.code.trim().toUpperCase() });
      return;
    }
    case 'requestOverflow':
      peer.sendJson({ t: 'overflow', ...registry.requestOverflow(!!m.money, String(m.failed ?? ''), Number(m.minBuyIn) || 0) });
      return;
    default:
      if (peer.room) peer.room.handle(peer, m);
  }
}

export { encodeMessage };
