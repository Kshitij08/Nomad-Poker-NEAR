/**
 * Deck commitments on a real PokerServerGame, in memory: a Quick Play table (filler bots, or a hand gate and two
 * players), an always-yes chip ledger, and a TableNet that decodes what the table sends and plays check/fold.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PlayerAction } from '@nomad/engine/actions/actions';
import { verifyDeck } from '@nomad/engine/cards/deckCommitment';
import { TablePhase, type HandStartedEvent } from '@nomad/engine/events/pokerEvent';
import { PokerEventCodec } from '@nomad/engine/events/pokerEventCodec';
import type { TableEconomy } from '../chipTableSession';
import { realClock } from '../clock';
import { LedgerResult, type ChipLedger } from '../ledger';
import { PokerServerGame, type DeckCommitmentNotice, type HandGate, type PokerServerGameOptions, type SettledHand } from '../pokerServerGame';
import type { PlayerRef, TableNet } from '../tableNet';

const SPEED = 40;

const ledger: ChipLedger = {
  authenticateAsync: async (ticket) => ticket,
  debitBuyInAsync: async () => LedgerResult.ok(1_000_000),
  checkpointAsync: async () => LedgerResult.ok(),
  creditCashOutAsync: async () => LedgerResult.ok(1_000_000),
  reconcileAsync: async () => LedgerResult.ok(),
  grantAsync: async () => LedgerResult.ok(),
  getBalanceAsync: async () => 1_000_000,
};
const economy: TableEconomy = { ledger, adoptTicket: (t) => t };

interface Run {
  game: PokerServerGame;
  starts: HandStartedEvent[];
  settled: SettledHand[];
  /** Hole cards each player was sent for themselves, by hand number. */
  mine: Map<PlayerRef, Map<number, string[]>>;
  errors: string[];
}

const games: PokerServerGame[] = [];
afterEach(() => {
  for (const g of games.splice(0)) g.dispose();
});

function table(opts: Partial<PokerServerGameOptions>, players: number): Run {
  const errors: string[] = [];
  const starts: HandStartedEvent[] = [];
  const settled: SettledHand[] = [];
  const mine = new Map<PlayerRef, Map<number, string[]>>();
  const seats = new Map<PlayerRef, number>();
  const refs = Array.from({ length: players }, (_, i) => i + 1);
  let hand = 0;
  const game = new PokerServerGame({
    clock: realClock(SPEED),
    log: (level, m) => void (level === 'error' && errors.push(m)),
    economy,
    random: () => 0.5,
    onHandSettled: (h) => void settled.push(h),
    ...opts,
  });
  games.push(game);
  const onPayload = (to: PlayerRef | 0, payload: Uint8Array) => {
    const { event: e } = PokerEventCodec.decode(payload);
    if (!e) return;
    if (e.type === 'HandStarted' && to === 0) {
      starts.push(e);
      hand = e.handNumber;
    }
    if (e.type === 'HoleCardsDealt' && to !== 0 && e.seat === seats.get(to) && e.card0.rank >= 2) {
      if (!mine.has(to)) mine.set(to, new Map());
      mine.get(to)!.set(hand, [e.card0.short, e.card1.short]);
    }
    if (e.type === 'TurnStarted' && e.forYou && to !== 0) {
      const seat = e.seat;
      const action = e.legal.canCheck ? PlayerAction.check() : PlayerAction.fold();
      setTimeout(() => game.onActionSubmitted(to, seat, action), 0);
    }
  };
  const net: TableNet = {
    sessionName: 'deck-test',
    properties: { kind: 'quick' },
    activePlayers: () => refs,
    broadcastEvent: (p) => onPayload(0, p),
    sendEventTo: (to, p) => onPayload(to, p),
    sendSeatAssignment: (to, seat) => void seats.set(to, seat),
    sendWalletBalance: () => {},
    broadcastRetentionGrantResult: () => {},
  };
  game.activate(net);
  for (const ref of refs) game.onHello(ref, `P${ref}`, `tok-${ref}`, `pid-${ref}`, 0);
  return { game, starts, settled, mine, errors };
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('deck commitments on PokerServerGame', () => {
  it('announces a commitment at every hand start and reveals a verifiable seed in the settled hand', async () => {
    const run = table({ deckCommitments: true, tableId: 't-deck-test' }, 1);
    await until(() => run.settled.length >= 3, 30_000, 'three settled hands');
    expect(run.errors).toEqual([]);
    expect(run.game.commitsDecks).toBe(true);

    const seeds = new Set<string>();
    for (const h of run.settled.slice(0, 3)) {
      const deck = h.deck!;
      expect(deck).toBeDefined();
      expect(deck.tableId).toBe('t-deck-test');
      expect(deck.handNumber).toBe(h.handNumber);
      expect(deck.seed).toMatch(/^[0-9a-f]{64}$/);
      // The commitment went out on the wire when this hand started.
      const start = run.starts.find((s) => s.handNumber === h.handNumber)!;
      expect(start.deckCommitment).toBe(deck.commitment);
      // Everyone dealt in is in the reveal, and it checks out against the seed.
      expect(deck.dealt.holeCards.map((x) => x.seat).sort()).toEqual(h.stacks.map((s) => s.seat).filter((s) => s >= 0).sort());
      expect(verifyDeck(deck)).toEqual({ ok: true, reason: null });
      // And the cards the player was actually sent are the seed's cards.
      const sent = run.mine.get(1)?.get(h.handNumber);
      if (sent) expect(deck.dealt.holeCards.find((x) => x.cards?.[0] === sent[0])?.cards).toEqual(sent);
      seeds.add(deck.seed);
    }
    // Different hands, different seeds.
    expect(seeds.size).toBe(3);
  }, 40_000);

  it('a tampered reveal fails verification', async () => {
    const run = table({ deckCommitments: true }, 1);
    await until(() => run.settled.length >= 1, 20_000, 'a settled hand');
    const deck = run.settled[0]!.deck!;
    expect(verifyDeck(deck).ok).toBe(true);
    const flipped = (deck.seed[0] === '0' ? '1' : '0') + deck.seed.slice(1);
    expect(verifyDeck({ ...deck, seed: flipped }).ok).toBe(false);
    const holeCards = deck.dealt.holeCards.map((x, i) => (i === 0 ? { seat: x.seat, cards: [x.cards![1]!, x.cards![0]!] } : x));
    expect(verifyDeck({ ...deck, dealt: { ...deck.dealt, holeCards } }).ok).toBe(false);
  }, 30_000);

  it('Coins tables are unchanged by default: no commitment, no reveal', async () => {
    const run = table({}, 1);
    await until(() => run.settled.length >= 2, 30_000, 'two settled hands');
    expect(run.game.commitsDecks).toBe(false);
    expect(run.starts.every((s) => s.deckCommitment === undefined)).toBe(true);
    expect(run.settled.every((h) => h.deck === undefined)).toBe(true);
  }, 40_000);

  it('a hand gate sees the commitment before the deal and the reveal after, and the table seats no bots', async () => {
    const before: DeckCommitmentNotice[] = [];
    const after: SettledHand[] = [];
    let startsAtBeforeDeal = -1;
    let run: Run | null = null;
    const gate: HandGate = {
      beforeDeal: async (c) => {
        startsAtBeforeDeal = run!.starts.filter((s) => s.handNumber === c.handNumber).length;
        before.push(c);
        return true;
      },
      afterSettle: async (h) => {
        after.push(h);
        return true;
      },
    };
    run = table({ handGate: gate, tableId: 't-gate' }, 2);
    await until(() => after.length >= 2, 30_000, 'two gated hands');
    expect(run.errors).toEqual([]);
    expect(startsAtBeforeDeal).toBe(0); // the commitment reached the gate before the hand was dealt
    expect(before[0]!.commitment).toBe(after[0]!.deck!.commitment);
    expect(before[0]!.tableId).toBe('t-gate');
    expect(verifyDeck(after[0]!.deck!).ok).toBe(true);
    expect(after[0]!.stacks.every((s) => !s.bot)).toBe(true);
  }, 40_000);

  it('a hand gate that refuses the deal halts the table before any card is dealt', async () => {
    let asked = 0;
    const gate: HandGate = { beforeDeal: async () => (asked++, false), afterSettle: async () => true };
    const run = table({ handGate: gate }, 2);
    await until(() => asked > 0 && run.game.tablePhase !== TablePhase.Playing, 20_000, 'the table to stop');
    await new Promise((r) => setTimeout(r, 200));
    expect(asked).toBe(1);
    expect(run.starts).toEqual([]);
    expect(run.settled).toEqual([]);
  }, 30_000);
});
