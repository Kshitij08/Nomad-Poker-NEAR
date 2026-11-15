// The deployed stages the web build can be wired to (deploy-vercel.mjs, serve-dist.mjs).
export const STAGES = {
  staging: {
    VITE_API_URL: 'https://nomad-poker-near-api-staging.kshitijiitgn.workers.dev',
    VITE_NET_SERVER: 'https://nomad-poker-near-game-staging.kshitijiitgn.workers.dev',
    // The UI style picker (src/ui2/themes) on staging, to compare the variations before one is chosen.
    VITE_DESIGN_OPTIONS: '1',
  },
  // The public site: the production Workers and database. No UI style picker.
  production: {
    VITE_API_URL: 'https://nomad-poker-near-api.kshitijiitgn.workers.dev',
    VITE_NET_SERVER: 'https://nomad-poker-near-game.kshitijiitgn.workers.dev',
  },
};
