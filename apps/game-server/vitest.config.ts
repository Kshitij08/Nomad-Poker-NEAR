import { defineConfig } from 'vitest/config';

// Tests run in Node: the table host over the node:sqlite D1 stand-in, with real table play and the real client.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 60_000 },
});
