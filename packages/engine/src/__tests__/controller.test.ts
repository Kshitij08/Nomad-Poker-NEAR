// A full single-player hand through PokerGameController + TableEventPresenter on a virtual clock: pacing, view calls,
// sounds, status strings, turn timer timeout.
import { describe, expect, it } from 'vitest';
import {
  PokerGameController, PokerSound, SeatRole, TEST_SCENE_TABLE_SETTINGS, bettingPanelState, presetAmount, legalActions,
  wagerAction, ActionType, type AudioPort, type BettingPanelPort, type Card, type LegalActions, type PlayerAction,
  type TableViewPort, type WaitFn,
} from '../index';

/** Deterministic virtual time: waits resolve in time order; all microtasks settle between timers. */
class VirtualClock {
  now = 0;
  private timers: { at: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;

  wait: WaitFn = (seconds, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = { at: this.now + Math.max(0, seconds), seq: this.seq++, resolve };
    this.timers.push(t);
    signal?.addEventListener('abort', () => {
      this.timers = this.timers.filter((x) => x !== t);
      resolve();
    }, { once: true });
  });

  async runUntil(done: () => boolean, maxTime = 1e6): Promise<void> {
    for (;;) {
      await flush();
      if (done() || this.timers.length === 0 || this.now > maxTime) return;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = this.timers.shift()!;
      this.now = t.at;
      t.resolve();
    }
  }
}

// Node macrotask hop (tests run in vitest's node environment; the app tsconfig has no node types).
const setImm = (globalThis as unknown as { setImmediate: (cb: () => void) => void }).setImmediate;
const flush = () => new Promise<void>((r) => setImm(r));

type Call = { t: number; name: string; args: unknown[] };

function recordingView(clock: VirtualClock, seats: number, betting: BettingPanelPort | null): TableViewPort & { calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push({ t: clock.now, name, args }); };
  return {
    calls,
    seatCount: seats,
    betting,
    bindSeat: rec('bindSeat'), hideSeat: rec('hideSeat'), beginHand: rec('beginHand'), resetSeatForHand: rec('resetSeatForHand'),
    showBlind: rec('showBlind'), showHoleCards: rec('showHoleCards'), showBoard: rec('showBoard'), showAction: rec('showAction'),
    showShowdown: rec('showShowdown'), showPotAward: rec('showPotAward'), endHand: rec('endHand'), showMessage: rec('showMessage'),
    showGameOver: rec('showGameOver'), setTurn: rec('setTurn'), clearTurn: rec('clearTurn'),
  };
}

function recordingAudio(clock: VirtualClock): AudioPort & { sounds: { t: number; s: PokerSound | string }[] } {
  const sounds: { t: number; s: PokerSound | string }[] = [];
  return {
    sounds,
    play: (s) => sounds.push({ t: clock.now, s }),
    startTurnTimer: (sec) => sounds.push({ t: clock.now, s: `timer-start ${sec}` }),
    stopTurnTimer: () => sounds.push({ t: clock.now, s: 'timer-stop' }),
  };
}

/** A human who never answers: the turn times out. */
const afkPanel = (): BettingPanelPort & { shows: LegalActions[]; hides: number } => {
  const p = { shows: [] as LegalActions[], hides: 0, show(l: LegalActions) { p.shows.push(l); }, hide() { p.hides++; } };
  return p;
};

describe('PokerGameController (single player)', () => {
  it('binds seats like Unity: You at 0, "Bot 1".."Bot 6", 7th..8th views hidden', () => {
    const clock = new VirtualClock();
    const view = recordingView(clock, 8, afkPanel());
    new PokerGameController({ ...TEST_SCENE_TABLE_SETTINGS, useFixedSeed: true }, view, recordingAudio(clock), { wait: clock.wait });
    const binds = view.calls.filter((c) => c.name === 'bindSeat').map((c) => c.args.slice(0, 4));
    expect(binds).toEqual([
      [0, 'You', 5000, false], [1, 'Bot 1', 5000, true], [2, 'Bot 2', 5000, true], [3, 'Bot 3', 5000, true],
      [4, 'Bot 4', 5000, true], [5, 'Bot 5', 5000, true], [6, 'Bot 6', 5000, true],
    ]);
    expect(view.calls.filter((c) => c.name === 'hideSeat').length).toBe(0); // seatCount 7 → the 8th view is untouched
  });

  it('first hand: event order, pacing, sounds and a timed-out human (check if free, else fold)', async () => {
    const clock = new VirtualClock();
    const panel = afkPanel();
    const view = recordingView(clock, 7, panel);
    const audio = recordingAudio(clock);
    const settings = { ...TEST_SCENE_TABLE_SETTINGS, useFixedSeed: true, seed: 12345 };
    const c = new PokerGameController(settings, view, audio, { wait: clock.wait, thinkRandom: () => 0.5 });
    void c.start();
    await clock.runUntil(() => view.calls.some((x) => x.name === 'endHand'));

    const calls = view.calls.filter((x) => x.name !== 'bindSeat' || x.t > 0);
    const begin = calls.find((x) => x.name === 'beginHand')!;
    expect(begin.args).toEqual([1]);
    expect(begin.t).toBe(0); // first hand starts after one "frame" (Wait(0))

    // Roles for hand 1: button = first funded seat (0), SB 1, BB 2.
    const roles = calls.filter((x) => x.name === 'resetSeatForHand').map((x) => [x.args[0], x.args[2]]);
    expect(roles.slice(0, 3)).toEqual([[0, SeatRole.Dealer], [1, SeatRole.SmallBlind], [2, SeatRole.BigBlind]]);

    // Blinds then 7 deals, each followed by dealDelay (0.12 s); then the 5 s deal-settle before the first turn.
    const blinds = calls.filter((x) => x.name === 'showBlind');
    expect(blinds.map((x) => x.t)).toEqual([0, 0.12]);
    const deals = calls.filter((x) => x.name === 'showHoleCards');
    expect(deals.length).toBe(7);
    expect(deals[0]!.args[3]).toBe(true); // seat 0 (you) face up
    expect(deals.slice(1).every((d) => d.args[3] === false)).toBe(true);
    const firstTurn = calls.find((x) => x.name === 'setTurn')!;
    expect(firstTurn.args).toEqual([3, 15]); // UTG = seat 3, 15 s radial
    expect(firstTurn.t).toBeCloseTo(0.24 + 7 * 0.12 + 5, 6);

    // Bot think = min + 0.5*(max-min) = 1.0 s, then actionDelay 0.4 s before the next turn.
    const firstAction = calls.find((x) => x.name === 'showAction')!;
    expect(firstAction.t).toBeCloseTo(firstTurn.t + 1.0, 6);
    const secondTurn = calls.filter((x) => x.name === 'setTurn')[1]!;
    expect(secondTurn.t).toBeCloseTo(firstAction.t + 0.4, 6);

    // The human (seat 0) never answers: 15 s later the panel is hidden and the safe default is taken.
    const humanTurn = calls.find((x) => x.name === 'setTurn' && x.args[0] === 0);
    expect(humanTurn, "seed 12345: the human gets a turn in hand 1").toBeDefined();
    if (humanTurn) {
      const humanAct = calls.find((x) => x.name === 'showAction' && x.args[0] === 0 && x.t > humanTurn.t)!;
      expect(humanAct.t).toBeCloseTo(humanTurn.t + 15, 6);
      expect(['Check', 'Fold']).toContain(humanAct.args[3]);
      expect(panel.shows.length).toBeGreaterThan(0);
      expect(audio.sounds.some((s) => s.s === PokerSound.YourTurn && s.t === humanTurn.t)).toBe(true);
      expect(audio.sounds.some((s) => s.s === 'timer-start 15' && s.t === humanTurn.t)).toBe(true);
      expect(audio.sounds.some((s) => s.s === 'timer-stop' && s.t === humanAct.t)).toBe(true);
    }

    // Status strings come from the presenter.
    for (const a of calls.filter((x) => x.name === 'showAction')) expect(String(a.args[3])).toMatch(/^(Fold|Check|All-In|(Call|Bet|Raise) [\d,]+)$/);

    // One deal sound for the whole table.
    expect(audio.sounds.filter((s) => s.s === PokerSound.HoleCardsDealt).length).toBe(1);

    // The hand ends with a pot award; HandEnded (endHand + CardsReturned) comes showdownDelay (2 s) after the last award.
    const awards = calls.filter((x) => x.name === 'showPotAward');
    expect(awards.length).toBeGreaterThan(0);
    expect(String(awards[0]!.args[2])).toMatch(/^.+ wins [\d,]+ \((Pot|Main pot|Side pot|Uncontested)\)$/);
    const end = calls.find((x) => x.name === 'endHand')!;
    expect(end.t).toBeCloseTo(awards[awards.length - 1]!.t + 2, 6);
    expect(audio.sounds.some((s) => s.s === PokerSound.CardsReturned && s.t === end.t)).toBe(true);
    expect(audio.sounds.some((s) => s.s === PokerSound.ChipsToWinner)).toBe(true);

    // Next hand starts betweenHands (2.5 s) after HandEnded.
    await clock.runUntil(() => view.calls.filter((x) => x.name === 'beginHand').length >= 2);
    const begin2 = view.calls.filter((x) => x.name === 'beginHand')[1]!;
    expect(begin2.args).toEqual([2]);
    expect(begin2.t).toBeCloseTo(end.t + 2.5, 6);
    c.stop();
  });

  it('plays to the end; GameOver is NOT presented (Unity quirk) unless presentGameOver is set', async () => {
    for (const presentGameOver of [false, true]) {
      const clock = new VirtualClock();
      const view = recordingView(clock, 3, afkPanel());
      const c = new PokerGameController(
        { seatCount: 3, botCount: 2, startingStack: 300, useFixedSeed: true, seed: 3, turnTimer: 1 },
        view, recordingAudio(clock), { wait: clock.wait, presentGameOver },
      );
      await Promise.race([c.start(), clock.runUntil(() => false, 1e7)]);
      await clock.runUntil(() => false, 1e7);
      expect(c.engine.countFundedPlayers()).toBeLessThan(2);
      const shown = view.calls.filter((x) => x.name === 'showGameOver').map((x) => x.args[0]);
      if (presentGameOver) expect(shown).toEqual([`${c.engine.table.seats.find((p) => p.stack > 0)!.name} wins the game!`]);
      else expect(shown).toEqual([]);
    }
  });
});

describe('betting panel rules', () => {
  it('facing a bet: Fold / "Call 150" / Raise with slider min..max and presets', () => {
    const l = legalActions(true, false, true, 150, false, true, 400, 5000, true);
    const s = bettingPanelState(l, 50);
    expect(s.checkCallLabel).toBe('Call 150');
    expect(s.betRaiseLabel).toBe('Raise');
    expect([s.sliderMin, s.sliderMax, s.initialAmount, s.step]).toEqual([400, 5000, 400, 200]);
    expect(presetAmount('1/2', l, 50)).toBe(50 + Math.trunc(4950 * 0.5));
    expect(presetAmount('1/4', l, 50)).toBe(1287);
    expect(presetAmount('ALL IN', l, 50)).toBe(5000);
    expect(wagerAction(l, 5000)).toEqual({ type: ActionType.Raise, amount: 5000 });
  });

  it('checked to: Check / Bet; short stack facing a shove: Call only, no wager', () => {
    const open = bettingPanelState(legalActions(true, true, false, 0, true, false, 50, 1200, true), 0);
    expect([open.checkCallLabel, open.betRaiseLabel, open.betRaiseEnabled]).toEqual(['Check', 'Bet', true]);
    const shoved = bettingPanelState(legalActions(true, false, true, 800, false, false, 0, 800, true), 0);
    expect([shoved.checkCallLabel, shoved.betRaiseEnabled]).toEqual(['Call 800', false]);
  });
});

// Keep imported types referenced for isolatedModules builds.
export type _Unused = Card | PlayerAction;
