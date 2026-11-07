/**
 * The web3 module: Solana wallet, escrow money tables and MagicBlock private tables (Unity: Assets/Scripts/Auth,
 * Chain, Net/Chain, Per). Installs
 *  - `ctx.services.solana`  (SolanaService: wallet connect/sign, sleep gate, SIWS auth) — light, no web3.js;
 *  - `ctx.services.chain`   (lazy → ChainService: escrow reads, buy-in/cash-out transactions, host API);
 *  - `ctx.services.per`     (lazy → PerRuntime: game balance, join, lobby, host, invites, tourneys, table factory);
 *  - `ctx.services.web3Config` (config.ts: devnet, offline unless the page's flags say otherwise);
 * and the screens in ui/screens.ts. Nothing touches the network at boot: @solana/web3.js and every RPC/back-end call
 * load on the first player action that needs them (the lazy services' `get()`).
 */
import type { AppContext } from '../app/app';
import { makeConfig } from './config';
import { FetchHttp } from './lib/http';
import { SolanaService } from './solana/service';
import type { LazyService } from './services';
export { w3, type LazyService, type Web3Services } from './services';
import { installWeb3Screens } from './ui/screens';

function lazy<T>(load: () => Promise<T>): LazyService<T> {
  let p: Promise<T> | null = null;
  let value: T | null = null;
  return {
    get loaded() {
      return value;
    },
    get() {
      p ??= load().then((v) => (value = v));
      p.catch(() => (p = null));
      return p;
    },
  };
}

export function install(ctx: AppContext): void {
  const config = makeConfig(ctx.params);
  const http = new FetchHttp(config);
  const solana = new SolanaService(config, new FetchHttp(config, config.requestTimeoutSeconds), ctx.events);
  ctx.services.web3Config = config;
  ctx.services.solana = solana;
  ctx.services.chain = lazy(async () => new (await import('./chain/service')).ChainService(config, http, solana));
  ctx.services.per = lazy(async () => new (await import('./per/service')).PerRuntime(config, http, solana));
  installWeb3Screens(ctx);
}
