// The deployed stages the web build can be wired to (deploy-vercel.mjs, serve-dist.mjs).
export const STAGES = {
  staging: {
    VITE_API_URL: 'https://nomad-poker-api-staging.kshitijiitgn.workers.dev',
    VITE_NET_SERVER: 'https://nomad-poker-game-staging.kshitijiitgn.workers.dev',
  },
};
