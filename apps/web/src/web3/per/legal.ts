/**
 * What the awaited seat may do, computed from the on-chain Game exactly as the program does (engine.rs `legal`,
 * itself a port of PokerEngine.ComputeLegalActions). Port of Per/Core/PerLegal.cs (PerGame). The program re-checks
 * every action, so this only drives the betting panel. Stacks are lamports (bigint) on chain; the panel takes numbers.
 */
import { BettingRound, Card, legalActions, NO_LEGAL_ACTIONS, type LegalActions } from '@nomad/engine';
import type { Game, GameSeat } from './types';

export const PerGame = {
  // engine.rs constants (C# PlayerStatus / BettingRound order).
  Empty: 0, SittingOut: 1, Active: 2, Folded: 3, AllIn: 4, Busted: 5,
  NoSeat: 255,
  Done: 5,
  // Hand log kinds beyond the engine actions, and the timeout flag.
  LogSmallBlind: 6, LogBigBlind: 7, LogTimeout: 0x80,
  // Table.hand_state.
  HandIdle: 0, HandShuffling: 1, HandDealt: 2, HandPlaying: 3,
  StatusOpen: 1, StatusClosed: 2,
  NoCard: 255,

  inHand: (s: GameSeat): boolean => s.status === PerGame.Active || s.status === PerGame.AllIn,

  legal(g: Game): LegalActions {
    if (g.toAct === PerGame.NoSeat) return NO_LEGAL_ACTIONS;
    const p = g.seats[g.toAct]!;
    const toCall = g.highBet > p.currentBet ? g.highBet - p.currentBet : 0n;
    const callAmount = toCall < p.stack ? toCall : p.stack;
    const maxRaiseTo = p.currentBet + p.stack;
    let canActCount = 0;
    for (let i = 0; i < g.seatCount; i++) if (canAct(g.seats[i]!)) canActCount++;
    const opponentsCanAct = !g.runout && canActCount > 1;
    const canCheck = toCall === 0n;
    const canCall = toCall > 0n && p.stack > 0n;
    let canBet = false;
    let canRaise = false;
    let minRaiseTo = 0n;
    if (toCall === 0n) {
      if (p.stack > 0n && opponentsCanAct) {
        canBet = true;
        minRaiseTo = min(p.currentBet + g.minRaise, maxRaiseTo);
      }
    } else if (p.stack > toCall && opponentsCanAct) {
      canRaise = true;
      minRaiseTo = min(g.highBet + g.minRaise, maxRaiseTo);
    }
    let canAllIn = p.stack > 0n && (toCall > 0n || opponentsCanAct);
    if (toCall > 0n && p.stack > toCall && !opponentsCanAct) canAllIn = false;
    return legalActions(true, canCheck, canCall, Number(callAmount), canBet, canRaise, Number(minRaiseTo), Number(maxRaiseTo), canAllIn);
  },

  toCard: (c: number): Card => Card.fromIndex(c),
  toRound: (street: number): BettingRound => (street <= 4 ? (street as BettingRound) : BettingRound.Showdown),
};

const canAct = (s: GameSeat): boolean => s.status === PerGame.Active && s.stack > 0n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
