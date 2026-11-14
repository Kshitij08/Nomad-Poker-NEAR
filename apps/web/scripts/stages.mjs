// The deployed stages the web build can be wired to (deploy-vercel.mjs, serve-dist.mjs).
export const STAGES = {
  staging: {
    VITE_API_URL: 'https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev',
    VITE_NET_SERVER: 'https://nomad-poker-near-game-staging.kshitijiitgn.workers.dev',
    // Private tables (PER) on the new stack's program instance and service (apps/per).
    VITE_PER_PROGRAM: 'nomad',
    VITE_PER_BACKEND: 'https://nomad-poker-per-staging.kshitijiitgn.workers.dev',
    // The UI style picker (src/ui2/themes) on staging, to compare the variations before one is chosen.
    VITE_DESIGN_OPTIONS: '1',
  },
  // The public site (www.nomadpoker.fun): the production Workers and database. SOL tables stay on devnet, so private
  // tables use the staging PER service (devnet program instance, CORS open). No UI style picker.
  production: {
    VITE_API_URL: 'https://nomad-poker-near-api.kshitijiitgn.workers.dev',
    VITE_NET_SERVER: 'https://nomad-poker-near-game.kshitijiitgn.workers.dev',
    VITE_PER_PROGRAM: 'nomad',
    VITE_PER_BACKEND: 'https://nomad-poker-per-staging.kshitijiitgn.workers.dev',
  },
};
