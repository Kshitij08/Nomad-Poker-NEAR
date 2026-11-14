import { DEFAULT_SERVER_PORT } from '@nomad/table-server/protocol';
import { buildEndpoint, endpointParam } from '../app/flags';

/** Known game servers for `?netServer=` (fixed addresses, so allowed in any build). */
export const GAME_SERVER_PRESETS: Record<string, string> = {
  staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev',
  production: 'https://nomad-poker-game.kshitijiitgn.workers.dev',
  local: 'http://localhost:8789',
};

/**
 * Where tables are: a `?netServer=` preset or URL, the build's VITE_NET_SERVER, else the local Node table server.
 * An http(s) address is the Cloudflare game server (tables, Agents and tournaments on the Nomad ledger).
 */
export function gameServerUrl(params: URLSearchParams): string {
  // The local server listens on 127.0.0.1 (IPv4). "localhost" may resolve to ::1 first, where another app can hold
  // the same port and answer instead, so on this machine connect to the IPv4 address directly.
  const name = typeof location !== 'undefined' ? location.hostname || '127.0.0.1' : '127.0.0.1';
  const host = name === 'localhost' || name === '[::1]' ? '127.0.0.1' : name;
  const preset = GAME_SERVER_PRESETS[params.get('netServer') ?? ''];
  return preset ?? endpointParam(params, 'netServer') ?? buildEndpoint('VITE_NET_SERVER') ?? `ws://${host}:${DEFAULT_SERVER_PORT}`;
}

/** The Cloudflare game server's base URL, or null when tables run on the local Node server. */
export function cloudGameServer(params: URLSearchParams): string | null {
  const url = gameServerUrl(params);
  return /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : null;
}
