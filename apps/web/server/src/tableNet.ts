import type { PlayerAction } from '@nomad/engine/actions/actions';

/** Fusion PlayerRef: one connection's id inside a session (1, 2, 3…). 0 = PlayerRef.None. */
export type PlayerRef = number;
export const PLAYER_NONE: PlayerRef = 0;

/**
 * The server half of PokerTableNet — the one wire between the authoritative table and its clients. It moves encoded
 * event payloads out (to everyone, or to one player) and the few RPCs that are not events. Implemented by the
 * session layer (rooms.ts) over WebSockets; tests can implement it in memory.
 */
export interface TableNet {
  /** The session (room) name: Quick Play pool, party code, tournament id. */
  readonly sessionName: string;
  /** Session properties (`kind`: quick | private, `stake`: min buy-in…). */
  readonly properties: Readonly<Record<string, string>>;
  /** Runner.ActivePlayers: every connected player, spectators included. */
  activePlayers(): PlayerRef[];
  /** RPC_Event: an encoded event to every client. */
  broadcastEvent(payload: Uint8Array): void;
  /** RPC_EventTo: an encoded event to one client (hole cards, your-turn, lobby state, catch-up). */
  sendEventTo(player: PlayerRef, payload: Uint8Array): void;
  /** RPC_AssignSeat: tell one client which seat is theirs (-1 = none). */
  sendSeatAssignment(player: PlayerRef, seat: number): void;
  /** RPC_WalletBalance: the authoritative Coins balance after a buy-in / cash-out. */
  sendWalletBalance(player: PlayerRef, balance: number): void;
  /** Runner.Disconnect(player): drop one connection (a tournament turning a player away). Optional so in-memory test nets need not implement it; the WebSocket Room does. */
  disconnect?(player: PlayerRef): void;
  /** RPC_RetentionGrantResult (broadcast; clients match the key). */
  broadcastRetentionGrantResult(key: string, success: boolean, balance: number): void;
}

/**
 * Port of IPokerTableServer: what the RPCs call into on the server. A cash table is PokerServerGame; a tournament
 * process swaps in its own implementation (web/server/tournament/**), which runs several tables through one session.
 */
export interface IPokerTableServer {
  activate(net: TableNet): void;
  onHello(player: PlayerRef, playerName: string, token: string, sessionTicket: string, buyInChips: number): void;
  onActionSubmitted(source: PlayerRef, seat: number, action: PlayerAction): void;
  onReaction(source: PlayerRef, reactionId: number): void;
  onVoiceState(source: PlayerRef, talking: boolean, muted: boolean): void;
  onAvatar(source: PlayerRef, avatar: number): void;
  onAddBot(source: PlayerRef): void;
  onRemoveBot(source: PlayerRef, seat: number): void;
  onStartGame(source: PlayerRef): void;
  onLeaveTable(source: PlayerRef): void;
  onBuyIn(source: PlayerRef, playerName: string, token: string, buyInChips: number): void;
  onRetentionGrant(player: PlayerRef, idempotencyKey: string, chips: number, reason: string): void;
  onPlayerLeft(player: PlayerRef): void;
  /** Tournament processes only (RPC_TournamentWatch). */
  onTournamentWatch?(source: PlayerRef, tableId: number): void;
  /** The seat this connection holds, or -1 (chat/voice attribution). */
  seatOf(player: PlayerRef): number;
  /** OnDestroy: the session is ending — pay everyone out and stop. */
  dispose(): void;
}
