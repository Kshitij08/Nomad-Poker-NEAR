import { bindings, defineConfig, defineContainer, exports, triggers } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/**
 * The PER service Worker and its container (Phase 6, PER on the new stack). Staging only for now: it runs the new
 * devnet program instance 7LcbAnHB…LKBn (Poker/per, deployed 9 Nov) with its own keeper and auditor keys.
 * Secrets (keeper / auditor keys, archive key, admin token, the devnet RPC URL) come from .secrets.<mode>.json at
 * deploy (git-ignored) and are handed to the container when it starts.
 */

const ACCOUNT_ID = 'a5e26389a89c0c84a7b4939e38574714';

const STAGES = {
  staging: {
    worker: 'nomad-poker-per-staging',
    // In Eastern North America, next to where the container runs (ORD): every keeper query crosses this hop, and
    // from APAC it cost ~220 ms each (the keeper missed a hand log in the 9 Nov staging run).
    d1: { id: '72ffcb24-562f-4e46-88b7-caee6018eee0', name: 'nomad-poker-per-staging-us' },
    limiter: '7110',
  },
} as const;

const per = defineContainer({
  name: 'nomad-poker-per-staging',
  image: { dockerfile: './container/Dockerfile', buildContext: './container' },
  // One instance: the keeper and the Agent runner must never run twice (a D1 lease also guards a deploy's overlap).
  maxInstances: 1,
  instanceType: 'basic',
});

export default defineConfig(() => {
  // This is the Solana private-table service of the live Nomad Poker app. The NEAR fork does not run it, and deploying
  // it from here would replace the live Worker, so it refuses.
  throw new Error('apps/per is the live Solana private-table service: the NEAR fork does not deploy it');
  const s = STAGES.staging;
  return {
    accountId: ACCOUNT_ID,
    containers: [per],
    worker: {
      name: s.worker,
      entrypoint,
      compatibilityDate: '2026-09-20',
      observability: { enabled: true },
      triggers: [triggers.scheduled({ schedule: '* * * * *' })],
      exports: {
        PerService: exports.durableObject({ storage: 'sqlite', container: per }),
      },
      env: {
        DB: bindings.d1(s.d1),
        PER: bindings.durableObject({ worker: s.worker, exportName: 'PerService' }),
        STAGE: bindings.text('staging'),
        LIMITER: bindings.rateLimit({ namespace: s.limiter, simple: { limit: 120, period: 60 } }),
        KEEPER_SECRET_KEY: bindings.secret(),
        AUDITOR_SECRET_KEY: bindings.secret(),
        ARCHIVE_KEY_HEX: bindings.secret(),
        ADMIN_TOKEN: bindings.secret(),
        SOLANA_RPC_URL: bindings.secret(),
      },
    },
  };
});
