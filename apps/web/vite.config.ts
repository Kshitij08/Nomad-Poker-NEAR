import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: true },
  test: { environment: 'node' },
} as any);
