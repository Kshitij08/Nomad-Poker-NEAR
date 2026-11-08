/**
 * Bit-exact parity of the Agent core with the Unity C# sources. `golden/agents-golden.json` is produced by `golden/gen`, a
 * .NET console app that compiles the real Assets/Scripts/Core/Agents, Net/Agents/AgentSessionHost.cs and
 * Net/NomadUi/AgentStrategyWords.cs (with a Mathf/Time shim) and dumps: Clamp, ResolveProfile, the deployment limits,
 * whole seeded hands recorded into replays (JSON, every playback frame, rounds, summaries), FromJson edge cases and the
 * strategy words. Regenerate after changing the C#:
 *   cd packages/engine/src/agents/__tests__/golden/gen && dotnet run -c Release -p:UNITY_REPO=<Unity Poker checkout> -- ../agents-golden.json
 */
import { describe, expect, it } from 'vitest';
import golden from './golden/agents-golden.json';
import { HeuristicBot, PokerEngine, SeededRandom, positionOf, type BotContext, type IPokerBot } from '../../index';
import {
  AgentHandReplay, AgentHandReplayRecorder, AgentHandReplayText, AgentSession, AgentStrategyWords as W, clampAgentConfig,
  newAgentDeploymentConfig, type AgentDeploymentConfig, type ReplayFrame, type ReplayRound,
} from '../index';
import type { BotProfile } from '../../bots/botProfile';

type HandOut = {
  seat: number; json: string | null; frames?: string[]; framesPlain?: string; rounds?: string[]; summary?: string;
  summaryFmt?: string; showdown?: boolean; roundTrip?: string | null; finishJson?: string | null; finishJsonTiny?: string;
};
const G = golden as unknown as {
  clamp: { in: string; out: Record<string, unknown> }[];
  profiles: { name: string; profile: string }[];
  limits: { name: string; reasons: string[]; summary: string }[];
  scenarios: Record<string, Record<string, HandOut>[]>;
  fromJson: { in: string; out: string }[];
  words: {
    sets: { v: string[]; out: Record<string, unknown> }[];
    streets: { streets: string; out: Record<string, unknown> }[];
    dials: string[];
  };
};

/** C# double.ToString("R") of a float widened to double: JS's shortest double text matches for these values. */
const R = (x: number) => String(x);
const card = (c: string) => '<' + c + '>';

function frameText(fr: ReplayFrame): string {
  const seats = [...fr.seats.entries()].sort((a, b) => a[0] - b[0]).map(([k, s]) =>
    `${k}:${s.stack},${s.bet},${s.folded ? 'F' : ''}${s.allIn ? 'A' : ''},${s.cards == null ? '-' : s.cards.join(' ')},${s.label},${s.handDescription ?? '-'},${s.won}`);
  return `${fr.pot}|${fr.street}|${fr.board.join(' ')}|${fr.activeSeat}|${fr.caption}|${seats.join(';')}`;
}
const roundText = (r: ReplayRound) => `${r.name}|${r.title}|${r.streetStep}|${r.isEnd ? 1 : 0}|${r.steps.join(',')}`;

function profileText(p: BotProfile): string {
  const nums = (x: BotProfile) => `${R(x.foldBelow)},${R(x.raiseAbove)},${R(x.aggression)},${R(x.bluffChance)},${R(x.raiseFractionOfPot)}`;
  const streets = [0, 1, 2, 3].map((s) => nums(p.effective(s, 0)));
  return `${nums(p)}|${R(p.positionWeight)}|${p.brain}|${streets.join('/')}`;
}

const AUTOPILOT_STREETS = [
  { HasValue: true, FoldBelow: 0.10, RaiseAbove: 0.55, Aggression: 0.60, BluffChance: 0.05, RaiseFractionOfPot: 0.60 },
  { HasValue: true, FoldBelow: 0.50, RaiseAbove: 0.70, Aggression: 0.45, BluffChance: 0.00, RaiseFractionOfPot: 0.50 },
  { HasValue: true, FoldBelow: 0.50, RaiseAbove: 0.70, Aggression: 0.45, BluffChance: 0.00, RaiseFractionOfPot: 0.50 },
  { HasValue: true, FoldBelow: 0.50, RaiseAbove: 0.70, Aggression: 0.45, BluffChance: 0.00, RaiseFractionOfPot: 0.50 },
];

interface Seat { name: string; stack: number; agent?: boolean; preset?: string; custom?: boolean }

/** Same table, bots, seeds and recorder calls as Program.cs Scenario (PokerServerGame's order). */
function scenario(seed: number, seats: (Seat | null)[], maxHands: number, sb: number, bb: number): Record<string, HandOut>[] {
  const n = seats.length;
  const engine = new PokerEngine({ seatCount: n, smallBlind: sb, bigBlind: bb, startingStack: 5000 }, new SeededRandom(seed));
  const bots = new Map<number, IPokerBot>();
  const recorders = new Map<number, AgentHandReplayRecorder>();
  seats.forEach((seat, s) => {
    if (!seat) return;
    engine.seatPlayer(s, seat.agent ? `agent-${s}` : `bot${s}`, seat.name, true, seat.stack, !!seat.agent);
    if (seat.agent) {
      const cfg: AgentDeploymentConfig = newAgentDeploymentConfig({ AgentName: seat.name, Bankroll: seat.stack, StrategyPreset: seat.preset ?? null });
      if (seat.custom)
        cfg.Profile = {
          FoldBelow: 0.35, RaiseAbove: 0.58, Aggression: 0.45, BluffChance: 0.03, RaiseFractionOfPot: 0.6, HasCustom: true,
          PositionWeight: 0, Brain: 2, Streets: AUTOPILOT_STREETS,
        };
      const session = new AgentSession(cfg, () => 0);
      bots.set(s, new HeuristicBot(session.resolveProfile(), seed + s * 101));
      recorders.set(s, new AgentHandReplayRecorder());
    } else bots.set(s, new HeuristicBot(seed + s * 101));
  });
  engine.onEvent((e) => {
    for (const rec of recorders.values()) rec.observe(e);
    if (e.type === 'HandStarted') for (const rec of recorders.values()) rec.setBlinds(engine.table.smallBlind, engine.table.bigBlind);
  });

  const hands: Record<string, HandOut>[] = [];
  for (let h = 0; h < maxHands && engine.countFundedPlayers() >= 2; h++) {
    for (const [seat, rec] of recorders) {
      rec.clear();
      rec.begin(seat);
    }
    engine.startHand();
    while (engine.handInProgress) {
      const seat = engine.awaitingActionSeat;
      const p = engine.table.seats[seat]!;
      const ctx: BotContext = {
        seatIndex: seat, holeCards: p.holeCards, community: engine.table.community, round: engine.table.round,
        pot: engine.table.pot, myStack: p.stack, myCurrentBet: p.currentBet, bigBlind: engine.table.bigBlind,
        opponentsInHand: engine.countInHand() - 1, position: positionOf(engine.table.buttonSeat, seat, engine.table.seatCount),
        legal: engine.currentLegalActions!,
      };
      engine.submitAction(seat, bots.get(seat)!.decide(ctx));
    }
    const hand: Record<string, HandOut> = {};
    for (const [seat, rec] of recorders) {
      const replay = rec.finish();
      const json = replay?.toJson() ?? null;
      const o: HandOut = { seat, json };
      if (replay) {
        o.frames = [];
        for (let i = 0; i <= replay.steps.length + 1; i++) o.frames.push(frameText(AgentHandReplayText.frameAt(replay, i, card)));
        o.framesPlain = frameText(AgentHandReplayText.frameAt(replay, replay.steps.length));
        o.rounds = AgentHandReplayText.rounds(replay, card).map(roundText);
        o.summary = AgentHandReplayText.summary(replay);
        o.summaryFmt = AgentHandReplayText.summary(replay, card);
        o.showdown = replay.wentToShowdown;
        o.roundTrip = AgentHandReplay.fromJson(json)?.toJson() ?? null;
        o.finishJson = rec.finishJson();
        o.finishJsonTiny = rec.finishJson(200) ?? 'null';
      }
      hand[String(seat)] = o;
    }
    hands.push(hand);
  }
  return hands;
}

describe('agents core parity with the Unity C#', () => {
  it('AgentDeploymentConfig.Clamp', () => {
    for (const c of G.clamp) {
      const out = clampAgentConfig(newAgentDeploymentConfig({ AgentName: 'Agent', ...(JSON.parse(c.in) as Partial<AgentDeploymentConfig>) }));
      const generated = !(JSON.parse(c.in) as { DeploymentId?: string }).DeploymentId?.trim();
      const id = generated ? (/^[0-9a-f]{12}$/.test(out.DeploymentId!) ? 'GEN' : 'BAD') : out.DeploymentId;
      expect({
        DeploymentId: id, AgentName: out.AgentName, StrategyPreset: out.StrategyPreset, StrategyVersion: out.StrategyVersion,
        Bankroll: out.Bankroll, MinBuyIn: out.MinBuyIn, MaxHands: out.MaxHands, MaxRuntimeSeconds: out.MaxRuntimeSeconds,
        StopLoss: out.StopLoss, ProfitTarget: out.ProfitTarget,
      }).toEqual(c.out);
    }
  });

  it('AgentSession.ResolveProfile', () => {
    const cfgs: Record<string, Partial<AgentDeploymentConfig>> = {
      'preset-balanced': { StrategyPreset: 'balanced' },
      'preset-tight': { StrategyPreset: 'tight' },
      'preset-aggressive': { StrategyPreset: 'aggressive' },
      'preset-unknown': { StrategyPreset: 'weird' },
      'custom-out-of-range': { Profile: { HasCustom: true, FoldBelow: 0.9, RaiseAbove: 0.1, Aggression: 2, BluffChance: -1, RaiseFractionOfPot: 5, PositionWeight: 3, Brain: 1, Streets: null } },
      'custom-streets': {
        Profile: {
          HasCustom: true, FoldBelow: 0.35, RaiseAbove: 0.58, Aggression: 0.45, BluffChance: 0.03, RaiseFractionOfPot: 0.6, PositionWeight: 0.25, Brain: 2,
          Streets: [
            { HasValue: true, FoldBelow: 0.05, RaiseAbove: 0.55, Aggression: 0.6, BluffChance: 0.05, RaiseFractionOfPot: 0.6 },
            { HasValue: false, FoldBelow: 0, RaiseAbove: 0, Aggression: 0, BluffChance: 0, RaiseFractionOfPot: 0 },
            { HasValue: true, FoldBelow: 0.5, RaiseAbove: 0.99, Aggression: 0.45, BluffChance: 0.3, RaiseFractionOfPot: 0.5 },
            { HasValue: false, FoldBelow: 0.5, RaiseAbove: 0.7, Aggression: 0.45, BluffChance: 0, RaiseFractionOfPot: 0.5 },
            { HasValue: true, FoldBelow: 0.2, RaiseAbove: 0.7, Aggression: 0.45, BluffChance: 0, RaiseFractionOfPot: 0.5 },
          ],
        },
      },
    };
    for (const p of G.profiles) {
      const session = new AgentSession(newAgentDeploymentConfig(cfgs[p.name]), () => 0);
      expect(profileText(session.resolveProfile()), p.name).toBe(p.profile);
    }
  });

  it('AgentSession limits and summary', () => {
    const cases: Record<string, [Partial<AgentDeploymentConfig>, [number, number, boolean][]]> = {
      hands: [{ Bankroll: 5000, MaxHands: 3 }, [[1, 5100, false], [2, 5200, false], [3, 4900, false], [4, 4800, false]]],
      stoploss: [{ Bankroll: 5000, StopLoss: 1000 }, [[1, 4500, false], [2, 4001, false], [3, 4000, false]]],
      profit: [{ Bankroll: 5000, ProfitTarget: 500 }, [[1, 5300, false], [2, 5500, false]]],
      bust: [{ Bankroll: 5000 }, [[1, 0, false]]],
      runtime: [{ Bankroll: 5000, MaxRuntimeSeconds: 60 }, [[30, 5000, false], [59.5, 5000, false], [60, 5000, false]]],
      owner: [{ Bankroll: 5000, MaxHands: 1, StopLoss: 1 }, [[1, 0, true]]],
    };
    for (const l of G.limits) {
      const [cfg, steps] = cases[l.name]!;
      let now = 100;
      const s = new AgentSession(newAgentDeploymentConfig(cfg), () => now, () => 0);
      const reasons = steps.map(([t, stack, stop]) => {
        now = Math.fround(100 + t);
        if (stop) s.requestOwnerStop();
        return s.evaluateAfterHand(stack) ?? 'null';
      });
      expect(reasons, l.name).toEqual(l.reasons);
      const sum = s.stop(null, steps.at(-1)![1], 'TABLE1');
      expect(`${sum.StopReason}|${sum.HandsPlayed}|${sum.StartingBankroll}|${sum.EndingStack}|${sum.NetPnl}|${R(sum.RuntimeSeconds)}|${sum.SessionName}`, l.name).toBe(l.summary);
    }
  });

  const scenarios: Record<string, () => Record<string, HandOut>[]> = {
    six: () => scenario(4242, [
      { name: 'Bot 0', stack: 5000 }, { name: 'Bot 1', stack: 5000 },
      { name: 'Silver', stack: 5000, agent: true, preset: 'aggressive' },
      { name: 'Bot 3', stack: 5000 },
      { name: 'Rival Agent', stack: 5000, agent: true, custom: true },
      { name: 'Bot 5', stack: 5000 },
    ], 16, 25, 50),
    short: () => scenario(77, [
      { name: 'My Agent', stack: 300, agent: true, custom: true }, { name: 'CerealKiller', stack: 1200 },
      { name: 'PotatoAim', stack: 150 }, { name: 'Jake_2004', stack: 900 }, null, { name: '', stack: 2500 },
    ], 30, 10, 20),
    headsup: () => scenario(5, [{ name: 'nova', stack: 2000 }, { name: 'Bolt', stack: 2000, agent: true, preset: 'conservative' }], 12, 25, 50),
  };

  for (const [name, run] of Object.entries(scenarios)) {
    it(`replays recorded from seeded hands: ${name}`, () => {
      const ours = run();
      const theirs = G.scenarios[name]!;
      expect(ours.length).toBe(theirs.length);
      for (let h = 0; h < theirs.length; h++)
        for (const seat of Object.keys(theirs[h]!)) {
          const a = ours[h]![seat]!;
          const b = theirs[h]![seat]!;
          expect(a.json, `${name} hand ${h} seat ${seat} json`).toBe(b.json);
          expect(a.frames, `${name} hand ${h} seat ${seat} frames`).toEqual(b.frames);
          expect(a.framesPlain).toBe(b.framesPlain);
          expect(a.rounds).toEqual(b.rounds);
          expect(a.summary).toBe(b.summary);
          expect(a.summaryFmt).toBe(b.summaryFmt);
          expect(a.showdown).toBe(b.showdown);
          expect(a.roundTrip).toBe(b.roundTrip);
          expect(a.finishJson).toBe(b.finishJson);
          expect(a.finishJsonTiny).toBe(b.finishJsonTiny);
        }
    });
  }

  it('AgentHandReplay.FromJson accepts and rejects what Newtonsoft does', () => {
    for (const c of G.fromJson) expect(AgentHandReplay.fromJson(c.in)?.toJson() ?? 'null', c.in).toBe(c.out);
  });

  it('AgentStrategyWords: every line and figure', () => {
    const check = (v: number[], streets: (number[] | null)[] | null, out: Record<string, unknown>) => {
      expect(W.summary(v, streets)).toBe(out.summary);
      expect(W.shortSummary(v, streets)).toBe(out.short);
      expect([0, 1, 2, 3, 4].map((i) => W.tag(i, v))).toEqual(out.tags);
      expect([0, 1, 2, 3, 4].map((i) => W.explain(i, v))).toEqual(out.explain);
      expect(R(W.handsPlayed(v))).toBe(out.hands);
      expect(R(W.raisesBeforeFlop(v))).toBe(out.raises);
      expect(R(W.pressure(v))).toBe(out.pressure);
      expect(R(W.swing(W.before(v, streets), W.after(v, streets)))).toBe(out.swing);
      expect(R(W.foldsToBets(v[0]!))).toBe(out.folds);
      expect(R(W.dialForHands(v))).toBe(out.dialHands);
      expect(R(W.dialForPressure(v))).toBe(out.dialPressure);
    };
    const sets = G.words.sets.map((s) => s.v.map(Number));
    G.words.sets.forEach((s, i) => check(sets[i]!, null, s.out));
    const auto = AUTOPILOT_STREETS.map((s) => [s.FoldBelow, s.RaiseAbove, s.Aggression, s.BluffChance, s.RaiseFractionOfPot].map(Math.fround));
    const streetSets: Record<string, [number[], (number[] | null)[]]> = {
      auto: [sets[0]!, auto],
      'pre-only': [sets[3]!, [auto[0]!, null, null, null]],
      'river-only': [sets[1]!, [null, null, null, auto[1]!]],
    };
    for (const c of G.words.streets) check(streetSets[c.streets]![0], streetSets[c.streets]![1], c.out);
    G.words.dials.forEach((line, i) => {
      const d = Math.fround(i / 20);
      expect([R(W.raiseForDial(d)), R(W.foldForDial(d)), R(W.aggrForDial(d)), R(W.sizeForDial(d)), R(W.bluffForDial(d)),
        W.pressureWord(d), W.oneIn(d), W.oneIn(Math.fround(d * 0.5), 'pot')].join(',')).toBe(line);
    });
  });
});
