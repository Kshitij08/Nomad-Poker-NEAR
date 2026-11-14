import { bindings, defineConfig, exports, triggers } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * The game server Worker and its table Durable Object. Modes: `development` (cf dev, local D1/R2), `staging`,
 * `production`. Shares the API's D1 database (sessions, ledger) and R2 bucket (hand histories).
 * Secrets (DRAIN_TOKEN) come from .secrets.<mode>.json at deploy (git-ignored).
 */

const ACCOUNT_ID = 'a5e26389a89c0c84a7b4939e38574714';

const STAGES = {
  development: {
    worker: 'nomad-poker-game-dev',
    d1: { id: 'c9570cef-7f57-4845-b503-03da7893d36d', name: 'nomad-poker-staging' },
    r2: 'nomad-poker-hands-staging',
    origins: ['http://localhost:5180', 'http://127.0.0.1:5180'],
    qa: true,
    limiter: '7107',
  },
  staging: {
    worker: 'nomad-poker-game-staging',
    d1: { id: 'c9570cef-7f57-4845-b503-03da7893d36d', name: 'nomad-poker-staging' },
    r2: 'nomad-poker-hands-staging',
    origins: ['https://nomad-poker-web.vercel.app', 'http://localhost:5180', 'http://127.0.0.1:5180', 'capacitor://localhost', 'https://localhost'],
    qa: true,
    limiter: '7108',
  },
  production: {
    worker: 'nomad-poker-game',
    d1: { id: 'e630e086-697c-47c7-84c3-8ad467005c34', name: 'nomad-poker-production' },
    r2: 'nomad-poker-hands-production',
    // The public site (nomadpoker.fun redirects to www) and the Vercel address it is served from.
    origins: ['https://www.nomadpoker.fun', 'https://nomadpoker.fun', 'https://nomad-poker-web.vercel.app', 'capacitor://localhost', 'https://localhost'],
    qa: false,
    limiter: '7109',
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
        // Operator alerts by email (src/alerts.ts): ledger problems, tables that gave up, a daily all-clear. The inbox is
        // the ALERT_TO secret (.secrets.production.json), a verified Email Routing destination.
        ...(stage === 'production'
          ? { ALERT_EMAIL: bindings.sendEmail({ allowedSenderAddresses: ['alerts@nomadpoker.fun'] }), ALERT_FROM: bindings.text('Nomad Poker alerts <alerts@nomadpoker.fun>'), ALERT_TO: bindings.secret() }
          : {}),
      },
    },
  };
});
