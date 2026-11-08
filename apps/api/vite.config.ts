import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// Builds and serves the Worker described by cloudflare.config.ts (`cf dev`, `cf build`).
export default defineConfig({
  server: { port: 8788, strictPort: true },
  plugins: [cloudflare()],
});
