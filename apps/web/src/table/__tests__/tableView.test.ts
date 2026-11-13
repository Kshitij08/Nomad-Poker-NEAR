// TableView: the action row / raise sheet never outlive a turn (the timeout soft-lock).
import { describe, expect, it } from 'vitest';
import { PlayerAction, type BettingPanelPort, type LegalActions } from '@nomad/engine';
import { TableView, type SeatHud } from '../tableView';
import type { SplineCardDealer } from '../splineCardDealer';

/** A betting panel that models the raise sheet: open after show() + openSheet(), closed by hide(). */
function panel() {
  const p = {
    showing: false,
    sheetOpen: false,
    onChosen: null as ((a: PlayerAction) => void) | null,
    show(_l: LegalActions, _bet: number, cb: (a: PlayerAction) => void) {
      p.showing = true;
      p.onChosen = cb;
    },
    hide() {
      p.showing = false;
      p.sheetOpen = false;
      p.onChosen = null;
    },
    openSheet() {
      if (p.showing) p.sheetOpen = true;
    },
  };
  return p;
}

const seat = (): SeatHud => {
  const noop = () => {};
  return {
    bind: noop, setStack: noop, setBet: noop, setStatus: noop, setRole: noop, setBot: noop, setFolded: noop, setWinner: noop,
    resetForNewHand: noop, setHoleCards: noop, showHandStrength: noop, updateHandStrength: noop, hideHandStrength: noop,
    setActiveTurn: noop, startTurnTimer: noop, stopTurnTimer: noop, setVisible: noop, visible: true,
  };
};

const dealer = { clear() {}, returnHoleCards() {}, withdrawCommunityCards() {} } as unknown as SplineCardDealer;

describe('TableView turn end', () => {
  it('closes the action row and an open raise sheet when the turn times out', () => {
    const betting = panel();
    const view = new TableView({ seats: [seat(), seat()], pot: { setPot() {}, setMessage() {}, awardTokensTo() {} }, betting: betting as unknown as BettingPanelPort }, dealer, []);
    // Your turn: the row shows and you open the raise sheet…
    view.setTurn(0, 15);
    betting.show({} as LegalActions, 0, () => {});
    betting.openSheet();
    expect(betting.sheetOpen).toBe(true);
    // …and the clock runs out: the engine / server auto-folds and the turn is cleared.
    view.clearTurn(0);
    expect(betting.showing).toBe(false);
    expect(betting.sheetOpen).toBe(false);
    // The next turn starts clean: the row can show again and the old callback is gone.
    betting.show({} as LegalActions, 0, () => {});
    expect(betting.showing).toBe(true);
    expect(betting.sheetOpen).toBe(false);
  });
});
