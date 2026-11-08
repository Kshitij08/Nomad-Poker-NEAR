import { bindings, defineConfig } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * The API Worker. Modes: `development` (cf dev, local D1/R2), `staging`, `production` (cf deploy's default).
 * Resource ids are in infra/cloudflare.md. Deploy staging with `npm run deploy:staging` in this folder.
 */

const ACCOUNT_ID = 'a5e26389a89c0c84a7b4939e38574714';

const STAGES = {
  development: {
    worker: 'nomad-poker-api-dev',
    d1: { id: 'c9570cef-7f57-4845-b503-03da7893d36d', name: 'nomad-poker-staging' },
    r2: 'nomad-poker-hands-staging',
    origins: ['http://localhost:5180', 'http://127.0.0.1:5180'],
    limiterNamespace: '7101',
    emailDevEcho: '1',
    // Test runs: tournaments may start a minute out; market strategies qualify after 100 hands, no waiting days.
    tournamentMinLead: '60',
    listingMinHands: '100',
    listingMinDays: '0',
  },
  staging: {
    worker: 'nomad-poker-api-staging',
    d1: { id: 'c9570cef-7f57-4845-b503-03da7893d36d', name: 'nomad-poker-staging' },
    r2: 'nomad-poker-hands-staging',
    origins: ['https://nomad-poker-web.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180', 'capacitor://localhost', 'https://localhost'],
    limiterNamespace: '7102',
    emailDevEcho: '1',
    tournamentMinLead: '60',
    listingMinHands: '100',
    listingMinDays: '0',
  },
  production: {
    worker: 'nomad-poker-api',
    d1: { id: 'e630e086-697c-47c7-84c3-8ad467005c34', name: 'nomad-poker-production' },
    r2: 'nomad-poker-hands-production',
    origins: ['https://nomad-poker-web.vercel.app', 'capacitor://localhost', 'https://localhost'],
    limiterNamespace: '7103',
    emailDevEcho: '',
    tournamentMinLead: '',
    listingMinHands: '',
    listingMinDays: '',
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
        STAGE: bindings.text(stage),
        ALLOWED_ORIGINS: bindings.text(s.origins.join(',')),
        WALLET_CHAIN_ID: bindings.text('devnet'),
        EMAIL_DEV_ECHO: bindings.text(s.emailDevEcho),
        SPIN_SECRET: bindings.secret(),
        TOURNAMENT_MIN_LEAD_SECONDS: bindings.text(s.tournamentMinLead),
        LISTING_MIN_HANDS: bindings.text(s.listingMinHands),
        LISTING_MIN_DAYS: bindings.text(s.listingMinDays),
      },
    },
  };
});
