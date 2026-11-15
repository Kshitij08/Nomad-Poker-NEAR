/**
 * Port of Poker.Game.AgentStrategyState (Assets/Scripts/Game/NomadUI/NomadStrategyPanel.cs): the Agent strategy the
 * player last applied, shared by the Strategy and Overview screens, saved on the device under the same PlayerPrefs keys
 * and in the same JsonUtility shape ("nomad.agent.name", "nomad.agent.strategy", version 2).
 *
 * The C# is a static class; here it is an instance over an injected key/value store (PlayerPrefs in the browser, a Map
 * in tests), so it stays pure. Also here: NomadUiHost.Agents.BuildAgentConfig / SharedAgentName / StreetSnapshots and
 * the strategy editor's value math (NomadUiHost.Strategy: dial shifts, round edits), which are pure too.
 */
import { StakeCatalog } from '../stakes/stakes';
import { roundHalfEven } from '../util/dotnetMath';
import {
  clampAgentConfig, newAgentDeploymentConfig, type AgentDeploymentConfig, type StreetProfileSnapshot,
} from './agentDeploymentConfig';
import { AgentStrategyWords as W } from './agentStrategyWords';

const f = Math.fround;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface KeyValueStore {
  getString(key: string, fallback?: string): string;
  setString(key: string, value: string): void;
}

/** Five numbers: Fold below, Raise above, Aggression, Bluff chance, Raise / pot. */
export type Values = number[];
/** Per betting round [preflop, flop, turn, river]: that round's own five numbers, or null to use the main ones. */
export type Streets = (Values | null)[];

const F = (xs: number[]): Values => xs.map(f);

/** The playstyles (option C, 20 Oct): one all-rounder, three styles that each win somewhere the others don't, Custom. */
export const STRATEGY_NAMES = Object.freeze(['Autopilot', 'Guardian', 'Trapper', 'Daredevil', 'Custom']);
export const STRATEGY_BLURBS = Object.freeze(['Best all-round', 'Careful', 'Patient', 'Bold']);
export const STRATEGY_CUSTOM = 4;
export const BRAIN_CLASSIC = 0;
export const BRAIN_SMART = 2;
export const STREET_NAMES = Object.freeze(['Before the flop', 'Flop', 'Turn', 'River']);
export const MAX_AGENT_NAME_LENGTH = 20;
export const AGENT_NAME_KEY = 'nomad.agent.name';
export const AGENT_STRATEGY_KEY = 'nomad.agent.strategy';

export const STRATEGY_PRESETS: readonly Values[] = Object.freeze([
  F([0.35, 0.58, 0.45, 0.03, 0.60]), // Autopilot: loose before the flop, tight after (its rounds below)
  F([0.40, 0.60, 0.25, 0.02, 0.45]), // Guardian: fewer hands, small bets, the smallest swings
  F([0.30, 0.52, 0.15, 0.00, 0.60]), // Trapper: plays many hands quietly, calls and lets others bet
  F([0.22, 0.52, 0.75, 0.08, 0.90]), // Daredevil: many hands, raises and big bets; crushes callers, swings most
]);

/** A preset's own betting rounds [preflop, flop, turn, river] (null = the main numbers). */
export const STRATEGY_PRESET_STREETS: readonly (readonly Values[] | null)[] = Object.freeze([
  [F([0.10, 0.55, 0.60, 0.05, 0.60]), F([0.50, 0.70, 0.45, 0.00, 0.50]), F([0.50, 0.70, 0.45, 0.00, 0.50]), F([0.50, 0.70, 0.45, 0.00, 0.50])],
  null, null, null,
]);

export function presetStreetsCopy(style: number): Streets {
  const s: Streets = [null, null, null, null];
  const p = style >= 0 && style < STRATEGY_PRESET_STREETS.length ? STRATEGY_PRESET_STREETS[style] : null;
  for (let i = 0; p && i < 4; i++) s[i] = p[i] ? [...p[i]!] : null;
  return s;
}

const isLetterOrDigit = (c: string): boolean => /^[\p{L}\p{Nd}]$/u.test(c);

/** Letters, digits, spaces and a few marks, at most 20 characters: it's shown to other players. */
export function cleanAgentName(raw: string | null | undefined): string {
  let sb = '';
  const s = (raw ?? '').trim();
  for (let i = 0; i < s.length; i++) {
    if (sb.length >= MAX_AGENT_NAME_LENGTH) break;
    const c = s[i]!;
    if (isLetterOrDigit(c) || c === ' ' || c === '-' || c === '_' || c === '.' || c === "'") sb += c;
  }
  return sb.replace(/ {2,}/g, ' ').trim();
}

/** Shortest text that reads back as the same float32 (how JsonUtility writes floats). */
function floatText(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (f(s) === v) return String(s);
  }
  return String(v);
}

// version 2 (20 Oct): styles are Autopilot, Guardian, Trapper, Daredevil, Custom (before: Guardian, Tactician, Daredevil, Custom).
const SAVED_VERSION = 2;
const OLD_STYLE = [1, 0, 3, STRATEGY_CUSTOM];

export class AgentStrategyState {
  style = 0;
  values: Values = [...STRATEGY_PRESETS[0]!];
  advanced: boolean[] = [false, false, false];
  /** 0..1: how much the seat changes play. */
  positionWeight = 0;
  /** 2 = smart (every Agent's brain); 0 = classic, only for My Twin. */
  brain = BRAIN_SMART;
  streets: Streets = presetStreetsCopy(0);
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: KeyValueStore) {
    this.load();
  }

  onChanged(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }

  get styleName(): string {
    return STRATEGY_NAMES[Math.max(0, Math.min(this.style, STRATEGY_NAMES.length - 1))]!;
  }

  get hasStreets(): boolean {
    return this.streets.some((s) => s != null);
  }

  /** The player's name for their Agent (saved on this device). */
  get agentName(): string {
    const n = this.store.getString(AGENT_NAME_KEY, '');
    return n.trim().length === 0 ? 'My Agent' : n;
  }

  set agentName(value: string) {
    this.store.setString(AGENT_NAME_KEY, cleanAgentName(value));
    this.changed();
  }

  apply(style: number, values: Values, advanced: boolean[]): void {
    this.style = style;
    this.values = F([...values]);
    this.advanced = [...advanced];
    if (style < STRATEGY_PRESETS.length) {
      this.positionWeight = 0;
      this.brain = BRAIN_SMART;
      this.streets = presetStreetsCopy(style);
    }
    this.save();
    this.changed();
  }

  /** The whole strategy at once (the editor, My Twin, a copied strategy). */
  applyAll(style: number, values: Values, positionWeight: number, brain: number, streets: Streets | null): void {
    this.style = style;
    this.values = F([...values]);
    this.positionWeight = clamp01(f(positionWeight));
    this.brain = brain === BRAIN_SMART ? BRAIN_SMART : BRAIN_CLASSIC;
    this.streets = [null, null, null, null];
    for (let i = 0; streets && i < 4 && i < streets.length; i++) {
      const s = streets[i];
      this.streets[i] = s && s.length >= 5 ? F([...s]) : null;
    }
    this.save();
    this.changed();
  }

  /** The playstyle card / Reset: a preset with its own rounds, smart brain, no position. */
  pickStyle(style: number): void {
    this.applyAll(style, STRATEGY_PRESETS[style]!, 0, BRAIN_SMART, presetStreetsCopy(style));
  }

  private save(): void {
    const arr = (v: Values | null): string => '[' + (v ?? []).map(floatText).join(',') + ']';
    const s = this.streets;
    // JsonUtility field order of the C# Saved class; a null array is written as [].
    const json = `{"version":${SAVED_VERSION},"style":${this.style},"brain":${this.brain},"values":${arr(this.values)},"position":${floatText(this.positionWeight)},` +
      `"s0":${arr(s[0]!)},"s1":${arr(s[1]!)},"s2":${arr(s[2]!)},"s3":${arr(s[3]!)},` +
      `"h0":${s[0] != null},"h1":${s[1] != null},"h2":${s[2] != null},"h3":${s[3] != null}}`;
    this.store.setString(AGENT_STRATEGY_KEY, json);
  }

  /** The strategy the player last applied on this device (once, at startup). */
  private load(): void {
    try {
      const json = this.store.getString(AGENT_STRATEGY_KEY, '');
      if (!json) return;
      const s = JSON.parse(json) as Record<string, unknown>;
      const nums = (x: unknown): Values | null => (Array.isArray(x) ? x.map((n) => f(Number(n))) : null);
      const int = (x: unknown): number => (typeof x === 'number' ? Math.trunc(x) : 0);
      const values = nums(s.values);
      if (!values || values.length < 5) return;
      const version = int(s.version);
      const clampI = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
      this.style = version >= SAVED_VERSION ? clampI(int(s.style), 0, STRATEGY_NAMES.length - 1) : OLD_STYLE[clampI(int(s.style), 0, OLD_STYLE.length - 1)]!;
      // A preset is its name, not a snapshot: a saved preset plays today's numbers. Only Custom keeps what was saved.
      this.values = this.style < STRATEGY_PRESETS.length ? [...STRATEGY_PRESETS[this.style]!] : values;
      this.positionWeight = clamp01(f(Number(s.position) || 0));
      // Agents play smart; a saved classic strategy stays classic only when it's custom (My Twin's).
      this.brain = int(s.brain) === BRAIN_SMART || this.style < STRATEGY_PRESETS.length ? BRAIN_SMART : BRAIN_CLASSIC;
      this.streets = [null, null, null, null];
      for (let i = 0; i < 4; i++) {
        const arr = nums(s['s' + i]);
        if (s['h' + i] === true && arr && arr.length >= 5) this.streets[i] = arr;
      }
      if (this.style < STRATEGY_PRESETS.length) {
        this.positionWeight = 0;
        this.streets = presetStreetsCopy(this.style);
      }
    } catch (e) {
      console.warn('[AgentStrategy] saved strategy unreadable: ' + String(e));
    }
  }

  // ---- the menu's agentStrategy service shape (apps/web/src/menu/market.ts AgentStrategyLike)

  readonly brainClassic = BRAIN_CLASSIC;
  readonly brainSmart = BRAIN_SMART;

  /** AgentStrategyWords.Tag(i, values): a setting in words. */
  tag(i: number, values: readonly number[]): string {
    return W.tag(i, values);
  }

  // ---- the summary lines (NomadUiHost.Strategy / Agents)

  get summary(): string {
    return W.summary(this.values, this.streets);
  }

  get shortSummary(): string {
    return W.shortSummary(this.values, this.streets);
  }

  // ---- the editor's value math (NomadUiHost.Strategy.cs)

  /** Round 0 = before the flop (street 0); round 1 = after it (streets 1-3, kept the same). Null: the main numbers. */
  roundValues(round: number): Values | null {
    const s = this.streets;
    return round === 0 ? s[0]! : s[1] ?? s[2] ?? s[3] ?? null;
  }

  withRound(round: number, values: Values | null): Streets {
    const s = [...this.streets];
    if (round === 0) s[0] = values;
    else for (let i = 1; i < 4; i++) s[i] = values ? [...values] : null;
    return s;
  }

  /** "Use main": the round plays the main numbers again. */
  useMain(round: number): void {
    this.applyAll(STRATEGY_CUSTOM, this.values, this.positionWeight, this.brain, this.withRound(round, null));
  }

  /** Shifts the main numbers and every round's own numbers the same way (a custom strategy afterwards). */
  applyDialShift(shift: (v: Values) => void): void {
    const shifted = (v: Values | null): Values | null => {
      if (!v) return null;
      const c = [...v];
      shift(c);
      for (let i = 0; i < 5; i++) c[i] = W.snap2(c[i]!, i);
      return c;
    };
    const streets: Streets = this.streets.map(shifted);
    this.applyAll(STRATEGY_CUSTOM, shifted(this.values)!, this.positionWeight, this.brain, streets);
  }

  /** Hands played dial: Hands it plays and Calling bets move together; a strategy's rounds keep their gap. */
  setHandsDial(d: number): void {
    const main = this.values;
    const dr = f(W.raiseForDial(d) - main[1]!);
    const df = f(W.foldForDial(d) - main[0]!);
    this.applyDialShift((v) => {
      v[1] = f(v[1]! + dr);
      v[0] = f(v[0]! + df);
    });
  }

  /** Pressure dial: raise vs call, bet size and a little bluffing; rounds keep their gap. */
  setPressureDial(p: number): void {
    const post = W.after(this.values, this.streets);
    const da = f(W.aggrForDial(p) - post[2]!);
    const ds = f(W.sizeForDial(p) - post[4]!);
    const bluff = W.bluffForDial(p);
    this.applyDialShift((v) => {
      v[2] = f(v[2]! + da);
      v[4] = f(v[4]! + ds);
      v[3] = bluff;
    });
  }

  /**
   * An advanced slider moved (OnStratSlider). `round` -1 = all rounds: the main numbers and every round with its own;
   * 0 / 1 = before / after the flop only (creating that round's own numbers). Returns the values the editor now shows.
   */
  setSlider(i: number, v: number, round: number): Values {
    v = f(roundHalfEven(f(f(v) * 100)) / 100);
    const values = [...this.values];
    let streets = [...this.streets];
    let edited: Values;
    if (round >= 0) {
      const current = this.roundValues(round);
      edited = [...(current ?? values)];
      edited[i] = v;
      streets = this.withRound(round, edited);
    } else {
      values[i] = v;
      for (let r = 0; r < 4; r++) if (streets[r]) { streets[r] = [...streets[r]!]; streets[r]![i] = v; }
      edited = streets[0] ?? values;
    }
    this.applyAll(STRATEGY_CUSTOM, values, this.positionWeight, this.brain, streets);
    return edited;
  }

  /** The betting rounds with their own numbers (null when none do). NomadUiHost.StreetSnapshots. */
  streetSnapshots(): StreetProfileSnapshot[] | null {
    if (!this.hasStreets) return null;
    return this.streets.map((s) =>
      s
        ? { HasValue: true, FoldBelow: s[0]!, RaiseAbove: s[1]!, Aggression: s[2]!, BluffChance: s[3]!, RaiseFractionOfPot: s[4]! }
        : { HasValue: false, FoldBelow: 0, RaiseAbove: 0, Aggression: 0, BluffChance: 0, RaiseFractionOfPot: 0 });
  }
}

/** The deployment's preset label by style (Autopilot, Guardian, Trapper, Daredevil, Custom): the server's fallback. */
export const STYLE_PRESET_IDS = Object.freeze(['balanced', 'conservative', 'balanced', 'aggressive', 'balanced']);

/**
 * The name other players see. An unnamed Agent ("My Agent") goes by its owner, "SilverRaven997 Agent" (two would sit at
 * one table now that Agents play each other). NomadUiHost.SharedAgentName.
 */
export function sharedAgentName(state: AgentStrategyState, ownerName: string | null | undefined): string {
  const n = state.agentName;
  if (n !== 'My Agent') return n;
  let owner = (ownerName ?? '').trim();
  if (owner.length === 0) return n;
  if (owner.length > 14) owner = owner.slice(0, 14);
  return cleanAgentName(owner + ' Agent');
}

/** The Overview's budget fields (BankrollField, MaxHandsField, MaxMinutesField, StopLossField, ProfitField). */
export interface AgentBudgetFields {
  bankroll?: number;
  maxHands?: number;
  maxMinutes?: number;
  stopLoss?: number;
  profitTarget?: number;
}

/** NomadUiHost.ReadField: "5,000" → 5000; anything unreadable → the fallback. */
export function readNumberField(text: string | null | undefined, fallback: number): number {
  const t = (text ?? '').replace(/,/g, '').trim();
  return /^[-+]?\d+$/.test(t) ? Number.parseInt(t, 10) : fallback;
}

/** NomadUiHost.BuildAgentConfig: the Strategy screen's numbers are what the Agent plays. */
export function buildAgentConfig(
  state: AgentStrategyState,
  fields: AgentBudgetFields,
  opts: { ownerName?: string | null; copiedStrategyId?: string | null } = {},
): AgentDeploymentConfig {
  const v = state.values;
  const style = Math.max(0, Math.min(state.style, STYLE_PRESET_IDS.length - 1));
  const copied = opts.copiedStrategyId ?? null;
  return clampAgentConfig(newAgentDeploymentConfig({
    AgentName: sharedAgentName(state, opts.ownerName),
    StrategyPreset: STYLE_PRESET_IDS[style]!,
    StrategyVersion: copied != null ? 'copy-' + copied : 'v1-nomad-' + state.styleName.toLowerCase(),
    StrategyId: copied,
    Bankroll: fields.bankroll ?? 5000,
    MinBuyIn: StakeCatalog.DefaultMinBuyIn,
    MaxHands: Math.trunc(fields.maxHands ?? 100),
    MaxRuntimeSeconds: Math.trunc(fields.maxMinutes ?? 60) * 60,
    StopLoss: fields.stopLoss ?? 0,
    ProfitTarget: fields.profitTarget ?? 0,
    Profile: {
      FoldBelow: v[0]!, RaiseAbove: v[1]!, Aggression: v[2]!, BluffChance: v[3]!, RaiseFractionOfPot: v[4]!, HasCustom: true,
      PositionWeight: state.positionWeight,
      Brain: state.brain,
      Streets: state.streetSnapshots(),
    },
  }));
}
