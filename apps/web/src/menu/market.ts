/**
 * Agent strategy helpers shared by the Redesign v2 Agents pages (src/ui2/screens/agents.ts) and the agents module: the
 * copy-strategy marketplace state (copiers pay 8 % of new profit to the creator and 2 % to Nomad), the Strategy tab as
 * the backends' strategy profile, and the Agent backend (`backendApi` service, or undefined offline).
 *
 * The copy lives for the app session only (no PlayerPrefs key): after a reload the Strategy tab still holds the copied
 * numbers (AgentStrategyState saves them) but they run as the player's own, with no fee.
 */
import type { AppContext } from '../app/app';
import type { NomadHost } from './host';
import type { BackendApiLike } from './deps';

export const TWIN_MIN_DECISIONS = 30;
export const COACH_MIN_HANDS = 20;

/** AgentStrategyState (agents module). */
export interface AgentStrategyLike {
  readonly values: number[];
  readonly streets: (number[] | null)[];
  applyAll(preset: number, values: number[], positionWeight: number, brain: number, streets: (number[] | null)[]): void;
  /** Subscribe to slider edits; returns an unsubscribe. */
  onChanged(fn: () => void): () => void;
  /** AgentStrategyWords.Tag(i, values): a parameter in words. */
  tag?(i: number, values: number[]): string;
  readonly brainClassic?: number;
  readonly brainSmart?: number;
  /** SolProfile's optional Agents v2 fields. */
  readonly positionWeight?: number;
  readonly brain?: number;
  readonly hasStreets?: boolean;
}

/** The marketplace strategy the next Coins Agent copies (null: the player's own sliders). */
export const marketState = {
  copiedStrategyId: null as string | null,
  copiedName: null as string | null,
  copiedValues: null as number[] | null,
  copiedStreets: null as (number[] | null)[] | null,
};

type J = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

/** C#'s `{x:0.#}` (invariant): one decimal at most, rounded half away from zero on the 15-digit value, as .NET does. */
export function format0Hash(x: number): string {
  const neg = x < 0;
  const tenths = Math.round(Number((Math.abs(x) * 10).toPrecision(15)));
  const s = String(Math.floor(tenths / 10)) + (tenths % 10 ? '.' + (tenths % 10) : '');
  return neg && tenths !== 0 ? '-' + s : s;
}

/** The shortest number that reads back as the same float32: how Newtonsoft writes a C# float (`R`), so a copied 0.35
 * goes back to the Agent service as 0.35, not 0.3499999940395355. */
function floatJson(v: number): number {
  const fv = Math.fround(v);
  for (let p = 1; p <= 9; p++) {
    const s = Number(fv.toPrecision(p));
    if (Math.fround(s) === fv) return s;
  }
  return fv;
}

/**
 * SolProfile (NomadUiHost.Onchain): the Strategy tab as the backends' strategy profile (agentBot.ts Profile, also what
 * Publish sends): the five numbers, then the optional Agents v2 fields (position, brain 2, betting rounds with their own
 * numbers keyed preflop / flop / turn / river).
 */
export function solProfile(st: AgentStrategyLike | undefined): Record<string, unknown> {
  const v = st?.values ?? [0.3, 0.7, 0.5, 0.1, 0.5];
  const five = (x: number[]) => ({ foldBelow: floatJson(x[0]!), raiseAbove: floatJson(x[1]!), aggression: floatJson(x[2]!), bluffChance: floatJson(x[3]!), raiseFractionOfPot: floatJson(x[4]!) });
  const p: Record<string, unknown> = five(v);
  if (st && (st.positionWeight ?? 0) > 0) p.positionWeight = floatJson(st.positionWeight!);
  if (st && st.brain !== undefined && st.brain === (st.brainSmart ?? 2)) p.brain = 2;
  if (st && (st.hasStreets ?? st.streets.some((s) => s != null))) {
    const keys = ['preflop', 'flop', 'turn', 'river'];
    const streets: Record<string, unknown> = {};
    st.streets.forEach((s, i) => {
      if (s && i < 4) streets[keys[i]!] = five(s);
    });
    p.streets = streets;
  }
  return p;
}

/** OnStrategyEdited: any change (the main numbers or a betting round's own) stops copying, and its fee. */
export function onStrategyEdited(s: AgentStrategyLike): void {
  if (marketState.copiedStrategyId === null || !marketState.copiedValues) return;
  if (!same(s.values, marketState.copiedValues)) return stopCopying();
  for (let r = 0; r < 4; r++) if (!same(s.streets[r] ?? null, marketState.copiedStreets?.[r] ?? null)) return stopCopying();
}

/** StopCopying: the player's own sliders again (no strategy id, no fee). */
export function stopCopying(): void {
  marketState.copiedStrategyId = null;
  marketState.copiedName = null;
}

function same(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return a === b;
  for (let i = 0; i < 5 && i < a.length && i < b.length; i++) if (Math.abs(a[i]! - b[i]!) > 0.005) return false;
  return true;
}

/** The Agent backend (`backendApi`), or undefined offline. */
export function marketApi(ctx: AppContext): BackendApiLike | undefined {
  return (ctx.services as unknown as Record<string, unknown>).backendApi as BackendApiLike | undefined;
}

const valuesOf = (p: J) => [num(p.foldBelow), num(p.raiseAbove), num(p.aggression), num(p.bluffChance), num(p.raiseFractionOfPot)];

/** ApplyProfile on a given AgentStrategyState. */
export function applyProfileTo(s: AgentStrategyLike, p: J): void {
  const st = p.streets as J | undefined;
  const streets = ['preflop', 'flop', 'turn', 'river'].map((k) => (st?.[k] && typeof st[k] === 'object' ? valuesOf(st[k] as J) : null));
  const pw = typeof p.positionWeight === 'number' ? p.positionWeight : 0;
  const brain = p.brain === 2 ? (s.brainSmart ?? 2) : (s.brainClassic ?? 1);
  s.applyAll(3, valuesOf(p), pw, brain, streets);
}

export function rememberCopy(host: NomadHost): void {
  const s = (host.ctx.services as unknown as Record<string, unknown>).agentStrategy as AgentStrategyLike | undefined;
  marketState.copiedValues = s ? [...s.values] : null;
  marketState.copiedStreets = s ? s.streets.map((r) => (r ? [...r] : null)) : null;
}
