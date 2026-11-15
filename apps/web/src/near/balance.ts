/**
 * The NEAR side of On-chain mode: the NEAR account you signed in to Nomad with, and its escrow game balance for the
 * top bar's capsule. Read on demand and cached; `refreshNearBalance` re-reads it (after a deposit, a cash-out…).
 */
import { getBalance } from './escrow';

type MeLike = { identities?: { provider: string; label: string }[] } | null | undefined;

/** The NEAR account linked to this Nomad account, or null (not signed in with NEAR). */
export function nearIdentityOf(me: MeLike): string | null {
  return me?.identities?.find((i) => i.provider === 'near')?.label ?? null;
}

let cached: { account: string; yocto: bigint } | null = null;
let reading: Promise<void> | null = null;

/** The last balance read for `account` (yoctoNEAR), or null when none was read yet. */
export function nearBalance(account: string | null): bigint | null {
  return account && cached?.account === account ? cached.yocto : null;
}

/** Reads `account`'s game balance again; `done` runs once it changed. */
export function refreshNearBalance(account: string | null, done?: () => void): Promise<void> {
  if (!account) return Promise.resolve();
  reading ??= getBalance(account)
    .then((yocto) => {
      const changed = cached?.account !== account || cached.yocto !== yocto;
      cached = { account, yocto };
      if (changed) done?.();
    })
    .catch(() => undefined)
    .finally(() => (reading = null));
  return reading;
}
