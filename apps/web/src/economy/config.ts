/**
 * Economy constants for the local (offline / local table server) economy. With a Nomad server configured the
 * server's catalogues apply (packages/contract STARTER_GRANT, the engine's retention catalogues); PlayFab is gone.
 */

export const EconomyConfig = {
  /** What a brand-new local player starts with (the Nomad server's STARTER_GRANT is the same 10,000). */
  StartingBalance: 10000,
} as const;
