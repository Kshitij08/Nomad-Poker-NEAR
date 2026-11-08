import { PlayerAction, type LegalActions } from '../actions/actions';
import { TableMoney } from './tableMoney';

/**
 * The non-visual rules of Game/UI/BettingPanel.cs (designed two-step layout: Bet/Raise opens the CONFIRM panel,
 * presets/slider/+/- pick the amount, CONFIRM submits, close backs out). A web view renders this state.
 */
export interface BettingPanelState {
  foldEnabled: boolean;
  foldLabel: 'Fold';
  checkCallEnabled: boolean;
  /** "Check", "Call 1,250" (callAmount, the delta) — or "Check" (disabled) when neither is legal. */
  checkCallLabel: string;
  betRaiseEnabled: boolean;
  betRaiseLabel: 'Raise' | 'Bet';
  /** True when the wager is a Raise (legal.canRaise), else Bet. */
  wagerIsRaise: boolean;
  /** Slider bounds (bet/raise TO totals). Only meaningful when betRaiseEnabled. */
  sliderMin: number;
  sliderMax: number;
  /** Initial amount when the panel opens: the minimum raise-to. */
  initialAmount: number;
  /** Chips per +/- press (min-raise increment; at least 1). */
  step: number;
}

export function bettingPanelState(legal: LegalActions, myCurrentBet: number): BettingPanelState {
  const canWager = legal.canBet || legal.canRaise;
  return {
    foldEnabled: legal.canFold,
    foldLabel: 'Fold',
    checkCallEnabled: legal.canCheck || legal.canCall,
    checkCallLabel: legal.canCheck ? 'Check' : legal.canCall ? 'Call ' + TableMoney.chips(legal.callAmount) : 'Check',
    betRaiseEnabled: canWager,
    betRaiseLabel: legal.canRaise ? 'Raise' : 'Bet',
    wagerIsRaise: legal.canRaise,
    sliderMin: legal.minRaiseTo,
    sliderMax: Math.max(legal.minRaiseTo, legal.maxRaiseTo),
    initialAmount: legal.minRaiseTo,
    step: stepSize(legal, myCurrentBet),
  };
}

/** Chips per +/- press: MinRaiseTo - myCurrentBet - CallAmount (the min-raise increment), at least 1. */
export function stepSize(legal: LegalActions, myCurrentBet: number, amountStep = 0): number {
  if (amountStep > 0) return amountStep;
  return Math.max(1, legal.minRaiseTo - myCurrentBet - legal.callAmount);
}

/** Preset 1/4, 1/2, 3/4: current bet + that fraction of the chips behind (truncated), then clamped to the slider. */
export function stackFraction(legal: LegalActions, myCurrentBet: number, fraction: number): number {
  // C#: (long)(stackBehind * fraction) with a float fraction → float32 multiply, then truncate.
  return myCurrentBet + Math.trunc(Math.fround(Math.fround(legal.maxRaiseTo - myCurrentBet) * Math.fround(fraction)));
}

/** SetAmount: clamp into [sliderMin, sliderMax]. */
export function clampAmount(state: BettingPanelState, value: number): number {
  return Math.min(Math.max(value, state.sliderMin), state.sliderMax);
}

/** Preset buttons in the CONFIRM panel → amount. Labels (Confirm_Panel.prefab): MIN, 1/4, 1/2, 3/4, ALL IN. */
export function presetAmount(preset: 'MIN' | '1/4' | '1/2' | '3/4' | 'ALL IN', legal: LegalActions, myCurrentBet: number): number {
  const s = bettingPanelState(legal, myCurrentBet);
  switch (preset) {
    case 'MIN': return clampAmount(s, legal.minRaiseTo);
    case '1/4': return clampAmount(s, stackFraction(legal, myCurrentBet, 0.25));
    case '1/2': return clampAmount(s, stackFraction(legal, myCurrentBet, 0.5));
    case '3/4': return clampAmount(s, stackFraction(legal, myCurrentBet, 0.75));
    case 'ALL IN': return clampAmount(s, legal.maxRaiseTo);
  }
}

/** Check/Call button → action. */
export function checkCallAction(legal: LegalActions): PlayerAction {
  return legal.canCheck ? PlayerAction.check() : PlayerAction.call();
}

/**
 * CONFIRM → action. Note: the panel never submits ActionType.AllIn — "ALL IN" sets the amount to maxRaiseTo and
 * submits Raise/Bet to that total (the engine accepts it as a legal raise/bet to the max).
 */
export function wagerAction(legal: LegalActions, amount: number): PlayerAction {
  return legal.canRaise ? PlayerAction.raise(amount) : PlayerAction.bet(amount);
}

/** Slider / amount label text: TableMoney.Pot(v) → "1,250". */
export function amountLabel(v: number): string {
  return TableMoney.pot(v);
}
