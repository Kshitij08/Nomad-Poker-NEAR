/**
 * The local table server: a WebSocket endpoint (one socket = one Fusion client runner) in front of the RoomRegistry.
 * `startPokerServer()` is what `npm run server` runs and what the multi-client tests start in-process.
 */
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { encodeMessage, type ClientMessage, type ServerMessage } from '../../src/net/shared/protocol';
import { LOCAL_APP_VERSION } from '../../src/net/shared/sessions';
import type { TableSettings } from '@nomad/engine/orchestration/tableSettings';
import type { AgentHooks } from './agents';
import { realClock, type ServerClock } from './clock';
import { LocalEconomy, type LogFn } from './economy';
import { PokerServerGame } from './pokerServerGame';
import { routeMessage, RoomRegistry, type Peer, type Room, type RoomSpec, type TableServerFactory } from './rooms';
import { PLAYER_NONE } from './tableNet';

export interface PokerServerOptions {
  /** 0 = any free port (tests). */
  port?: number;
  /** Bind address. Localhost only by default — this server trusts its clients' local tickets. */
  host?: string;
  /** Time scale for every table (tests run hands 10–50× faster). */
  speed?: number;
  clock?: ServerClock;
  log?: LogFn;
  /** Overrides on SERVER_TABLE_SETTINGS for every cash table (seeds, timers…). */
  tableSettings?: Partial<TableSettings>;
  disconnectGrace?: number;
  /** UnityEngine.Random stand-in for every table. */
  random?: () => number;
  agentHooks?: AgentHooks;
}

export interface PokerServer {
  readonly port: number;
  readonly url: string;
  readonly registry: RoomRegistry;
  readonly economy: LocalEconomy;
  /** The clock every table runs on (tournament tables should share it). */
  readonly clock: ServerClock;
  /** Tournaments / agents: host sessions matching `match` with your own IPokerTableServer. */
  registerServer(match: (session: string) => boolean, create: TableServerFactory): void;
  /** Opens a table room directly (tournament tables, tests). */
  openTable(spec: RoomSpec, factory?: TableServerFactory): Room;
  close(): Promise<void>;
}

export async function startPokerServer(opts: PokerServerOptions = {}): Promise<PokerServer> {
  const log: LogFn = opts.log ?? ((level, m) => console[level === 'info' ? 'log' : level](m));
  const clock = opts.clock ?? realClock(opts.speed ?? 1);
  const economy = new LocalEconomy(log);
  const cashTable: TableServerFactory = () =>
    new PokerServerGame({
      clock,
      log,
      economy,
      settings: opts.tableSettings,
      disconnectGrace: opts.disconnectGrace,
      random: opts.random,
      agentHooks: opts.agentHooks,
    });
  const registry = new RoomRegistry({ clock, log, cashTable, appVersion: LOCAL_APP_VERSION });

  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1', maxPayload: 64 * 1024 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });
  const port = (wss.address() as AddressInfo).port;
  let nextPeer = 1;

  wss.on('connection', (ws: WebSocket) => {
    const peer: Peer = {
      id: nextPeer++,
      room: null,
      player: PLAYER_NONE,
      sendBinary: (bytes) => {
        if (ws.readyState === ws.OPEN) ws.send(bytes, { binary: true });
      },
      sendJson: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(encodeMessage(msg));
      },
      close: () => ws.close(),
    };
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return; // clients only send control messages
      let m: ClientMessage;
      try {
        m = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return;
      routeMessage(registry, peer, m);
    });
    ws.on('close', () => peer.room?.remove(peer));
    ws.on('error', () => peer.room?.remove(peer));
  });

  log('info', `[PokerServer] Local table server listening on ws://${opts.host ?? '127.0.0.1'}:${port} (universe ${LOCAL_APP_VERSION}${opts.speed && opts.speed !== 1 ? `, ${opts.speed}× speed` : ''}).`);

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    registry,
    economy,
    clock,
    registerServer: (match, create) => registry.registerServer(match, create),
    openTable: (spec, factory) => registry.open(spec, factory),
    close: async () => {
      registry.shutdown();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
