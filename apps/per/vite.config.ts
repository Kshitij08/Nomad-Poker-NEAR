import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// Builds the Worker described by cloudflare.config.ts (the container image is built by cf deploy from its Dockerfile).
export default defineConfig({
  server: { port: 8790, strictPort: true },
  plugins: [cloudflare()],
});
