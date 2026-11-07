import { describe, expect, it } from 'vitest';
import {
  AgentStrategyState, AGENT_NAME_KEY, AGENT_STRATEGY_KEY, AgentStrategyWords as W, BRAIN_CLASSIC, BRAIN_SMART, STRATEGY_CUSTOM,
  STRATEGY_PRESETS, buildAgentConfig, buildSessionCode, cleanAgentName, clampAgentConfig, newAgentDeploymentConfig, readNumberField,
  sharedAgentName, type KeyValueStore,
} from '../index';

class MemStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getString(k: string, fb = ''): string {
    return this.map.get(k) ?? fb;
  }
  setString(k: string, v: string): void {
    this.map.set(k, v);
  }
}

const f = Math.fround;

describe('AgentStrategyState', () => {
  it('starts on Autopilot with its own rounds and the smart brain', () => {
    const s = new AgentStrategyState(new MemStore());
    expect(s.style).toBe(0);
    expect(s.styleName).toBe('Autopilot');
    expect(s.values).toEqual(STRATEGY_PRESETS[0]);
    expect(s.brain).toBe(BRAIN_SMART);
    expect(s.hasStreets).toBe(true);
    expect(s.streetSnapshots()![0]).toMatchObject({ HasValue: true, FoldBelow: f(0.1) });
  });

  it('saves in the JsonUtility shape and loads it back; a preset reloads today’s numbers, Custom keeps its own', () => {
    const store = new MemStore();
    const s = new AgentStrategyState(store);
    s.applyAll(STRATEGY_CUSTOM, [0.2, 0.6, 0.5, 0.01, 0.7], 0.3, BRAIN_CLASSIC, [null, [0.4, 0.7, 0.4, 0, 0.5], null, null]);
    const json = store.getString(AGENT_STRATEGY_KEY);
    expect(json.startsWith('{"version":2,"style":4,"brain":0,"values":[0.2,0.6,0.5,0.01,0.7],"position":0.3,"s0":[],"s1":[0.4,0.7,0.4,0,0.5]')).toBe(true);
    expect(json.endsWith('"h0":false,"h1":true,"h2":false,"h3":false}')).toBe(true);
    const back = new AgentStrategyState(store);
    expect(back.style).toBe(STRATEGY_CUSTOM);
    expect(back.brain).toBe(BRAIN_CLASSIC);
    expect(back.values).toEqual([0.2, 0.6, 0.5, 0.01, 0.7].map(f));
    expect(back.streets[1]).toEqual([0.4, 0.7, 0.4, 0, 0.5].map(f));
    expect(back.positionWeight).toBe(f(0.3));

    s.pickStyle(3);
    const daredevil = new AgentStrategyState(store);
    expect(daredevil.styleName).toBe('Daredevil');
    expect(daredevil.values).toEqual(STRATEGY_PRESETS[3]);
    expect(daredevil.hasStreets).toBe(false);
  });

  it('maps version-1 saves (Guardian, Tactician, Daredevil, Custom) to the new styles', () => {
    const store = new MemStore();
    store.setString(AGENT_STRATEGY_KEY, '{"version":1,"style":2,"brain":2,"values":[0.1,0.5,0.5,0.1,0.5],"position":0}');
    expect(new AgentStrategyState(store).styleName).toBe('Daredevil');
    store.setString(AGENT_STRATEGY_KEY, '{"version":1,"style":0,"values":[0.1,0.5,0.5,0.1,0.5]}');
    expect(new AgentStrategyState(store).styleName).toBe('Guardian');
    store.setString(AGENT_STRATEGY_KEY, 'garbage');
    expect(new AgentStrategyState(store).styleName).toBe('Autopilot');
  });

  it('cleans names like the C# (letters, digits, a few marks, 20 chars, single spaces)', () => {
    expect(cleanAgentName('  Hello   <b>World</b>!! ')).toBe('Hello bWorldb');
    expect(cleanAgentName("O'Neil_bot-2.0")).toBe("O'Neil_bot-2.0");
    expect(cleanAgentName('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrst');
    expect(cleanAgentName('Ünïcødé ñame')).toBe('Ünïcødé ñame');
    const store = new MemStore();
    const s = new AgentStrategyState(store);
    expect(s.agentName).toBe('My Agent');
    expect(sharedAgentName(s, 'SilverRaven997Long')).toBe('SilverRaven997 Agent');
    s.agentName = '  Bolt  ';
    expect(store.getString(AGENT_NAME_KEY)).toBe('Bolt');
    expect(sharedAgentName(s, 'x')).toBe('Bolt');
  });

  it('the dials move both numbers, snap to 2 decimals and make it Custom; rounds keep their gap', () => {
    const s = new AgentStrategyState(new MemStore());
    const preGap = f(s.streets[0]![1]! - s.values[1]!);
    s.setHandsDial(1);
    expect(s.style).toBe(STRATEGY_CUSTOM);
    expect(s.values[1]).toBe(f(0.5));
    expect(s.values[0]).toBe(f(0.15));
    expect(f(s.streets[0]![1]! - s.values[1]!)).toBeCloseTo(preGap, 2);
    s.setPressureDial(0);
    expect(s.values[3]).toBe(0);
    expect(W.after(s.values, s.streets)[2]).toBe(f(0.15));
  });

  it('a slider on one round gives that round its own numbers; Use main drops them', () => {
    const s = new AgentStrategyState(new MemStore());
    s.pickStyle(1); // Guardian: no rounds
    expect(s.roundValues(1)).toBeNull();
    const edited = s.setSlider(2, 0.777, 1);
    expect(edited[2]).toBe(f(0.78));
    expect(s.streets[1]).toEqual(s.streets[3]);
    expect(s.roundValues(1)![2]).toBe(f(0.78));
    expect(s.values[2]).toBe(STRATEGY_PRESETS[1]![2]);
    s.setSlider(0, 0.2, -1); // all rounds: main and every round that has its own
    expect(s.values[0]).toBe(f(0.2));
    expect(s.streets[2]![0]).toBe(f(0.2));
    s.useMain(1);
    expect(s.hasStreets).toBe(false);
  });
});

describe('deployment config helpers', () => {
  it('builds the config the Overview deploys (BuildAgentConfig)', () => {
    const s = new AgentStrategyState(new MemStore());
    const c = buildAgentConfig(s, { bankroll: 8000, maxHands: 50, maxMinutes: 30, stopLoss: 2000, profitTarget: 0 }, { ownerName: 'Rex' });
    expect(c).toMatchObject({
      AgentName: 'Rex Agent', StrategyPreset: 'balanced', StrategyVersion: 'v1-nomad-autopilot', Bankroll: 8000, MinBuyIn: 1000,
      MaxHands: 50, MaxRuntimeSeconds: 1800, StopLoss: 2000, ProfitTarget: 0, StrategyId: null,
    });
    expect(c.Profile).toMatchObject({ HasCustom: true, Brain: 2, FoldBelow: f(0.35) });
    expect(c.Profile.Streets).toHaveLength(4);
    expect(c.DeploymentId).toMatch(/^[0-9a-f]{12}$/);
    const copy = buildAgentConfig(s, {}, { copiedStrategyId: 'abc' });
    expect(copy.StrategyVersion).toBe('copy-abc');
    expect(copy.Bankroll).toBe(5000);
  });

  it('reads the Overview fields like NomadUiHost.ReadField', () => {
    expect(readNumberField('5,000', 1)).toBe(5000);
    expect(readNumberField(' 12 ', 1)).toBe(12);
    expect(readNumberField('1.5', 7)).toBe(7);
    expect(readNumberField('', 9)).toBe(9);
  });

  it('builds session codes like AgentDeployService.BuildSessionCode', () => {
    expect(buildSessionCode('a1b2c3d4e5f6')).toBe('AGNTA1B2C3D4');
    expect(buildSessionCode('ab-c')).toBe('AGNTABC0');
    expect(buildSessionCode('!!')).toBe('AGNT0000');
    expect(buildSessionCode(null, () => 'ffffffffffff')).toBe('AGNTFFFFFFFF');
  });

  it('clamps like AgentDeploymentConfig.Clamp', () => {
    const c = clampAgentConfig(newAgentDeploymentConfig({ DeploymentId: 'x', Bankroll: 10, MinBuyIn: 10, MaxHands: 99999 }));
    expect(c).toMatchObject({ MinBuyIn: 50, Bankroll: 50, MaxHands: 5000 });
  });
});
