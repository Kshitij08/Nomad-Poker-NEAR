/**
 * Runs the PER container's code on this machine, as the Worker would run it: a local D1 bridge (src/bridge.ts over
 * node:sqlite, the schema from migrations/, kept in .local-per.sqlite so a restart keeps its data) and the container
 * process with the stage's secrets (.secrets.<stage>.json). Real devnet and the real MagicBlock rollup.
 *
 *   npx tsx scripts/local.ts [stage=staging] [port=8091]
 *
 * The service answers on http://127.0.0.1:<port> (the Worker's routes, minus its rate limit).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bridgeResponse } from '../src/bridge';
import { lobbyRoute } from '../src/lobby';

const here = dirname(fileURLToPath(import.meta.url));
const stage = process.argv[2] ?? 'staging';
const port = Number(process.argv[3] ?? 8091);
const secrets = JSON.parse(readFileSync(join(here, '..', `.secrets.${stage}.json`), 'utf8')) as Record<string, string>;

// A file-backed D1 stand-in (D1Shim's statement rules over a file instead of :memory:).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(s: string): void } };
const { D1Shim } = await import('@nomad/db/testing/d1Shim');
const file = join(here, '..', '.local-per.sqlite');
const fresh = !existsSync(file);
const shim = new D1Shim();
(shim as unknown as { sqlite: unknown }).sqlite = new DatabaseSync(file);
if (fresh) for (const f of readdirSync(join(here, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort()) shim.sqlite.exec(readFileSync(join(here, '..', 'migrations', f), 'utf8'));
const db = shim as unknown as D1Database;

const toRequest = async (req: import('node:http').IncomingMessage) => {
  let body = '';
  for await (const c of req) body += c;
  return new Request(`http://local${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
};

const bridge = createServer(async (req, res) => {
  const r = await bridgeResponse(db, await toRequest(req));
  res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
});
await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', () => r()));
const bridgePort = (bridge.address() as { port: number }).port;

const containerPort = port + 1;
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: join(here, '..', 'container'),
  env: { ...process.env, ...secrets, PORT: String(containerPort), D1_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/query` },
  stdio: 'inherit',
});
child.on('exit', (code) => {
  console.log(`[local] container exited ${code}`);
  process.exit(code ?? 1);
});

// The Worker's routing: lobby reads from D1, everything else to the container.
createServer(async (req, res) => {
  const request = await toRequest(req);
  const url = new URL(request.url);
  let r = req.method === 'GET' ? await lobbyRoute(db, url) : null;
  if (!r) {
    const headers = new Headers(request.headers);
    headers.set('x-client-ip', req.socket.remoteAddress ?? 'local');
    r = await fetch(`http://127.0.0.1:${containerPort}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body, duplex: 'half' } as RequestInit).catch(
      () => Response.json({ error: 'container not up yet' }, { status: 503 }),
    );
  }
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'access-control-allow-origin': '*' }).end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`[local] PER service on http://127.0.0.1:${port} (D1 file ${file})`));

process.on('SIGINT', () => {
  child.kill();
  process.exit(0);
});
