import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// Builds and serves the Worker described by cloudflare.config.ts.
export default defineConfig({
  server: { port: 8789, strictPort: true },
  plugins: [cloudflare()],
});
