import { encodeMessage, type ClientMessage, type ServerMessage } from '@nomad/table-server/protocol';
import type { Peer, Room, RoomSpec } from '@nomad/table-server/rooms';
import { ChainTableMode, LOCAL_APP_VERSION } from '@nomad/table-server/sessions';
import { PLAYER_NONE } from '@nomad/table-server/tableNet';
import type { AgentRow } from '@nomad/db/agents';
import type { AgentDesk } from './agentDesk';
import { canonicalSession } from './roomSpec';

/** A client sends a handful of frames a second at most (actions, chat, pings, voice signalling). */
const MAX_FRAMES_PER_SECOND = 40;
/** Voice signalling (SDP) is the largest client frame, a few KB. */
const MAX_FRAME_CHARS = 64 * 1024;

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** One client socket, whatever the runtime (a Durable Object WebSocket, a `ws` socket in tests). */
export interface HostSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * What a Durable Object hosts for one session: the sockets and the `join` handshake around a Room, whatever the Room's
 * authority is (a cash table's PokerServerGame, a tournament's TournamentTableServer). Runtime-neutral.
 */
export abstract class RoomHost {
  abstract readonly room: Room;
  protected readonly peers = new Map<HostSocket, Peer>();
  private nextPeer = 1;
  /** Per-socket flood guard: frames in the current one-second window. */
  private readonly frames = new Map<HostSocket, { at: number; n: number }>();
  protected draining = false;
  protected closed = false;

  constructor(protected readonly spec: RoomSpec) {}

  /** For logs: what is open here. */
  abstract get label(): string;
  /** Players or Agents present: the Durable Object keeps itself awake while this is true. */
  abstract get keepAwake(): boolean;
  abstract idleExpired(): boolean;
  abstract close(reason: string): Promise<void>;
  abstract drain(): Promise<void>;

  /** Is this player seated for that table session? (Only cash tables hold seats.) */
  holds(_playerId: string, _tableId: string): boolean {
    return false;
  }

  /** Owned Agents (cash Quick Play tables only). */
  readonly agents: AgentDesk | null = null;
  get agentCount(): number {
    return 0;
  }
  seatAgent(_row: AgentRow): Promise<boolean> {
    return Promise.resolve(false);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get playerCount(): number {
    return this.room.players.size;
  }

  get isFull(): boolean {
    return this.room.isFull;
  }

  connect(sock: HostSocket): void {
    const peer: Peer = {
      id: this.nextPeer++,
      room: null,
      player: PLAYER_NONE,
      sendBinary: (bytes) => sock.send(bytes),
      sendJson: (msg: ServerMessage) => sock.send(encodeMessage(msg)),
      close: () => sock.close(1000, 'closed'),
    };
    this.peers.set(sock, peer);
  }

  message(sock: HostSocket, text: string): void {
    const peer = this.peers.get(sock);
    if (!peer) return;
    if (text.length > MAX_FRAME_CHARS || this.flooding(sock)) {
      sock.close(1008, 'too many messages');
      return;
    }
    let m: ClientMessage;
    try {
      m = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
    switch (m.t) {
      case 'ping':
        peer.sendJson({ t: 'pong', t0: m.t0 });
        return;
      case 'join':
        this.join(peer, m.session, m.appVersion);
        return;
      case 'spawnRoom':
      case 'requestOverflow':
        // Session-layer requests are HTTP on the game server (POST /v1/tables/spawn, /overflow).
        return;
      default:
        if (peer.room) peer.room.handle(peer, m);
    }
  }

  /** More than MAX_FRAMES_PER_SECOND frames in a second: a misbehaving client, not a player. */
  private flooding(sock: HostSocket): boolean {
    const now = Date.now();
    const f = this.frames.get(sock);
    if (!f || now - f.at >= 1000) {
      this.frames.set(sock, { at: now, n: 1 });
      return false;
    }
    return ++f.n > MAX_FRAMES_PER_SECOND;
  }

  disconnect(sock: HostSocket): void {
    const peer = this.peers.get(sock);
    this.peers.delete(sock);
    this.frames.delete(sock);
    if (peer?.room) peer.room.remove(peer);
  }

  private join(peer: Peer, session: string, appVersion: string): void {
    const fail = (reason: 'GameIsFull' | 'GameNotFound' | 'GameClosed', message: string) => peer.sendJson({ t: 'joinFailed', reason, message });
    if (appVersion && appVersion !== LOCAL_APP_VERSION) return fail('GameNotFound', `No session '${session}' in universe '${appVersion}'.`);
    if (canonicalSession(session) !== this.spec.name) return fail('GameNotFound', `This connection is for '${this.spec.name}'.`);
    if (this.closed || this.draining) return fail('GameClosed', 'This table is closing; try again in a moment.');
    if (peer.room) return; // already joined on this socket
    if (this.room.isFull) return fail('GameIsFull', `Session '${session}' is full.`);
    this.room.admit(peer);
    peer.sendJson({
      t: 'joined',
      session: this.room.sessionName,
      player: peer.player,
      kind: this.spec.kind,
      region: ChainTableMode.DedicatedRegion,
      properties: { ...this.spec.properties },
    });
  }
}
