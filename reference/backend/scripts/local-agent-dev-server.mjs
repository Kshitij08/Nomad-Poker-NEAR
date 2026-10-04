import express from 'express';

const app = express();
app.use(express.json());

const port = Number(process.env.PORT || 8787);
// Mock stats cadence only. The real Unity dedicated agent table advances on actual poker hands.
// Default to a slower pace so Editor UI testing does not look like hands are teleporting.
const mockHandSeconds = Math.max(5, Number(process.env.AGENT_MOCK_HAND_SECONDS || 20));
const sessions = new Map();

function now() { return Date.now(); }
function clampSession(raw) { return String(raw || '').trim().toUpperCase(); }
function publicRoom(s) {
  return {
    session: s.session,
    status: s.status,
    mode: 'free',
    kind: 'agent',
    error: '',
    ownerId: s.ownerId,
    deploymentId: s.deploymentId,
    agentName: s.agentName,
    profile: s.profile,
    strategyVersion: s.strategyVersion,
    bankroll: s.bankroll,
    maxHands: s.maxHands,
    maxRuntime: s.maxRuntime,
    stopLoss: s.stopLoss,
    profitTarget: s.profitTarget,
    fillers: s.fillers,
    stake: s.stake,
  };
}
function progressOf(s) {
  return {
    session: s.session,
    running: !s.result,
    stopRequested: s.stopRequested && !s.result,
    HandsPlayed: s.hands,
    MaxHands: s.maxHands,
    StartingBankroll: s.bankroll,
    Stack: s.stack,
    NetPnl: s.stack - s.bankroll,
    RuntimeSeconds: Math.max(0, (now() - s.startedAt) / 1000),
    updatedAt: now(),
  };
}
function complete(s, reason) {
  if (s.result) return s.result;
  s.result = {
    session: s.session,
    SessionName: s.session,
    DeploymentId: s.deploymentId,
    OwnerPlayFabId: s.ownerId,
    StrategyPreset: s.profile,
    StrategyVersion: s.strategyVersion,
    StopReason: reason,
    HandsPlayed: s.hands,
    StartingBankroll: s.bankroll,
    EndingStack: Math.max(0, s.stack),
    NetPnl: Math.max(0, s.stack) - s.bankroll,
    RuntimeSeconds: Math.max(0, (now() - s.startedAt) / 1000),
    CompletedUnix: Math.floor(now() / 1000),
    updatedAt: now(),
  };
  s.stopRequested = false;
  return s.result;
}

setInterval(() => {
  for (const s of sessions.values()) {
    if (s.result) continue;
    const elapsed = (now() - s.startedAt) / 1000;
    const due = Math.floor(elapsed / mockHandSeconds);
    while (s.hands < due) {
      s.hands += 1;
      s.stack += s.hands % 2 ? 25 : -10;
    }
    if (s.stopRequested && s.hands >= 1) complete(s, 'owner_stop');
    else if (s.hands >= s.maxHands) complete(s, 'max_hands');
    else if (s.stack <= 0) complete(s, 'bust');
  }
}, 250);

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

app.post('/api/agent/start', (req, res) => {
  const session = clampSession(req.body?.session);
  if (!/^[A-Z0-9]{4,16}$/.test(session)) return res.status(400).json({ error: 'Invalid agent session code' });
  let s = sessions.get(session);
  if (!s) {
    s = {
      session,
      status: 'ready',
      ownerId: String(req.body?.ownerId || 'local-owner'),
      deploymentId: String(req.body?.deploymentId || session),
      agentName: String(req.body?.agentName || 'Local Agent'),
      profile: String(req.body?.profile || 'balanced'),
      strategyVersion: String(req.body?.strategyVersion || 'local-dev'),
      bankroll: Math.max(50, Number(req.body?.bankroll) || 500),
      maxHands: Math.max(1, Number(req.body?.maxHands) || 3),
      maxRuntime: Math.max(60, Number(req.body?.maxRuntime) || 60),
      stopLoss: Math.max(0, Number(req.body?.stopLoss) || 0),
      profitTarget: Math.max(0, Number(req.body?.profitTarget) || 0),
      fillers: Math.max(1, Math.min(5, Number(req.body?.fillers) || 1)),
      stake: Math.max(50, Number(req.body?.stake) || 50),
      startedAt: now(),
      hands: 0,
      stack: Math.max(50, Number(req.body?.bankroll) || 500),
      stopRequested: false,
      result: null,
    };
    sessions.set(session, s);
    console.log(`[agent-dev] started ${session} bankroll=${s.bankroll} maxHands=${s.maxHands}`);
  }
  res.json(publicRoom(s));
});

app.get('/api/party/status', (req, res) => {
  const session = clampSession(req.query.session);
  const s = sessions.get(session);
  if (!s) return res.status(404).json({ error: 'Unknown party session' });
  res.json(publicRoom(s));
});

app.get('/api/agent/progress', (req, res) => {
  const session = clampSession(req.query.session);
  const s = sessions.get(session);
  if (!s) return res.status(404).json({ error: 'No progress yet' });
  res.json(progressOf(s));
});

app.post('/api/agent/stop', (req, res) => {
  const session = clampSession(req.body?.session);
  const s = sessions.get(session);
  if (!s) {
    console.log(`[agent-dev] stop requested for unknown session ${session || '(blank)'}`);
    return res.status(404).json({ error: 'No local mock agent is farming. In Unity use Tools > Poker > Agents > Clear Local Agent State, then deploy again.' });
  }
  s.stopRequested = true;
  console.log(`[agent-dev] stop requested ${session}`);
  res.json(progressOf(s));
});

app.get('/api/agent/result', (req, res) => {
  const session = clampSession(req.query.session);
  const s = sessions.get(session);
  if (!s || !s.result) return res.status(404).json({ error: 'No result yet' });
  res.json(s.result);
});

app.listen(port, '127.0.0.1', () => {
  console.log(`[agent-dev] local AFK agent backend listening at http://127.0.0.1:${port}`);
  console.log('[agent-dev] Use Unity menu: Tools > Poker > Agents > Use Local Agent Backend');
});
