/**
 * URL flags that point the client at a server (`?netServer=`, `?web3backend=`, `?perbackend=`, `?web3rpc=`,
 * `?tournamentBackend=`, `?agentBackend=`). In a production build a crafted link must not be able to send a player's
 * session ticket or wallet traffic to someone else's server, so these are honoured only:
 *   - in dev (`npm run dev`), or
 *   - in a build made with VITE_ALLOW_ENDPOINT_FLAGS=1 (staging), or
 *   - when the URL's origin is on the build's allow-list VITE_ALLOWED_ENDPOINTS (comma-separated origins).
 * Everything else is ignored with a console warning. Boolean switches that select fixed, known servers
 * (`?online=1`, `?web3deployed=1`, `?tournaments=live`) are unaffected.
 */
export function endpointParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (value === null || value === '') return value;
  const env = import.meta.env;
  if (env.DEV || env.VITE_ALLOW_ENDPOINT_FLAGS === '1') return value;
  const allowed = String(env.VITE_ALLOWED_ENDPOINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    if (allowed.includes(new URL(value).origin)) return value;
  } catch {
    /* not a URL */
  }
  console.warn(`[flags] ignoring ?${name}= in this build (not on VITE_ALLOWED_ENDPOINTS)`);
  return null;
}

/** A build-time default endpoint (VITE_<NAME>), e.g. VITE_NET_SERVER=wss://tables.example.com. */
export function buildEndpoint(key: string): string | null {
  const v = (import.meta.env as Record<string, unknown>)[key];
  return typeof v === 'string' && v ? v : null;
}
