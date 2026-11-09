import { defineConfig } from 'vitest/config';

// The Worker's lobby routes and the D1 bridge, in Node over the node:sqlite D1 stand-in.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 30_000 },
});
