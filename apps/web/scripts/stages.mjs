// The deployed stages the web build can be wired to (deploy-vercel.mjs, serve-dist.mjs).
export const STAGES = {
  staging: {
    VITE_API_URL: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev',
    VITE_NET_SERVER: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev',
    // Private tables (PER) on the new stack's program instance and service (apps/per).
    VITE_PER_PROGRAM: 'nomad',
    VITE_PER_BACKEND: 'https://nomad-poker-per-staging.kshitijiitgn.workers.dev',
  },
};
