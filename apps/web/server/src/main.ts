/**
 * `npm run server` (at the repo root, or `npm run dev` in apps/web/server): the local dedicated table server + matchmaking.
 *
 *   POKER_SERVER_PORT  (default 5181)   POKER_SERVER_SPEED (default 1)   POKER_SERVER_HOST (default 127.0.0.1)
 *
 * Local only: it trusts the browser's local chip tickets. Never bind it to a public interface.
 */
import { DEFAULT_SERVER_PORT } from '../../src/net/shared/protocol';
import { registerTournaments } from '../tournament';
import { startPokerServer } from './server';

const port = Number(process.env.POKER_SERVER_PORT ?? DEFAULT_SERVER_PORT);
const speed = Number(process.env.POKER_SERVER_SPEED ?? 1);
const host = process.env.POKER_SERVER_HOST ?? '127.0.0.1';

const server = await startPokerServer({ port, speed, host });

// Tournaments (web/server/tournament): TRN… sessions get their own table servers, on the same clock as every table.
registerTournaments(server, { clock: server.clock });

const stop = async () => {
  console.log('[PokerServer] Shutting down — paying out every seat.');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
