# Agents on the table server

No browser APIs in this folder: it runs in Node (the WebSocket table server in `web/server/`) and in the browser's
local backend alike.

| File | Unity source |
|---|---|
| `agentTableHost.ts` | the Agent parts of `PokerServerGame.cs` (SeatAgent, TrySeatSharedAgent, Begin/CompleteAgentHandTelemetry, EvaluateAgentLimitsAfterHand, TryHaltAgentsForOwners), `AgentFarmLink` progress body |
| `agentFarm.ts` | backend `services/agentDeployments.ts` + `/api/agent/*` and `/internal/agent/*` rules, in memory (queue, claim, progress fencing, stop, complete, history, hands) |
| `localAgentRunner.ts` | a headless Quick Play dedicated server for Agents: filler pack (TuneQuickPlayBots), BustOutSeats, the AgentFarmLink sync loop, hands on a schedule with catch-up |

## Hook for a table server that seats Agents at its own Quick Play tables

```ts
const agents = new AgentTableHost({ engine, seatCount, tableName: () => name, reporter, botSeed });
// claim (every few seconds, between hands or not):
if (agents.canAcceptSharedAgent(emptyChairs + fillerChairs)) {
  const cfg = farm.claim(name, stake.minBuyIn, { agents: agents.agentsSeated, cap: AgentSessionHost.maxAgentsPerTable(seatCount) });
  if (cfg && !agents.trySeatSharedAgent(cfg, ownerSeatedHere)) farm.release(cfg.DeploymentId!, name);
}
// hand boundary (seats unlocked):
for (const a of agents.activatePending(allocateSeat, ownerSeatedHere)) router.set(a.seat, new BotActionProvider(a.bot, min, max));
// before StartHand:
agents.beginHand(); for (const s of agents.haltForOwners()) vacateIfStill(s.seat, s.playerId);
// every engine event, before broadcasting it:
agents.observe(e);
// after HandEnded:
agents.completeHand(); for (const s of agents.evaluateAfterHand()) vacateIfStill(s.seat, s.playerId);
// sync loop (3 s): farm.updateProgress(agents.progressBody(a), name); control → agents.requestStop(id)
// shutdown: agents.haltAll()
```

`reporter` receives each settled hand (record + privacy-filtered replay JSON) and each finished deployment; point it at
an `AgentFarm` (in-process) or at the backend's `/internal/agent/hand` and `/complete`. Never seat an owner at a table
where their own Agent plays (`agents.agents.hasAgentOf(playFabId)`): they spectate instead (review H2).
