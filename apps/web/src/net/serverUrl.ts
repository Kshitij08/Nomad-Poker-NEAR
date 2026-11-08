import { DEFAULT_SERVER_PORT } from '@nomad/table-server/protocol';
import { buildEndpoint, endpointParam } from '../app/flags';

/** Known game servers for `?netServer=` (fixed addresses, so allowed in any build). */
export const GAME_SERVER_PRESETS: Record<string, string> = {
  staging: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev',
  local: 'http://localhost:8789',
};

/**
 * Where tables are: a `?netServer=` preset or URL, the build's VITE_NET_SERVER, else the local Node table server.
 * An http(s) address is the Cloudflare game server (tables, Agents and tournaments on the Nomad ledger).
 */
export function gameServerUrl(params: URLSearchParams): string {
  const host = typeof location !== 'undefined' ? location.hostname || '127.0.0.1' : '127.0.0.1';
  const preset = GAME_SERVER_PRESETS[params.get('netServer') ?? ''];
  return preset ?? endpointParam(params, 'netServer') ?? buildEndpoint('VITE_NET_SERVER') ?? `ws://${host}:${DEFAULT_SERVER_PORT}`;
}

/** The Cloudflare game server's base URL, or null when tables run on the local Node server. */
export function cloudGameServer(params: URLSearchParams): string | null {
  const url = gameServerUrl(params);
  return /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : null;
}
