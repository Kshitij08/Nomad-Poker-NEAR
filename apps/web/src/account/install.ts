/**
 * The Nomad API account module (apps/api): `ctx.services.nomadApi` and the 'nomad-account' overlay.
 *
 * Which API: `?api=staging` / `?api=local` (fixed, known servers), `?api=<url>` (dev builds only, see app/flags.ts),
 * else the build's VITE_API_URL. With none, the service is null and the panel says so.
 * `?account=1` opens the panel at boot; an email sign-in link (`?emailToken=`) is completed at boot.
 */
import type { AppContext } from '../app/app';
import { buildEndpoint, endpointParam } from '../app/flags';
import { VirtualEconomy } from '../economy/virtualEconomy';
import { AccountScreen } from './accountScreen';
import { NomadProgress, NomadWallet } from './progress';
import { localTokenStore, NomadSession, type WalletSigner } from './session';

export const API_PRESETS: Record<string, string> = {
  staging: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev',
  local: 'http://localhost:8788',
};

declare module '../app/app' {
  interface Services {
    /** The Nomad API session; null when this build has no API configured. */
    nomadApi?: NomadSession | null;
    /** The player's server-side progress and rewards (retention's backend); unset without an API. */
    nomadProgress?: NomadProgress;
  }
}

export function apiBase(params: URLSearchParams): string | null {
  const p = params.get('api');
  if (p && API_PRESETS[p]) return API_PRESETS[p];
  if (!p && params.get('netServer') === 'staging') return API_PRESETS.staging; // the staging game server signs in here
  return (p ? endpointParam(params, 'api') : null) ?? buildEndpoint('VITE_API_URL');
}

function stageLabel(base: string): string {
  const preset = Object.entries(API_PRESETS).find(([, url]) => url === base)?.[0];
  if (preset) return preset;
  try {
    return new URL(base).host.includes('staging') ? 'staging' : new URL(base).host;
  } catch {
    return 'custom';
  }
}

export function install(ctx: AppContext): void {
  const base = apiBase(ctx.params)?.replace(/\/+$/, '') ?? null;
  const session = base ? new NomadSession(base, localTokenStore(base), ctx.events) : null;
  ctx.services.nomadApi = session;

  const wallet = (): WalletSigner | null => {
    const solana = ctx.services.solana;
    if (!solana) return null;
    return {
      connect: async () => ((await solana.connect()) ? solana.address : null),
      signMessage: (m) => solana.signMessage(m),
    };
  };

  ctx.router.register('nomad-account', (c) => new AccountScreen(c, { session, stage: base ? stageLabel(base) : 'off', wallet }));

  if (!session) return;
  // With a Nomad server, it owns the economy: balances, items and every reward (Phase 3). The wallet becomes a
  // read-only view of the server's figures and retention asks the server (retention/install wires the backend).
  const progress = new NomadProgress(session, ctx.events);
  const serverWallet = new NomadWallet(progress, session);
  ctx.services.nomadProgress = progress;
  let lastPlayer: string | null = null;
  ctx.events.on('nomad:changed', () => {
    const id = session.me?.player.id ?? null;
    if (id === lastPlayer || session.busy) return;
    lastPlayer = id;
    if (id) void progress.refresh();
    else progress.snapshot = null;
  });

  const emailToken = ctx.params.get('emailToken');
  void (async () => {
    await session.restore();
    if (emailToken) {
      // Drop the one-time token from the address bar before using it.
      const url = new URL(location.href);
      url.searchParams.delete('emailToken');
      history.replaceState(history.state, '', url);
      await session.emailVerify(emailToken);
    }
    // Everyone plays on a server account: a guest until they sign in (a guest keeps its progress when it links one).
    if (!session.signedIn) await session.guest();
    await progress.refresh();
    if (session.signedIn) VirtualEconomy.setProvider(serverWallet);
  })();
  if (emailToken || ctx.params.get('account') === '1') {
    // Once main.ts has opened the first screen (navigate() clears the stack, so pushing earlier would be lost).
    const off = ctx.events.on('router:changed', () => {
      off();
      void ctx.router.push('nomad-account');
    });
  }
}
