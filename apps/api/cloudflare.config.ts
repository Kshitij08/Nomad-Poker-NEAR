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

// The NEAR fork has its own Workers, database, bucket and rate-limit namespaces, so nothing deployed from here can
// touch the live Nomad Poker app (nomad-poker-api*, the nomad-poker-staging / -production databases).
const STAGES = {
  development: {
    worker: 'nomad-poker-near-api-dev',
    d1: { id: '50f75a10-aabe-4ffc-874a-30e2565d2934', name: 'nomad-poker-near-staging' },
    r2: 'nomad-poker-near-hands-staging',
    origins: ['http://localhost:5180', 'http://127.0.0.1:5180'],
    limiterNamespace: '7201',
    writeLimiterNamespace: '7204',
    emailDevEcho: '1',
    // Test runs: tournaments may start a minute out; market strategies qualify after 100 hands, no waiting days.
    tournamentMinLead: '45',
    listingMinHands: '100',
    listingMinDays: '0',
    // Local SOL shop tests pay the same devnet treasury as staging, read through Solana's public devnet RPC.
    shopTreasury: 'GV5LYvyakPHtjNWENbFKnfyG2NuMLkL6xYPxo6YyEcJw',
  },
  staging: {
    worker: 'nomad-poker-near-api-staging',
    d1: { id: '50f75a10-aabe-4ffc-874a-30e2565d2934', name: 'nomad-poker-near-staging' },
    r2: 'nomad-poker-near-hands-staging',
    origins: ['https://nomad-poker-near.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180', 'capacitor://localhost', 'https://localhost'],
    limiterNamespace: '7202',
    writeLimiterNamespace: '7205',
    emailDevEcho: '1',
    tournamentMinLead: '45',
    listingMinHands: '100',
    listingMinDays: '0',
    // SOL shop purchases (devnet) pay the PER keeper key, a devnet key the project controls (apps/per health shows it).
    shopTreasury: 'GV5LYvyakPHtjNWENbFKnfyG2NuMLkL6xYPxo6YyEcJw',
  },
  production: {
    // Not set up yet: create the database and bucket, put the database id here and list the production web origin.
    worker: 'nomad-poker-near-api',
    d1: { id: '', name: 'nomad-poker-near-production' },
    r2: 'nomad-poker-near-hands-production',
    origins: [] as string[],
    limiterNamespace: '7203',
    writeLimiterNamespace: '7206',
    emailDevEcho: '',
    // A tournament may start a minute from now (the host's "In 1 min"); 45 s leaves room for the request's trip.
    tournamentMinLead: '45',
    listingMinHands: '',
    listingMinDays: '',
    shopTreasury: '',
  },
} as const;

export default defineConfig(({ mode }) => {
  const stage = mode === 'staging' || mode === 'development' ? mode : 'production';
  const s = STAGES[stage];
  if (!s.d1.id) throw new Error(`The NEAR fork has no ${stage} database yet: create one and set its id in cloudflare.config.ts`);
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
