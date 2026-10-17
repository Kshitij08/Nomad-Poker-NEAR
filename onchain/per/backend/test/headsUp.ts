// A small heads-up no-limit hold'em table for bot-vs-bot simulations (test/brain.test.ts). It drives decide() through
// the same Game / legal() view the Agent gets on chain. Seeded throughout, so a run replays exactly.
import { decide, Game, handValue, legal, Profile, ST } from "../src/agentBot";

/** Park-Miller style LCG in [0, 1): small, fast and reproducible. */
export function seeded(seed: number): () => number {
  let x = (seed >>> 0) % 2147483647 || 1;
  return () => (x = (x * 48271) % 2147483647) / 2147483647;
}

export type Bot = { profile: Profile; rnd: () => number };

/**
 * Plays one hand from a fixed deck. Seat 0 is the button (posts the small blind, acts first preflop and last after).
 * Both start with `stack` chips. Returns seat 0's net in chips. With `allInEv`, once someone is all-in before the
 * river the pot is shared by each hand's exact equity instead of one runout: same expectation, far less noise (the
 * usual way to measure bots).
 */
export function playHand(bots: [Bot, Bot], deck: number[], stack = 2000n, bb = 20n, allInEv = true): number {
  const sb = bb / 2n;
  const holes = [[deck[0], deck[2]], [deck[1], deck[3]]];
  const fullBoard = deck.slice(4, 9);
  const seats = [
    { status: ST.active as number, stack: stack - sb, currentBet: sb },
    { status: ST.active as number, stack: stack - bb, currentBet: bb },
  ];
  const put = [sb, bb];
  const g: Game = { seatCount: 2, seats, button: 0, toAct: 0, highBet: bb, minRaise: bb, pot: sb + bb, runout: false, board: [], boardLen: 0, bigBlind: bb, street: 0 };
  for (let street = 0; street < 4; street++) {
    if (street > 0) {
      if (allInEv && seats.some((x) => x.status === ST.allIn)) return allInResult(put, holes, fullBoard.slice(0, street === 1 ? 0 : street + 1));
      g.board = fullBoard.slice(0, street + 2);
      g.boardLen = g.board.length;
      g.street = street;
      for (const s of seats) s.currentBet = 0n;
      g.highBet = 0n;
      g.minRaise = bb;
      g.toAct = 1;
    }
    // A call that put someone all-in for less leaves the bigger stack's excess unmatched; settle() returns it.
    const canAct = (s: (typeof seats)[number]) => s.status === ST.active && s.stack > 0n;
    // Who still has to act this round. A player all-in, or alone with chips and nothing to call, doesn't.
    const pending = new Set([0, 1].filter((i) => canAct(seats[i])));
    if (pending.size < 2 && seats[0].currentBet === seats[1].currentBet) pending.clear();
    if (pending.size === 1 && seats[[...pending][0]].currentBet >= g.highBet) pending.clear();
    g.runout = pending.size === 0;
    while (pending.size) {
      if (!pending.has(g.toAct)) g.toAct = 1 - g.toAct;
      const i = g.toAct, me = seats[i];
      const l = legal(g)!;
      const d = decide(bots[i].profile, holes[i], g.board, g, 1, bots[i].rnd);
      pending.delete(i);
      if (d.kind === "fold") return settle(put, 1 - i);
      let add = 0n;
      if (d.kind === "call") { if (!l.canCall) throw new Error("illegal call"); add = l.callAmount; }
      else if (d.kind === "bet" || d.kind === "raise") {
        if (!(d.kind === "bet" ? l.canBet : l.canRaise) || d.amount < l.minRaiseTo || d.amount > l.maxRaiseTo) throw new Error(`illegal ${d.kind} ${d.amount}`);
        if (d.amount - g.highBet >= g.minRaise) g.minRaise = d.amount - g.highBet;
        add = d.amount - me.currentBet;
      } else if (!l.canCheck) throw new Error("illegal check");
      me.stack -= add; me.currentBet += add; put[i] += add; g.pot += add;
      if (me.currentBet > g.highBet) { g.highBet = me.currentBet; if (canAct(seats[1 - i])) pending.add(1 - i); }
      if (me.stack === 0n) me.status = ST.allIn;
      g.toAct = 1 - i;
    }
  }
  const v0 = handValue([...holes[0], ...fullBoard]), v1 = handValue([...holes[1], ...fullBoard]);
  return settle(put, v0 > v1 ? 0 : v1 > v0 ? 1 : -1);
}

/** Seat 0's net when `winner` takes the pot (-1 = split). An unmatched excess goes back to whoever put it in. */
function settle(put: bigint[], winner: number): number {
  const matched = Number(put[0] < put[1] ? put[0] : put[1]);
  if (winner === -1) return 0;
  return winner === 0 ? matched : -matched;
}

/** Seat 0's expected net with the board still to come: every runout after the flop, 4000 sampled ones preflop. */
function allInResult(put: bigint[], holes: number[][], board: number[]): number {
  const matched = Number(put[0] < put[1] ? put[0] : put[1]);
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !holes[0].includes(c) && !holes[1].includes(c) && !board.includes(c));
  let share = 0, count = 0;
  const score = (runout: number[]) => {
    const v0 = handValue([...holes[0], ...runout]), v1 = handValue([...holes[1], ...runout]);
    share += v0 > v1 ? 1 : v0 === v1 ? 0.5 : 0;
    count++;
  };
  if (board.length === 4) for (const a of rest) score([...board, a]);
  else if (board.length === 3) for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([...board, rest[i], rest[j]]);
  else {
    const r = seeded(holes[0][0] * 2704 + holes[0][1] * 52 + holes[1][0] + 1);
    for (let k = 0; k < 4000; k++) {
      for (let i = 0; i < 5; i++) { const j = i + Math.floor(r() * (rest.length - i)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      score(rest.slice(0, 5));
    }
  }
  return matched * (2 * share / count - 1);
}

/**
 * Duplicate heads-up match: every deal is played twice with the seats swapped, so card luck cancels out.
 * Returns A's result in big blinds per 100 hands, its standard error, and the hands played.
 */
export function match(a: Profile, b: Profile, deals: number, seed: number, stack = 2000n, bb = 20n, allInEv = true) {
  const deckRnd = seeded(seed);
  const botA = { profile: a, rnd: seeded(seed * 7 + 1) }, botB = { profile: b, rnd: seeded(seed * 13 + 2) };
  const perDeal: number[] = [];
  for (let d = 0; d < deals; d++) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 0; i < 9; i++) { const j = i + Math.floor(deckRnd() * (52 - i)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const aOnButton = playHand([botA, botB], deck, stack, bb, allInEv);
    const bOnButton = playHand([botB, botA], deck, stack, bb, allInEv);
    perDeal.push((aOnButton - bOnButton) / Number(bb));
  }
  const mean = perDeal.reduce((s, x) => s + x, 0) / perDeal.length;
  const sd = Math.sqrt(perDeal.reduce((s, x) => s + (x - mean) ** 2, 0) / (perDeal.length - 1));
  // Two hands per deal: per-hand mean is mean/2; bb/100 is that times 100.
  return { bbPer100: (mean / 2) * 100, stdErr: (sd / Math.sqrt(perDeal.length) / 2) * 100, hands: perDeal.length * 2 };
}
