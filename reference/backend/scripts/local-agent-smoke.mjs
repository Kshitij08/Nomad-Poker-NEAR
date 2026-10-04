import assert from 'node:assert/strict';
import {
  startAgent,
  claimNext,
  markReady,
  toPublic,
  saveAgentProgress,
  getAgentProgress,
  requestAgentStop,
  isAgentStopRequested,
  saveAgentResult,
  getAgentResult,
} from '../src/services/partySessions.ts';

const session = `AGNT${Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-8)}`.slice(0, 12);
const started = startAgent(session, 'free', {
  ownerId: 'local-owner',
  deploymentId: session,
  agentName: 'Local Smoke Agent',
  profile: 'balanced',
  strategyVersion: 'local-smoke',
  bankroll: 500,
  maxHands: 3,
  maxRuntime: 5,
  stopLoss: 100,
  profitTarget: 150,
  fillers: 1,
  stake: 50,
});

assert.equal(started.kind, 'agent');
assert.equal(started.status, 'pending');
assert.equal(started.agent.maxHands, 3);
assert.equal(started.agent.maxRuntime, 60, 'backend clamps maxRuntime to minimum 60s');
assert.equal(started.agent.fillers, 1);

const claimed = claimNext('free');
assert.equal(claimed.session, session);
assert.equal(claimed.status, 'claimed');
assert.equal(claimed.kind, 'agent');

const ready = markReady(session, true);
assert.equal(ready.status, 'ready');

const p1 = saveAgentProgress(session, {
  session,
  running: true,
  HandsPlayed: 1,
  MaxHands: 3,
  StartingBankroll: 500,
  Stack: 540,
  NetPnl: 40,
  RuntimeSeconds: 2.5,
});
assert.equal(p1.running, true);
assert.equal(p1.stopRequested, false);
assert.equal(p1.HandsPlayed, 1);
assert.equal(p1.Stack, 540);
assert.equal(getAgentProgress(session).NetPnl, 40);

const stop = requestAgentStop(session);
assert.equal(stop.stopRequested, true);
assert.equal(stop.running, true);
assert.equal(isAgentStopRequested(session), true);

const p2 = saveAgentProgress(session, {
  session,
  running: true,
  HandsPlayed: 2,
  MaxHands: 3,
  StartingBankroll: 500,
  Stack: 515,
  NetPnl: 15,
  RuntimeSeconds: 4.1,
});
assert.equal(p2.stopRequested, true, 'progress mirrors owner stop flag');
assert.equal(p2.HandsPlayed, 2);
assert.equal(p2.Stack, 515);

saveAgentResult(session, {
  session,
  SessionName: session,
  DeploymentId: session,
  StopReason: 'owner_stop',
  HandsPlayed: 2,
  StartingBankroll: 500,
  EndingStack: 515,
  NetPnl: 15,
  RuntimeSeconds: 4.3,
  CompletedUnix: Math.floor(Date.now() / 1000),
});

const result = getAgentResult(session);
assert.equal(result.StopReason, 'owner_stop');
assert.equal(result.EndingStack, 515);
assert.equal(result.NetPnl, 15);
assert.equal(isAgentStopRequested(session), false, 'completion clears stop flag');
assert.equal(getAgentProgress(session).running, false);
assert.equal(getAgentProgress(session).stopRequested, false);

console.log(JSON.stringify({
  ok: true,
  session,
  lifecycle: ['queued', 'claimed', 'ready', 'progress', 'stop-requested', 'progress-after-stop', 'completed'],
  publicRoom: toPublic(ready),
  finalProgress: getAgentProgress(session),
  result,
}, null, 2));
