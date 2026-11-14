import { bindings, defineConfig, exports, triggers } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * The game server Worker and its table Durable Object. Modes: `development` (cf dev, local D1/R2), `staging`,
 * `production`. Shares the API's D1 database (sessions, ledger) and R2 bucket (hand histories).
 * Secrets (DRAIN_TOKEN) come from .secrets.<mode>.json at deploy (git-ignored).
 */

const ACCOUNT_ID = 'a5e26389a89c0c84a7b4939e38574714';

// The NEAR fork has its own Workers, database, bucket and rate-limit namespaces, so nothing deployed from here can
// touch the live Nomad Poker app (nomad-poker-game*, the nomad-poker-staging / -production databases).
const STAGES = {
  development: {
    worker: 'nomad-poker-near-game-dev',
    d1: { id: '50f75a10-aabe-4ffc-874a-30e2565d2934', name: 'nomad-poker-near-staging' },
    r2: 'nomad-poker-near-hands-staging',
    origins: ['http://localhost:5180', 'http://127.0.0.1:5180', 'http://localhost:5183'],
    qa: true,
    limiter: '7207',
  },
  staging: {
    worker: 'nomad-poker-near-game-staging',
    d1: { id: '50f75a10-aabe-4ffc-874a-30e2565d2934', name: 'nomad-poker-near-staging' },
    r2: 'nomad-poker-near-hands-staging',
    origins: ['https://nomad-poker-near.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180', 'capacitor://localhost', 'https://localhost'],
    qa: true,
    limiter: '7208',
  },
  production: {
    // Not set up yet: create the database and bucket, put the database id here and list the production web origin.
    worker: 'nomad-poker-near-game',
    d1: { id: '', name: 'nomad-poker-near-production' },
    r2: 'nomad-poker-near-hands-production',
    origins: [] as string[],
    qa: false,
    limiter: '7209',
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
      // The minute sweep: Agents waiting for a seat, Agents on a lost table, the tournament clock.
      triggers: [triggers.scheduled({ schedule: '* * * * *' })],
      exports: {
        TableRoom: exports.durableObject({ storage: 'sqlite' }),
      },
      env: {
        DB: bindings.d1(s.d1),
        HANDS: bindings.r2({ name: s.r2 }),
        TABLES: bindings.durableObject({ worker: s.worker, exportName: 'TableRoom' }),
        STAGE: bindings.text(stage),
        ALLOWED_ORIGINS: bindings.text(s.origins.join(',')),
        ALLOW_NO_ORIGIN: bindings.text(s.qa ? '1' : ''),
        QA_ROOMS: bindings.text(s.qa ? '1' : ''),
        QA_ROOM_SPEED: bindings.text('20'),
        DRAIN_TOKEN: bindings.secret(),
        // Table voice relay (Cloudflare Realtime TURN key "nomad-poker voice"), from .secrets.<stage>.json.
        TURN_KEY_ID: bindings.secret(),
        TURN_KEY_TOKEN: bindings.secret(),
        // Room spawns, overflow lookups and Agent starts: 30 a minute per address.
        HTTP_LIMITER: bindings.rateLimit({ namespace: s.limiter, simple: { limit: 30, period: 60 } }),
        // NEAR money tables (testnet): this server operates the escrow. The operator's key is a secret
        // (NEAR_OPERATOR_KEY in .secrets.<stage>.json, `ed25519:…`); without it the poker-money-… tables stay closed.
        ...(stage === 'production'
          ? {}
          : {
              NEAR_RPC_URL: bindings.text('https://test.rpc.fastnear.com'),
              NEAR_ESCROW: bindings.text('nomad-escrow.testnet'),
              NEAR_OPERATOR_ACCOUNT: bindings.text('nomad-poker.testnet'),
              NEAR_OPERATOR_KEY: bindings.secret(),
            }),
        // Operator alerts by email (src/alerts.ts): ledger problems, tables that gave up, a daily all-clear. The inbox is
        // the ALERT_TO secret (.secrets.production.json), a verified Email Routing destination.
        ...(stage === 'production'
          ? { ALERT_EMAIL: bindings.sendEmail({ allowedSenderAddresses: ['alerts@nomadpoker.fun'] }), ALERT_FROM: bindings.text('Nomad Poker alerts <alerts@nomadpoker.fun>'), ALERT_TO: bindings.secret() }
          : {}),
      },
    },
  };
});
