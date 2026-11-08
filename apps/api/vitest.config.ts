import { defineConfig } from 'vitest/config';

// Tests run in Node against a D1 stand-in on node:sqlite (src/__tests__/d1Shim.ts), without the Cloudflare Vite
// plugin that vite.config.ts loads for `cf dev` / `cf build`.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
