/**
 * The web3 module's services, read back non-null. They are optional on `Services` (main.ts builds the registry with
 * `account` only; modules add theirs at install), so code inside the module goes through `w3(ctx)`, which throws a
 * clear error if the module wasn't installed. Other modules should read `ctx.services.solana?` etc. and guard.
 */
import type { AppContext } from '../app/app';
import type { Web3Config } from './config';
import type { SolanaService } from './solana/service';
import type { PerRuntime } from './per/service';

/** A service whose implementation loads on first use (a separate chunk). */
export interface LazyService<T> {
  readonly loaded: T | null;
  get(): Promise<T>;
}

declare module '../app/app' {
  interface Services {
    web3Config?: Web3Config;
    solana?: SolanaService;
    per?: LazyService<PerRuntime>;
  }
}

export interface Web3Services {
  web3Config: Web3Config;
  solana: SolanaService;
  per: LazyService<PerRuntime>;
}

export function w3(ctx: AppContext): Web3Services {
  const s = ctx.services;
  if (!s.web3Config || !s.solana || !s.per) throw new Error('[web3] the web3 module is not installed');
  return s as Web3Services;
}
