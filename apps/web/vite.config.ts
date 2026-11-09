import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: true },
  build: {
    // The boot bundle is mostly data every first screen needs (menu, HUD and table JSON from the Unity extractors,
    // ~3.4 MB raw, ~15x smaller gzipped) plus three.js. Splitting them out does not shrink the first load, but each
    // chunk keeps its hash across deploys that do not touch it, so returning players re-download only what changed.
    // The largest data chunk (menu-ui.json, ~1.3 MB raw / ~80 KB gzip) sets the warning limit.
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      // Two pages: the game, and the support page (admin.html, src/admin/), which shares none of the game's chunks.
      input: { main: 'index.html', admin: 'admin.html' },
      output: {
        manualChunks(id: string) {
          const p = id.split('\\').join('/');
          if (p.includes('/node_modules/three/')) return 'three';
          const m = /\/src\/data\/([\w-]+)\.json$/.exec(p);
          if (m && !m[1].startsWith('web3-')) return `data-${m[1]}`; // web3 IDLs stay in the lazy web3 chunks
          return undefined;
        },
      },
    },
  },
  test: { environment: 'node' },
} as any);
