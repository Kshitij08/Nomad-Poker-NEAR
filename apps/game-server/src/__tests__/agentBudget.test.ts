import { describe, expect, it } from 'vitest';
import { ActionType, PlayerAction, legalActions } from '@nomad/engine/actions/actions';
import { capToBudget } from '@nomad/table-server/agentBudget';

// Facing a 100 bet with 0 in front: call 100, raise to 200..1000 (stack 1000).
const facing = legalActions(true, false, true, 100, false, true, 200, 1000, true);
// Nobody has bet: check, bet 20..1000.
const open = legalActions(true, true, false, 0, true, false, 20, 1000, true);

describe('Agent stop-loss budget', () => {
  it('keeps actions that fit', () => {
    expect(capToBudget(PlayerAction.raise(300), facing, 0, 1000, 500)).toEqual(PlayerAction.raise(300));
    expect(capToBudget(PlayerAction.call(), facing, 0, 1000, 100)).toEqual(PlayerAction.call());
    expect(capToBudget(PlayerAction.allIn(), facing, 0, 400, 400)).toEqual(PlayerAction.allIn());
  });

  it('cuts a raise or an all-in down to what it can still lose', () => {
    expect(capToBudget(PlayerAction.raise(900), facing, 0, 1000, 350)).toEqual(PlayerAction.raise(350));
    expect(capToBudget(PlayerAction.allIn(), open, 0, 1000, 250)).toEqual(PlayerAction.of(ActionType.Bet, 250));
  });

  it('calls instead when even the smallest raise is too big, and folds when the call is too', () => {
    expect(capToBudget(PlayerAction.raise(600), facing, 0, 1000, 150)).toEqual(PlayerAction.of(ActionType.Call, 100));
    expect(capToBudget(PlayerAction.call(), facing, 0, 1000, 60)).toEqual(PlayerAction.fold());
    expect(capToBudget(PlayerAction.allIn(), facing, 0, 1000, 0)).toEqual(PlayerAction.fold());
  });

  it('checks rather than folding when checking is free', () => {
    expect(capToBudget(PlayerAction.of(ActionType.Bet, 500), open, 0, 1000, 10)).toEqual(PlayerAction.check());
  });

  it('counts what is already in front of it this round', () => {
    // 100 already in this round, may lose 200 more: raise to at most 300.
    const later = legalActions(true, false, true, 100, false, true, 400, 1100, true);
    expect(capToBudget(PlayerAction.raise(800), later, 100, 1000, 200)).toEqual(PlayerAction.of(ActionType.Call, 100));
    const wide = legalActions(true, false, true, 100, false, true, 250, 1100, true);
    expect(capToBudget(PlayerAction.raise(800), wide, 100, 1000, 200)).toEqual(PlayerAction.raise(300));
  });
});
