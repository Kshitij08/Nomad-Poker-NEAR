import assert from 'node:assert/strict';
import express from 'express';

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'local-agent-smoke-key';
// createApiRouter constructs a pg Pool even for routes this smoke never calls.
// A syntactically valid local URL is enough; no DB connection is opened by these agent routes.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/poker_local_smoke';
process.env.DATABASE_SSL = process.env.DATABASE_SSL || 'false';

const { createApiRouter } = await import('../src/api/routes.ts');
const { createInternalRouter } = await import('../src/internalRoutes.ts');
const { requireInternalApiKey } = await import('../src/middleware/internalAuth.ts');

const app = express();
app.use(express.json());
app.use('/api', createApiRouter());
app.use('/internal', requireInternalApiKey, createInternalRouter());

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const keyHeader = { 'X-API-Key': process.env.INTERNAL_API_KEY };
const session = `AGNT${Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-8)}`.slice(0, 12);

async function json(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  assert.ok(res.ok, `${method} ${path} failed ${res.status}: ${text}`);
  return data;
}

try {
  const started = await json('POST', '/api/agent/start', {
    session,
    ownerId: 'local-owner',
    deploymentId: session,
    agentName: 'HTTP Smoke Agent',
    profile: 'balanced',
    strategyVersion: 'http-smoke',
    bankroll: 500,
    maxHands: 3,
    maxRuntime: 5,
    stopLoss: 100,
    profitTarget: 150,
    fillers: 1,
    stake: 50,
    hasCustom: true,
    foldBelow: 0.28,
    raiseAbove: 0.64,
    aggression: 0.61,
    bluffChance: 0.09,
    raiseFractionOfPot: 0.7,
  });
  assert.equal(started.session, session);
  assert.equal(started.status, 'pending');
  assert.equal(started.kind, 'agent');
  assert.equal(started.maxRuntime, 60);
  assert.equal(started.hasCustom, true);
  assert.equal(started.foldBelow, 0.28);
  assert.equal(started.aggression, 0.61);

  const claimed = await json('GET', '/internal/party/pending?mode=free', undefined, keyHeader);
  assert.equal(claimed.session, session);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.kind, 'agent');
  assert.equal(claimed.hasCustom, true);
  assert.equal(claimed.raiseFractionOfPot, 0.7);

  const ready = await json('POST', '/internal/party/ready', { session, ok: true }, keyHeader);
  assert.equal(ready.status, 'ready');

  const progress1 = await json('POST', '/internal/agent/progress', {
    session,
    running: true,
    HandsPlayed: 1,
    MaxHands: 3,
    StartingBankroll: 500,
    Stack: 540,
    NetPnl: 40,
    RuntimeSeconds: 2.2,
  }, keyHeader);
  assert.equal(progress1.stopRequested, false);
  assert.equal(progress1.HandsPlayed, 1);

  const publicProgress1 = await json('GET', `/api/agent/progress?session=${session}`);
  assert.equal(publicProgress1.Stack, 540);
  assert.equal(publicProgress1.NetPnl, 40);

  const stop = await json('POST', '/api/agent/stop', { session });
  assert.equal(stop.stopRequested, true);

  const control = await json('GET', `/internal/agent/control?session=${session}`, undefined, keyHeader);
  assert.equal(control.stopRequested, true);

  const progress2 = await json('POST', '/internal/agent/progress', {
    session,
    running: true,
    HandsPlayed: 2,
    MaxHands: 3,
    StartingBankroll: 500,
    Stack: 515,
    NetPnl: 15,
    RuntimeSeconds: 4.4,
  }, keyHeader);
  assert.equal(progress2.stopRequested, true);
  assert.equal(progress2.Stack, 515);

  const complete = await json('POST', '/internal/agent/complete', {
    session,
    SessionName: session,
    DeploymentId: session,
    StopReason: 'owner_stop',
    HandsPlayed: 2,
    StartingBankroll: 500,
    EndingStack: 515,
    NetPnl: 15,
    RuntimeSeconds: 4.7,
    CompletedUnix: Math.floor(Date.now() / 1000),
  }, keyHeader);
  assert.equal(complete.ok, true);

  const result = await json('GET', `/api/agent/result?session=${session}`);
  assert.equal(result.StopReason, 'owner_stop');
  assert.equal(result.EndingStack, 515);

  const finalProgress = await json('GET', `/api/agent/progress?session=${session}`);
  assert.equal(finalProgress.running, false);
  assert.equal(finalProgress.stopRequested, false);

  console.log(JSON.stringify({
    ok: true,
    base,
    session,
    endpoints: [
      'POST /api/agent/start',
      'GET /internal/party/pending',
      'POST /internal/party/ready',
      'POST /internal/agent/progress',
      'GET /api/agent/progress',
      'POST /api/agent/stop',
      'GET /internal/agent/control',
      'POST /internal/agent/complete',
      'GET /api/agent/result',
    ],
    stopControl: control,
    finalProgress,
    result,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
