/**
 * The local table server's wire protocol. Two kinds of WebSocket frame:
 *
 * - **Binary frames** are table events, exactly the bytes of the C# PokerEventCodec ([seq:int32][type:byte]…) —
 *   what PokerTableNet's RPC_Event / RPC_EventTo carried. A future Fusion bridge forwards them untouched.
 * - **Text frames** are JSON control messages: the Fusion session layer (join / create), every client→server RPC on
 *   PokerTableNet (hello, action, reaction, voice state, avatar, lobby commands, leave, buy-in), the server→client
 *   seat assignment and wallet balance, plus the side channels Unity ran on other services (Photon Chat → `chat`,
 *   Vivox → WebRTC signalling in `rtc`).
 *
 * DOM-free and dependency-free: the Node server imports this file directly.
 */

/** Photon ShutdownReason / ConnectFailReason the menu reacts to. */
export type JoinFailReason = 'GameIsFull' | 'GameNotFound' | 'GameClosed' | 'InvalidArguments' | 'ServerError';

export type ClientMessage =
  // ---- Session (Fusion StartGame / the dedicated spawner) ----
  /** NetworkRunner.StartGame(GameMode.Client, session): join an existing session. */
  /** Side channel (on-chain tables): a reaction over `seat` (the table's own seat number), relayed to the room. */
  | { t: 'sideReaction'; seat: number; id: number }
  | { t: 'join'; session: string; appVersion: string; /** Watch only: never seated, outside the 8 seats' limit. */ watch?: boolean }
  /** PokerPartyClient.EnsureDedicatedRoomAsync: host a private room under `code` (then `join` it). */
  | { t: 'spawnRoom'; code: string; money: boolean }
  /** PokerPartyClient.RequestOverflowAsync: another Quick Play table after `failed` was full. */
  | { t: 'requestOverflow'; money: boolean; failed: string; minBuyIn: number }
  /** Round-trip probe for OneWayLatency (runner.GetPlayerRtt). */
  | { t: 'ping'; t0: number }
  // ---- PokerTableNet client → server RPCs ----
  | { t: 'hello'; name: string; token: string; ticket: string; buyIn: number }
  | { t: 'action'; seat: number; actionType: number; amount: number }
  | { t: 'reaction'; id: number }
  /** After a hand: reveal my hole cards to the table (replicated as a one-seat Showdown). */
  | { t: 'show' }
  | { t: 'voiceState'; talking: boolean; muted: boolean }
  | { t: 'avatar'; avatar: number }
  | { t: 'addBot' }
  | { t: 'removeBot'; seat: number }
  | { t: 'startGame' }
  | { t: 'leaveTable' }
  | { t: 'buyIn'; name: string; token: string; buyIn: number }
  | { t: 'retentionGrant'; key: string; chips: number; reason: string }
  | { t: 'tournamentWatch'; tableId: number }
  // ---- Side channels ----
  /** PokerTableChat.Send → PublishMessage(channel, [name, body]). Photon Chat does not echo to the sender. */
  | { t: 'chat'; name: string; body: string }
  /** Voice: join / leave the table's audio mesh, and relay WebRTC offers / answers / ICE to one peer. */
  | { t: 'voiceJoin' }
  | { t: 'voiceLeave' }
  | { t: 'rtc'; to: number; data: unknown };

export type ServerMessage =
  /** Joined `session` as PlayerRef `player`. */
  | { t: 'joined'; session: string; player: number; kind: string; region: string; properties: Record<string, string> }
  | { t: 'joinFailed'; reason: JoinFailReason; message: string }
  /** Side channel: another member reacted over `seat`. */
  | { t: 'sideReaction'; from: number; seat: number; id: number }
  | { t: 'roomReady'; code: string; error?: string }
  | { t: 'overflow'; session?: string; error?: string }
  | { t: 'pong'; t0: number }
  // ---- PokerTableNet server → client RPCs ----
  | { t: 'assignSeat'; seat: number }
  | { t: 'walletBalance'; balance: number }
  | { t: 'retentionGrantResult'; key: string; success: boolean; balance: number }
  // ---- Side channels ----
  /** A chat line from another player (`userId` = their device token's chat id). */
  | { t: 'chat'; userId: string; name: string; body: string }
  | { t: 'voicePeers'; peers: number[] }
  | { t: 'voiceJoined'; player: number }
  | { t: 'voiceLeft'; player: number }
  | { t: 'rtc'; from: number; data: unknown }
  /** The dedicated server is going away (PokerRunnerCallbacks.OnShutdown / host lost). */
  | { t: 'shutdown'; reason: string };

/** Default port of `npm run server` (`POKER_SERVER_PORT` overrides). */
export const DEFAULT_SERVER_PORT = 5181;

export function encodeMessage(m: ClientMessage | ServerMessage): string {
  return JSON.stringify(m);
}
