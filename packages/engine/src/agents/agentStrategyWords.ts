/**
 * Port of Assets/Scripts/Net/NomadUi/AgentStrategyWords.cs: what the strategy settings make the Agent do, in plain words.
 * Every figure is measured, not guessed: the tables are the Agent's behaviour at a 5-seat Coins table against the filler
 * bots (docs/AGENTS_V2.md section 9; 12,000 hands per point, the smart brain, 20 Oct).
 *
 * C# float arithmetic (Unity Mathf) is reproduced with Math.fround at every step, so the words match the Unity build to the
 * character (__tests__/agentsParity.test.ts).
 */
import { roundHalfEven } from '../util/dotnetMath';
import { formatN0 } from '../util/dotnetMath';

const f = Math.fround;
const F = (xs: number[]): number[] => xs.map(f);
const F2 = (rows: number[][]): number[][] => rows.map(F);

/** Unity Mathf, float32. */
const Mathf = {
  clamp01: (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v),
  clamp: (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v),
  lerp: (a: number, b: number, t: number): number => f(a + f(f(b - a) * Mathf.clamp01(t))),
  inverseLerp: (a: number, b: number, v: number): number => (a !== b ? Mathf.clamp01(f(f(v - a) / f(b - a))) : 0),
  roundToInt: (v: number): number => roundHalfEven(v),
};

/** The advanced sliders, in AgentStrategyState.Values order, named for what they do. */
const Names = Object.freeze(['Calling bets', 'Hands it plays', 'Raise vs call', 'Bluffing', 'Bet size']);
/** The range the server plays each number in (BotProfile.Clamped): the sliders cover exactly this. */
const Min = Object.freeze(F([0.10, 0.45, 0.10, 0.00, 0.30]));
const Max = Object.freeze(F([0.55, 0.90, 0.95, 0.25, 1.20]));
/** Sliders that read right-to-left, so "right" always means more (more calling, more hands). */
const Reversed = Object.freeze([true, true, false, false, false]);

// ---- measured behaviour

const RaiseAxis = F([0.45, 0.48, 0.50, 0.52, 0.55, 0.58, 0.60, 0.62, 0.65, 0.70, 0.80, 0.90]);
const FoldAxis = F([0.10, 0.25, 0.40, 0.55]);
const AggrAxis = F([0.10, 0.30, 0.50, 0.70, 0.95]);
const FoldToBet = F([0.615, 0.682, 0.729, 0.748]);

/** Share of hands played (money in before the flop), by Value raises (rows) and Folding (columns). */
const VpipByRaiseFold = F2([
  [0.625, 0.584, 0.553, 0.520],
  [0.579, 0.522, 0.493, 0.444],
  [0.557, 0.495, 0.465, 0.410],
  [0.529, 0.441, 0.410, 0.349],
  [0.495, 0.395, 0.349, 0.285],
  [0.459, 0.342, 0.279, 0.212],
  [0.446, 0.323, 0.251, 0.181],
  [0.433, 0.305, 0.221, 0.155],
  [0.425, 0.293, 0.203, 0.125],
  [0.422, 0.279, 0.185, 0.100],
  [0.421, 0.280, 0.180, 0.096],
  [0.418, 0.277, 0.180, 0.094],
]);

/** Share of hands raised before the flop, by Value raises (rows) and Aggression (columns). */
const PfrByRaiseAggr = F2([
  [0.165, 0.251, 0.340, 0.428, 0.538],
  [0.137, 0.212, 0.288, 0.364, 0.456],
  [0.123, 0.189, 0.263, 0.331, 0.418],
  [0.104, 0.161, 0.221, 0.280, 0.352],
  [0.080, 0.127, 0.172, 0.219, 0.276],
  [0.063, 0.092, 0.121, 0.150, 0.185],
  [0.054, 0.077, 0.099, 0.124, 0.150],
  [0.048, 0.061, 0.079, 0.095, 0.113],
  [0.038, 0.049, 0.057, 0.066, 0.081],
  [0.032, 0.034, 0.038, 0.041, 0.045],
  [0.028, 0.028, 0.030, 0.031, 0.032],
  [0.024, 0.026, 0.026, 0.025, 0.025],
]);

/** Share of after-the-flop actions that are bets or raises, by Value raises and Aggression. */
const AfqByRaiseAggr = F2([
  [0.248, 0.296, 0.340, 0.384, 0.437],
  [0.239, 0.283, 0.330, 0.371, 0.416],
  [0.231, 0.271, 0.318, 0.354, 0.398],
  [0.226, 0.260, 0.307, 0.343, 0.385],
  [0.213, 0.251, 0.286, 0.320, 0.360],
  [0.200, 0.237, 0.268, 0.300, 0.335],
  [0.190, 0.221, 0.255, 0.281, 0.318],
  [0.176, 0.209, 0.240, 0.269, 0.304],
  [0.165, 0.191, 0.220, 0.248, 0.276],
  [0.140, 0.160, 0.188, 0.206, 0.235],
  [0.099, 0.116, 0.133, 0.145, 0.164],
  [0.059, 0.066, 0.074, 0.084, 0.092],
]);

/** Typical swing per hand in big blinds (standard deviation), by Value raises and Aggression. */
const SdByRaiseAggr = F2([
  [34.1, 36.0, 36.8, 39.1, 41.7],
  [32.7, 33.6, 36.0, 37.2, 38.9],
  [31.4, 32.9, 34.5, 36.6, 37.6],
  [30.1, 31.2, 33.0, 34.3, 36.2],
  [28.0, 29.9, 30.3, 32.2, 33.7],
  [26.6, 27.3, 28.7, 29.6, 31.4],
  [25.6, 26.8, 27.5, 28.6, 29.8],
  [24.2, 25.3, 26.3, 27.3, 28.8],
  [23.5, 23.9, 25.1, 25.6, 27.4],
  [21.2, 22.4, 23.2, 23.6, 24.9],
  [19.0, 20.3, 20.7, 21.2, 22.2],
  [16.5, 16.6, 17.4, 17.6, 17.8],
]);

function lerp1(ys: number[], xs: number[], x: number): number {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++)
    if (x <= xs[i]!) return Mathf.lerp(ys[i - 1]!, ys[i]!, f(f(x - xs[i - 1]!) / f(xs[i]! - xs[i - 1]!)));
  return ys[ys.length - 1]!;
}

function index(xs: number[], x: number): number {
  let i = 0;
  while (i < xs.length - 2 && x > xs[i + 1]!) i++;
  return i;
}

const frac = (xs: number[], i: number, x: number): number => Mathf.clamp01(f(f(x - xs[i]!) / f(xs[i + 1]! - xs[i]!)));

function lerp2(t: number[][], rows: number[], cols: number[], r: number, c: number): number {
  r = f(r);
  c = f(c);
  const i = index(rows, r);
  const j = index(cols, c);
  const tr = frac(rows, i, r);
  const tc = frac(cols, j, c);
  const a = Mathf.lerp(t[i]![j]!, t[i]![j + 1]!, tc);
  const b = Mathf.lerp(t[i + 1]![j]!, t[i + 1]![j + 1]!, tc);
  return Mathf.lerp(a, b, tr);
}

export type Risk = 'Low' | 'Medium' | 'High';
export type StrategyValues = readonly number[];
export type StrategyStreets = readonly (StrategyValues | null)[] | null;

const pct = (v: number): string => Mathf.roundToInt(f(f(v) * 100)) + '%';

export const AgentStrategyWords = {
  Names,
  Min,
  Max,
  Reversed,

  /** Share of hands it plays (puts money in before the flop) at a Coins table. */
  handsPlayed: (v: StrategyValues): number => lerp2(VpipByRaiseFold, RaiseAxis, FoldAxis, v[1]!, v[0]!),
  /** Share of hands it raises before the flop. */
  raisesBeforeFlop: (v: StrategyValues): number => lerp2(PfrByRaiseAggr, RaiseAxis, AggrAxis, v[1]!, v[2]!),
  /** Share of its actions after the flop that are bets or raises. */
  pressure: (v: StrategyValues): number => lerp2(AfqByRaiseAggr, RaiseAxis, AggrAxis, v[1]!, v[2]!),
  /** Typical swing per hand in big blinds; bigger bets swing more. */
  swing: (pre: StrategyValues, post: StrategyValues): number =>
    f(lerp2(SdByRaiseAggr, RaiseAxis, AggrAxis, pre[1]!, post[2]!) * f(f(0.85) + f(f(0.3) * Mathf.inverseLerp(f(0.3), f(1.2), f(post[4]!))))),
  foldsToBets: (fold: number): number => lerp1(FoldToBet, FoldAxis, f(fold)),

  /** The numbers before the flop and after it (a strategy with round settings plays two sets). */
  before: (main: StrategyValues, streets: StrategyStreets): StrategyValues => streets?.[0] ?? main,
  after: (main: StrategyValues, streets: StrategyStreets): StrategyValues => streets?.[1] ?? streets?.[2] ?? streets?.[3] ?? main,

  riskOf: (swing: number): Risk => (swing < 25 ? 'Low' : swing < 33 ? 'Medium' : 'High'),

  /** "about 1 hand in 3", "about half of hands", "most hands". */
  oneIn(share: number, noun = 'hand'): string {
    share = f(share);
    if (share >= f(0.6)) return 'most ' + noun + 's';
    if (share >= f(0.45)) return 'about half of ' + noun + 's';
    const n = Math.max(2, Mathf.roundToInt(f(1 / Math.max(f(0.01), share))));
    return `about 1 ${noun} in ${n}`;
  },

  /** The strategy in one line, measured at a Coins table. */
  summary(main: StrategyValues, streets: StrategyStreets): string {
    const W = AgentStrategyWords;
    const pre = W.before(main, streets);
    const post = W.after(main, streets);
    const b = f(post[3]!);
    const bluff = b < f(0.015) ? 'never bluffs' : b < f(0.06) ? 'rarely bluffs' : 'bluffs often';
    return `Plays ${W.oneIn(W.handsPlayed(pre))}, raises ${W.oneIn(W.raisesBeforeFlop(pre))} before the flop, bets about ${pct(post[4]!)} of the pot, ${bluff}. Risk: ${W.riskOf(W.swing(pre, post)).toLowerCase()}.`;
  },

  /** One line for small places (the Overview's strategy card): hands played, bet size, risk. */
  shortSummary(main: StrategyValues, streets: StrategyStreets): string {
    const W = AgentStrategyWords;
    const pre = W.before(main, streets);
    const post = W.after(main, streets);
    return `Plays ${W.oneIn(W.handsPlayed(pre))} · bets ${pct(post[4]!)} of the pot · ${W.riskOf(W.swing(pre, post)).toLowerCase()} risk`;
  },

  /** The short tag on an advanced slider's right. */
  tag(i: number, v: StrategyValues): string {
    const W = AgentStrategyWords;
    switch (i) {
      case 0: return 'Folds ' + pct(W.foldsToBets(v[0]!)) + ' to bets';
      case 1: return 'Plays ' + W.oneIn(W.handsPlayed(v)).replace('about ', '');
      case 2: return pct(W.pressure(v)) + ' bets/raises';
      case 3: return f(v[3]!) < f(0.005) ? 'Never' : `${Mathf.roundToInt(f(f(v[3]!) * 100))} in 100`;
      default: return pct(v[4]!) + ' of pot';
    }
  },

  /** What an advanced slider does, with its measured effect at the current setting. */
  explain(i: number, v: StrategyValues): string {
    const W = AgentStrategyWords;
    switch (i) {
      case 0:
        return `How readily it calls a bet with a hand that's only worth a call. Right: calls more and sees more flops. Now it folds to about ${pct(W.foldsToBets(v[0]!))} of bets and plays ${W.oneIn(W.handsPlayed(v))}.`;
      case 1:
        return `Which starting hands it plays and raises. Right: more hands, bigger swings. Now it plays ${W.oneIn(W.handsPlayed(v))} and raises ${W.oneIn(W.raisesBeforeFlop(v))} before the flop.`;
      case 2:
        return `With a good hand, whether it raises or just calls. Right: raises more. After the flop ${pct(W.pressure(v))} of its actions are bets or raises. Against the bots at Coins tables, calmer often earns more.`;
      case 3:
        return f(v[3]!) < f(0.005)
          ? 'It never bets without a hand. Measured: bluffing loses Coins against the bots at Coins tables.'
          : `How often it bets with a weak hand (${Mathf.roundToInt(f(f(v[3]!) * 100))} times in 100). Measured: more than about 6 loses Coins against the bots at Coins tables.`;
      default: {
        const bet = roundHalfEven(f(50 + f(1000 * f(v[4]!))) / 50.0) * 50;
        return `Its bets: ${pct(v[4]!)} of the pot on top of the minimum. With 1,000 in the pot and a big blind of 50, it bets about ${formatN0(bet)}.`;
      }
    }
  },

  riskLine(r: Risk): string {
    switch (r) {
      case 'Low': return 'Steady results: smaller wins and smaller losses.';
      case 'Medium': return 'Some swings: a bad run can cost a good share of the bankroll.';
      default: return 'Big swings: it can double the bankroll or lose it quickly. Set a stop loss.';
    }
  },

  // ---- the novice dials

  /** Hands played, 0 (tight) .. 1 (loose): Hands it plays and Calling bets together (about 15% to 55% of hands). */
  raiseForDial: (d: number): number => Mathf.lerp(f(0.64), f(0.50), f(d)),
  foldForDial: (d: number): number => Mathf.lerp(f(0.50), f(0.15), f(d)),
  dialForHands: (v: StrategyValues): number => Mathf.clamp01(Mathf.inverseLerp(f(0.64), f(0.50), f(v[1]!))),

  /** Pressure, 0 (calm) .. 1 (pushy): raise vs call, bet size and a little bluffing (never past 6 in 100). */
  aggrForDial: (p: number): number => Mathf.lerp(f(0.15), f(0.85), f(p)),
  sizeForDial: (p: number): number => Mathf.lerp(f(0.40), f(0.95), f(p)),
  bluffForDial: (p: number): number => Mathf.lerp(0, f(0.06), f(p)),
  dialForPressure: (v: StrategyValues): number => Mathf.clamp01(Mathf.inverseLerp(f(0.15), f(0.85), f(v[2]!))),

  pressureWord: (p: number): string => (f(p) < f(0.34) ? 'Calm' : f(p) < f(0.67) ? 'Steady' : 'Pushy'),

  /** Unity's Mathf.Clamp + Mathf.Round(x*100)/100 (the editor's 2-decimal snap), float32. */
  snap2: (v: number, i: number): number => f(f(roundHalfEven(f(Mathf.clamp(f(v), Min[i]!, Max[i]!) * 100))) / 100),
};
