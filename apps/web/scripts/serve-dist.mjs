#!/usr/bin/env node
// Serves apps/web/dist with the production security headers (securityHeaders.mjs), to check a build against its
// Content-Security-Policy before deploying it:
//   VITE_API_URL=… VITE_NET_SERVER=… npm run build && node scripts/serve-dist.mjs staging [port=5190]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './securityHeaders.mjs';
import { STAGES } from './stages.mjs';

const stage = STAGES[process.argv[2] ?? 'staging'];
if (!stage) throw new Error(`unknown stage ${process.argv[2]}`);
const port = Number(process.env.PORT ?? process.argv[3] ?? 5180);
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const headers = securityHeaders({ api: stage.VITE_API_URL, game: stage.VITE_NET_SERVER });
headers['Strict-Transport-Security'] = undefined; // plain http locally
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '');
  let file = join(root, path);
  try {
    if (!(await stat(file)).isFile()) file = join(root, 'index.html');
  } catch {
    file = join(root, 'index.html');
  }
  const body = await readFile(file);
  const h = { 'content-type': types[extname(file)] ?? 'application/octet-stream' };
  for (const [k, v] of Object.entries(headers)) if (v) h[k] = v;
  res.writeHead(200, h).end(body);
}).listen(port, () => console.log(`dist with security headers on http://localhost:${port}`));
