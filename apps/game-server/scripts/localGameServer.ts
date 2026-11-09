/**
 * The game server's table routes in-process on this machine (Node http + ws in front of the real TableSlot /
 * TableHost), with D1 replaced by the node:sqlite stand-in and the real escrow client on devnet. For checking SOL
 * tables against the real program where the Worker can't reach a devnet RPC (escrow-check.ts --local).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { EscrowClient } from '@nomad/chain/escrowClient';
import { SolanaRpc } from '@nomad/chain/rpc';
import { signerFromSecret } from '@nomad/chain/transaction';
import { createPlayer, createSession } from '@nomad/db/accounts';
import { D1Shim } from '@nomad/db/testing/d1Shim';
import { realClock } from '@nomad/table-server/clock';
import { canonicalSession } from '../src/roomSpec';
import { TableHost, type HostSocket } from '../src/tableHost';
import { TableSlot } from '../src/tableSlot';

export interface LocalGameServer {
  url: string;
  db: D1Database;
  escrow: EscrowClient;
  /** A signed-in player whose sign-in identity is this wallet (the API's wallet sign-in, minus the signature). */
  walletPlayer(name: string, wallet: string): Promise<{ token: string; id: string }>;
  stop(): Promise<void>;
}

export async function startLocalGameServer(secret: string, rpcUrl: string, log: (level: 'info' | 'warn' | 'error', m: string) => void): Promise<LocalGameServer> {
  const db = await D1Shim.migrated();
  const escrow = new EscrowClient(new SolanaRpc(rpcUrl), await signerFromSecret(secret), { log });
  const slots = new Map<string, TableSlot>();
  const slotFor = (session: string) => {
    let slot = slots.get(session);
    if (!slot) {
      slot = new TableSlot({
        session,
        isSpawned: async () => false,
        qaRooms: false,
        moneyTables: true,
        qaSpeed: 1,
        log: (level, m) => log(level, `[${session}] ${m}`),
        createHost: (spec) =>
          new TableHost({ spec, escrow: spec.properties.mode === 'chain' ? escrow : undefined, db, clock: realClock(1), log: (level, m) => log(level, `[${session}] ${m}`), stillSeatedElsewhere: async () => false }),
      });
      slots.set(session, slot);
    }
    return slot;
  };
  const sweep = setInterval(() => {
    for (const s of slots.values()) void s.sweepIdle();
  }, 5000);

  const http = createServer((req, res) => {
    if (req.url?.startsWith('/v1/health')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    if (req.url?.startsWith('/v1/chain/config'))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ moneyTables: true, programId: escrow.programId, settlementAuthority: escrow.authority, rpcUrl, cluster: 'devnet' }));
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const session = canonicalSession(url.searchParams.get('session'));
    if (url.pathname !== '/v1/tables/ws' || !session) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const slot = slotFor(session);
      const sock: HostSocket = { send: (d) => ws.readyState === ws.OPEN && ws.send(d), close: () => ws.close() };
      ws.on('message', (data, isBinary) => {
        if (!isBinary) void slot.message(sock, data.toString());
      });
      ws.on('close', () => slot.disconnect(sock));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    db,
    escrow,
    async walletPlayer(name, wallet) {
      const p = await createPlayer(db, { displayName: name, identity: { provider: 'wallet', subject: wallet, label: wallet } });
      return { id: p.id, token: (await createSession(db, p.id)).token };
    },
    async stop() {
      clearInterval(sweep);
      for (const s of slots.values()) await s.live?.close('stopped');
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
