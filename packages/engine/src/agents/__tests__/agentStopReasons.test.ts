import { describe, expect, it } from 'vitest';
import { AgentSession } from '../agentSession';
import { AgentStopReasons, newAgentDeploymentConfig } from '../agentDeploymentConfig';

/** A session with 1,000 starting chips; `now` is the clock it reads (seconds). */
function session(init: { MaxHands?: number; MaxRuntimeSeconds?: number; StopLoss?: number; ProfitTarget?: number }, now = () => 0) {
  return new AgentSession(newAgentDeploymentConfig({ Bankroll: 1000, MinBuyIn: 100, ...init }), now);
}

describe('Agent stop reasons', () => {
  it('stops at the stop loss when the loss reaches it, and not before', () => {
    const s = session({ StopLoss: 300, MaxHands: 50 });
    expect(s.evaluateAfterHand(701)).toBeNull();
    expect(s.evaluateAfterHand(700)).toBe(AgentStopReasons.StopLoss);
  });

  it('stops at the profit target, 0 meaning off', () => {
    expect(session({ ProfitTarget: 500, MaxHands: 50 }).evaluateAfterHand(1500)).toBe(AgentStopReasons.ProfitTarget);
    expect(session({ ProfitTarget: 0, StopLoss: 0, MaxHands: 50 }).evaluateAfterHand(9000)).toBeNull();
  });

  it('plays exactly the hand limit', () => {
    const s = session({ MaxHands: 3 });
    expect(s.evaluateAfterHand(1000)).toBeNull();
    expect(s.evaluateAfterHand(1000)).toBeNull();
    expect(s.evaluateAfterHand(1000)).toBe(AgentStopReasons.MaxHands);
  });

  it('reports what happened to the money on the last allowed hand, not the hand limit', () => {
    expect(session({ MaxHands: 1 }).evaluateAfterHand(0)).toBe(AgentStopReasons.Bust);
    expect(session({ MaxHands: 1, StopLoss: 200 }).evaluateAfterHand(500)).toBe(AgentStopReasons.StopLoss);
    expect(session({ MaxHands: 1, ProfitTarget: 200 }).evaluateAfterHand(1300)).toBe(AgentStopReasons.ProfitTarget);
    expect(session({ MaxHands: 1 }).evaluateAfterHand(1000)).toBe(AgentStopReasons.MaxHands);
  });

  it('stops on the time limit after the hand that crosses it', () => {
    let t = 0;
    const s = session({ MaxHands: 100, MaxRuntimeSeconds: 120 }, () => t);
    t = 60;
    expect(s.evaluateAfterHand(1000)).toBeNull();
    t = 121;
    expect(s.evaluateAfterHand(1000)).toBe(AgentStopReasons.MaxRuntime);
  });
});
