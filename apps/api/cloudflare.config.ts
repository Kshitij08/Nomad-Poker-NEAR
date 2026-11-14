import { bindings, defineConfig } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * The API Worker. Modes: `development` (cf dev, local D1/R2), `staging`, `production` (cf deploy's default).
 * Resource ids are in infra/cloudflare.md. Deploy staging with `npm run deploy:staging` in this folder.
 */

const ACCOUNT_ID = 'a5e26389a89c0c84a7b4939e38574714';
/** Google OAuth client ids (public values): the web client (www.nomadpoker.fun, localhost:5180). */
const GOOGLE_CLIENT_IDS = ['114523122703-ps6fj6q10ofb9pkft4g1dd4rrnv9k01r.apps.googleusercontent.com'];
const EMAIL_SENDER = 'no-reply@nomadpoker.fun';

const STAGES = {
  development: {
    worker: 'nomad-poker-api-dev',
    d1: { id: 'c9570cef-7f57-4845-b503-03da7893d36d', name: 'nomad-poker-staging' },
    r2: 'nomad-poker-hands-staging',
    origins: ['http://localhost:5180', 'http://127.0.0.1:5180'],
    limiterNamespace: '7101',
    writeLimiterNamespace: '7104',
    emailDevEcho: '1',
    // Test runs: tournaments may start a minute out; market strategies qualify after 100 hands, no waiting days.
    tournamentMinLead: '60',
    listingMinHands: '100',
    listingMinDays: '0',
    // Local SOL shop tests pay the same devnet treasury as staging, read through Solana's public devnet RPC.
    shopTreasury: 'GV5LYvyakPHtjNWENbFKnfyG2NuMLkL6xYPxo6YyEcJw',
  },
  staging: {
    worker: 'nomad-poker-api-staging',
    d1: { id: 'c9570cef-7f57-4845-b503-03da7893d36d', name: 'nomad-poker-staging' },
    r2: 'nomad-poker-hands-staging',
    origins: ['https://nomad-poker-web.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180', 'capacitor://localhost', 'https://localhost'],
    limiterNamespace: '7102',
    writeLimiterNamespace: '7105',
    emailDevEcho: '1',
    tournamentMinLead: '60',
    listingMinHands: '100',
    listingMinDays: '0',
    // SOL shop purchases (devnet) pay the PER keeper key, a devnet key the project controls (apps/per health shows it).
    shopTreasury: 'GV5LYvyakPHtjNWENbFKnfyG2NuMLkL6xYPxo6YyEcJw',
  },
  production: {
    worker: 'nomad-poker-api',
    d1: { id: 'e630e086-697c-47c7-84c3-8ad467005c34', name: 'nomad-poker-production' },
    r2: 'nomad-poker-hands-production',
    // The public site (nomadpoker.fun redirects to www) and the Vercel address it is served from.
    origins: ['https://www.nomadpoker.fun', 'https://nomadpoker.fun', 'https://nomad-poker-web.vercel.app', 'capacitor://localhost', 'https://localhost'],
    limiterNamespace: '7103',
    writeLimiterNamespace: '7106',
    emailDevEcho: '',
    tournamentMinLead: '',
    listingMinHands: '',
    listingMinDays: '',
    shopTreasury: '',
  },
} as const;

export default defineConfig(({ mode }) => {
  const stage = mode === 'staging' || mode === 'development' ? mode : 'production';
  const s = STAGES[stage];
  return {
    accountId: ACCOUNT_ID,
    worker: {
      name: s.worker,
      entrypoint,
      compatibilityDate: '2026-09-20',
      observability: { enabled: true },
      env: {
        DB: bindings.d1(s.d1),
        HANDS: bindings.r2({ name: s.r2 }),
        AUTH_LIMITER: bindings.rateLimit({ namespace: s.limiterNamespace, simple: { limit: 30, period: 60 } }),
        // Every other write (rewards, friends, invites, tournaments, strategies): 60 a minute per session.
        WRITE_LIMITER: bindings.rateLimit({ namespace: s.writeLimiterNamespace, simple: { limit: 60, period: 60 } }),
        STAGE: bindings.text(stage),
        ALLOWED_ORIGINS: bindings.text(s.origins.join(',')),
        WALLET_CHAIN_ID: bindings.text('devnet'),
        EMAIL_DEV_ECHO: bindings.text(s.emailDevEcho),
        // Google sign-in: the web client id (public). Android / iOS client ids join this list when those apps get one.
        GOOGLE_CLIENT_IDS: bindings.text(GOOGLE_CLIENT_IDS.join(',')),
        // Production mails the email sign-in links through Cloudflare Email Service (nomadpoker.fun is onboarded as a
        // sending domain); staging and dev hand the link back instead (EMAIL_DEV_ECHO).
        ...(stage === 'production'
          ? { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [EMAIL_SENDER] }), EMAIL_FROM: bindings.text(`Nomad Poker <${EMAIL_SENDER}>`) }
          : {}),
        SPIN_SECRET: bindings.secret(),
        TOURNAMENT_MIN_LEAD_SECONDS: bindings.text(s.tournamentMinLead),
        LISTING_MIN_HANDS: bindings.text(s.listingMinHands),
        LISTING_MIN_DAYS: bindings.text(s.listingMinDays),
        // The shop's SOL purchases (devnet only): the treasury, and the RPC URL as a secret on staging.
        SHOP_TREASURY: bindings.text(s.shopTreasury),
        ...(stage === 'staging' ? { SOLANA_RPC_URL: bindings.secret() } : {}),
        ...(stage === 'development' ? { SOLANA_RPC_URL: bindings.text('https://api.devnet.solana.com') } : {}),
      },
    },
  };
});
