/**
 * Port of Economy/Contracts/PlayFabConfig.cs plus the web port's backend switch.
 *
 * BACKEND MODES (PORTING-RULES "Backends"): live PlayFab is OFF by default.
 *   offline (default)  LocalVirtualWallet + a local guest account. No network at all.
 *   ?online=local      The PlayFab client code paths, run against an in-browser emulation of the title
 *                      (economy/playfab/localTitle.ts, kept in localStorage). No network at all.
 *   ?online=1          The real PlayFab title over HTTPS (client API only). Needs ALLOW_LIVE_PLAYFAB = true too.
 */

export const PlayFabConfig = {
  /** PlayFab title. Public by design — this is not a credential. */
  TitleId: '6A5AE',
  /** Google Cloud OAuth 2.0 Web client id (public). */
  GoogleWebClientId: '917260482660-up0gh9tq8vsu7k11cbsqbjnhvji2ona0.apps.googleusercontent.com',
  /** Friendly id of the Economy v2 currency item. */
  CurrencyCode: 'CH',
  /** What a brand-new player starts with (granted by the ledger / grantStartingChips; shown before that). */
  StartingBalance: 10000,
  DefaultTierId: 'micro',
} as const;

export interface StakeTier {
  readonly id: string;
  readonly displayName: string;
  readonly buyInChips: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
}

const TIERS: Readonly<Record<string, StakeTier>> = {
  micro: { id: 'micro', displayName: 'Micro', buyInChips: 1000, smallBlind: 10, bigBlind: 20 },
};

/** PlayFabConfig.Tier: the tier with this id, falling back to the default (never null). */
export function stakeTier(id?: string | null): StakeTier {
  return (id && TIERS[id]) || TIERS[PlayFabConfig.DefaultTierId]!;
}

/**
 * Second key for live PlayFab: `?online=1` alone is not enough while this is false. Flip it only on a branch that
 * is meant to talk to the real title (6A5AE) — see PORTING-RULES "Backends".
 */
export const ALLOW_LIVE_PLAYFAB = false;

export type BackendMode = 'offline' | 'local' | 'live';

export function backendMode(params: URLSearchParams): BackendMode {
  const v = params.get('online');
  if (v === 'local' || v === 'mock') return 'local';
  if (v === '1' || v === 'live') {
    if (ALLOW_LIVE_PLAYFAB) return 'live';
    console.warn('[Economy] ?online=1 ignored: ALLOW_LIVE_PLAYFAB is false (economy/config.ts). Using offline.');
  }
  return 'offline';
}
