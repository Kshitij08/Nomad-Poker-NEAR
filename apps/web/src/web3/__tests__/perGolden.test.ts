/**
 * Golden checks for the PER client against recorded / fixed data:
 *  - the verifier against the program's fixed vector (dealing.rs known_vector, as per/client-harness `vector`);
 *  - PerTableSession replaying hand 5 of devnet table BPPX… (per/results/replay-BPPX-*.json, copied to golden/replay-BPPX.json; recorded by
 *    per/scripts/replay-stacks.ts from the real chain) from synthesized rollup accounts, encoded with the IDL coder in
 *    the program's own layouts: the event stream must reproduce the recorded actions, showdown and stacks.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { ActionType, BettingRound, Card, type PokerEvent } from '@nomad/engine';
import { concat, hex, utf8 } from '../lib/bytes';
import { PerTableAddresses } from '../per/addresses';
import { PerGame } from '../per/legal';
import { LocalSigner, type PerRpc } from '../per/rpc';
import { PerTableSession } from '../per/tableSession';
import { decode, perIdl } from '../per/types';
import { board, dealOrder, firstButton, holeCards, shuffle, shuffleSeed, verify } from '../per/verifier';
import replay from './golden/replay-BPPX.json';

describe('PerVerifier fixed vector (dealing.rs known_vector)', () => {
  it('shuffle seed, deck and first button match the program', () => {
    const table = new Uint8Array(32).fill(7);
    const seeds = Array.from({ length: 9 }, () => new Uint8Array(32));
    seeds[0] = new Uint8Array(32).fill(1);
    seeds[3] = new Uint8Array(32).fill(2);
    const entropy = sha256(concat(utf8('poker-per/entropy/v1'), new Uint8Array(32).fill(9)));
    const seed = shuffleSeed(table, 5n, entropy, 0b1001, seeds);
    expect(hex(seed)).toBe('d12346b4bf0787f377276f2df1ed63464de16f3a0352a6a3e956f59b299fc540');
    expect(shuffle(seed)).toEqual([14, 22, 24, 23, 15, 17, 13, 49, 35, 11, 34, 10, 25, 39, 42, 33, 6, 40, 26, 21, 20, 28, 31, 32, 27, 48, 47, 38, 41, 46, 45, 4, 36, 18, 43, 44, 9, 30, 19, 37, 7, 0, 8, 16, 50, 3, 29, 51, 2, 5, 12, 1]);
    expect(firstButton(seed, 0b1001)).toBe(3);
    expect(Card.fromIndex(0).short).toBe('2c');
    expect(Card.fromIndex(51).short).toBe('As');
  });

  it('verify() accepts a consistent record and catches a tampered deck', () => {
    const table = new Uint8Array(32).fill(3);
    const seeds = Array.from({ length: 9 }, () => new Uint8Array(32));
    seeds[1] = new Uint8Array(32).fill(5);
    const entropy = new Uint8Array(32).fill(4);
    const ss = shuffleSeed(table, 1n, entropy, 0b10, seeds);
    const cards = Uint8Array.from(shuffle(ss));
    const record = { table, handNo: 1n, button: firstButton(ss, 0b11), dealtMask: 0b11, seedMask: 0b10, seeds, entropy, shuffleSeed: ss, cards, boardLen: 5, logHash: new Uint8Array(32), logLen: 0 };
    const mine = holeCards(cards, dealOrder(record.button, 0b11))[1]!;
    expect(verify(record, null, 1, seeds[1], [...mine]).ok).toBe(true);
    const bad = { ...record, cards: Uint8Array.from([cards[1]!, cards[0]!, ...cards.slice(2)]) };
    expect(verify(bad).problems).toContain("deck doesn't match the shuffle seed");
  });
});

// ---------------------------------------------------------------------------------------------- golden hand

const c = (s: string) => Card.parse(s).index;
const zeros = (n: number) => new Uint8Array(n);
const emptySeat = () => ({ player: zeros(32), reader: zeros(32), stack: 0n, deposited: 0n, sittingOut: false });
const emptyGameSeat = () => ({ status: 0, stack: 0n, currentBet: 0n, total: 0n, hasActed: false });
const emptyEntry = () => ({ committed: 0n, street: 0, seat: 0, kind: 0, pad: zeros(5) });

interface Step { seat: number; kind: number; committed: bigint; street: number }

/** "s1 bet 600000" → seat, kind, committed total; streets from the recorded heads-up betting order. */
function parseActions(actions: string[], streets: number[]): Step[] {
  const kinds: Record<string, number> = { 'small blind': PerGame.LogSmallBlind, 'big blind': PerGame.LogBigBlind, call: ActionType.Call, check: ActionType.Check, bet: ActionType.Bet, raise: ActionType.Raise, fold: ActionType.Fold };
  return actions.map((a, i) => {
    const m = /^s(\d) (.+) (\d+)$/.exec(a)!;
    return { seat: Number(m[1]), kind: kinds[m[2]!]!, committed: BigInt(m[3]!), street: streets[i]! };
  });
}

class FakeRpc {
  accounts = new Map<string, Uint8Array>();
  set(k: PublicKey, v: Uint8Array) {
    this.accounts.set(k.toBase58(), v);
  }
  async getAccount(k: PublicKey) {
    return this.accounts.get(k.toBase58()) ?? null;
  }
}

describe('PerTableSession golden replay (devnet table BPPX…, hand 5)', () => {
  const h = (replay as any).hands[0];
  it('the recording is the hand this test reproduces', () => {
    expect(h.hand).toBe(5);
    expect(h.actions.length).toBe(13);
  });

  it('emits the recorded hand: blinds, actions, streets, showdown, award', async () => {
    const tableKey = new PublicKey((replay as any).table);
    const t = new PerTableAddresses(tableKey);
    const wallets = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const session = Keypair.generate(); // our seat (0)'s table key
    const before = [BigInt(h.stacksBefore['0']), BigInt(h.stacksBefore['1'])];
    const after = [BigInt(h.stacksAfter['0']), BigInt(h.stacksAfter['1'])];
    // Heads-up, button 0: preflop SB/BB/call/raise/call, flop check/bet/call, turn check/check, river check/bet/call.
    const steps = parseActions(h.actions, [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    const boardCards = (h.showdown.board as string[]).map(c);
    const holes = [(h.showdown.seat0 as string[]).map(c), (h.showdown.seat1 as string[]).map(c)];

    // A deck that deals exactly those cards: deal order from button 0 is [1, 0].
    const order = dealOrder(0, 0b11);
    const deck = new Array<number>(52).fill(-1);
    order.forEach((s, k) => {
      deck[k] = holes[s]![0]!;
      deck[k + 2] = holes[s]![1]!;
    });
    [5, 6, 7, 9, 11].forEach((at, i) => (deck[at] = boardCards[i]!));
    const used = new Set(deck.filter((x) => x >= 0));
    let next = 0;
    for (let i = 0; i < 52; i++) if (deck[i]! < 0) { while (used.has(next)) next++; deck[i] = next++; }
    expect(board(deck, 2)).toEqual(boardCards);

    const record = (handNo: bigint) => ({
      table: tableKey.toBytes(), handNo, button: 0, dealtMask: 0b11, seedMask: 0, seeds: Array.from({ length: 9 }, () => zeros(32)),
      entropy: zeros(32), shuffleSeed: zeros(32), cards: Uint8Array.from(deck), boardLen: 5, logHash: zeros(32), logLen: steps.length,
    });
    const tableAcc = (handState: number, lastRecordHand: bigint) => perIdl.encodeAccount('Table', {
      version: 1, bump: 255, status: PerGame.StatusOpen, maxSeats: 6, seatMask: 0b11, inviteOnly: false, tableId: 1n, creator: wallets[0]!.toBytes(),
      mint: zeros(32), smallBlind: 100000n, bigBlind: 200000n, minBuyIn: 2000000n, maxBuyIn: 20000000n, rakeBps: 500, lastActivityTs: 0n,
      ledgerHash: zeros(32), ledgerSeq: 0n, handNo: 5n, handState, button: 0, dealtMask: 0b11, vrfRequestedTs: 0n, vrfNonce: 0n, shuffleStartedTs: 0n,
      turnDeadline: 2_000_000_000n, idleSince: 0n, lastCommitTs: 0n, lastRecord: record(lastRecordHand), committedLedgerSeq: 0n, committedHandNo: 0n,
      startRequestedFor: 1n, kind: 0, needsSync: 0, agentMask: 0, reserved: zeros(8),
    });
    // Ledger seat stacks are the settled (between-hands) stacks; the live ones are in the game's seats.
    const ledgerAcc = (stacks: bigint[], street: number, toAct: number, boardLen: number, live: bigint[] = stacks) => {
      const seats = Array.from({ length: 9 }, emptySeat);
      const gseats = Array.from({ length: 9 }, emptyGameSeat);
      for (const s of [0, 1]) {
        seats[s] = { player: wallets[s]!.toBytes(), reader: s === 0 ? session.publicKey.toBytes() : Keypair.generate().publicKey.toBytes(), stack: stacks[s]!, deposited: before[s]!, sittingOut: false };
        gseats[s] = { status: PerGame.Active, stack: live[s]!, currentBet: 0n, total: 0n, hasActed: false };
      }
      const b = zeros(5);
      boardCards.slice(0, boardLen).forEach((x, i) => (b[i] = x));
      return perIdl.encodeAccount('Ledger', {
        table: tableKey.toBytes(), seats, escrowOwed: 0n, rakeAccrued: 0n, escrowBalance: 0n, totalDeposited: 0n, totalPaidOut: 0n, totalRakeCollected: 0n, salt: zeros(32),
        game: { seatCount: 2, smallBlind: 100000n, bigBlind: 200000n, seats: gseats, button: 0, sbSeat: 0, bbSeat: 1, currentSeat: toAct, toAct, street, highBet: 0n, minRaise: 200000n, pot: 0n, runout: false, board: b, boardLen },
      });
    };
    const logAcc = (n: number) => {
      const entries = Array.from({ length: 512 }, emptyEntry);
      steps.slice(0, n).forEach((s, i) => (entries[i] = { committed: s.committed, street: s.street, seat: s.seat, kind: s.kind, pad: zeros(5) }));
      return perIdl.encodeAccount('HandLog', { table: tableKey.toBytes(), handNo: 5n, hash: zeros(32), secret: zeros(32), len: n, readersLen: 0, pad: zeros(3), readers: Array.from({ length: 9 }, () => zeros(32)), auditedBy: zeros(32), entries });
    };
    const handAcc = perIdl.encodeAccount('Hand', { table: tableKey.toBytes(), seat: 0, owner: wallets[0]!.toBytes(), handNo: 5n, cards: Uint8Array.from(holes[0]!), reader: session.publicKey.toBytes() });
    expect(decode.ledger(ledgerAcc(before, 1, 0, 0))!.seats[0]!.stack).toBe(before[0]);

    const rpc = new FakeRpc();
    const s = new PerTableSession(tableKey, rpc as unknown as PerRpc, rpc as unknown as PerRpc, new LocalSigner(session), wallets[0]!, () => 1_900_000_000_000);
    const events: PokerEvent[] = [];
    s.onEvent((e) => events.push(e));

    // The hand as the rollup shows it, poll by poll: each step adds one log entry; the board follows the streets.
    const boardFor = (street: number) => (street >= 4 ? 5 : street === 3 ? 4 : street === 2 ? 3 : 0);
    rpc.set(t.hand(0), handAcc);
    for (let n = 1; n <= steps.length; n++) {
      const street = steps[Math.min(n, steps.length - 1)]!.street;
      const toAct = n < steps.length ? steps[n]!.seat : PerGame.NoSeat;
      const stacks = before.map((b, seat) => b - steps.slice(0, n).filter((x) => x.seat === seat).reduce((m, x) => (x.committed > m ? x.committed : m), 0n));
      rpc.set(t.table, tableAcc(PerGame.HandPlaying, 4n));
      rpc.set(t.ledger, ledgerAcc(before, street, toAct, boardFor(street), stacks));
      rpc.set(t.log, logAcc(n));
      await s.poll();
    }
    // Showdown: the table is idle again and its public record holds hand 5; the ledger has the settled stacks.
    rpc.set(t.table, tableAcc(PerGame.HandIdle, 5n));
    rpc.set(t.ledger, ledgerAcc(after, 4, PerGame.NoSeat, 5));
    await s.poll();

    expect(s.mySeat).toBe(0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('HandStarted');
    expect(types.at(-1)).toBe('HandEnded');

    // Blinds and actions in recorded order, with the recorded committed totals.
    const acted = events.filter((e) => e.type === 'BlindPosted' || e.type === 'PlayerActed');
    expect(acted.length).toBe(13);
    acted.forEach((e, i) => {
      expect(e.seat).toBe(steps[i]!.seat);
      if (e.type === 'BlindPosted') expect(e.amount).toBe(Number(steps[i]!.committed));
    });
    // Street changes and the board, three cards then one then one.
    expect(events.filter((e) => e.type === 'BettingRoundChanged').map((e) => (e as { round: BettingRound }).round)).toEqual([BettingRound.Flop, BettingRound.Turn, BettingRound.River]);
    const dealt = events.filter((e) => e.type === 'CommunityDealt') as { newCards: Card[] }[];
    expect(dealt.map((d) => d.newCards.map((x) => x.short).join(' '))).toEqual(['Jd Qd 6h', '6c', '4h']);
    // Our own hole cards face up, the other seat's face down.
    const hole = events.filter((e) => e.type === 'HoleCardsDealt') as { seat: number; card0: Card; card1: Card }[];
    expect(hole.map((x) => x.seat).sort()).toEqual([0, 1]);
    expect(hole.find((x) => x.seat === 0)!.card0.short + hole.find((x) => x.seat === 0)!.card1.short).toBe('2cQh');
    // Showdown: both seats' recorded cards on the recorded board; seat 0 wins the recorded pot.
    const sd = events.find((e) => e.type === 'Showdown') as { entries: { seat: number; card0: Card; card1: Card }[]; board: Card[] };
    expect(sd.board.map((x) => x.short)).toEqual(h.showdown.board);
    expect(sd.entries.map((e) => [e.seat, e.card0.short, e.card1.short])).toEqual([[0, '2c', 'Qh'], [1, '3h', '3c']]);
    const awards = events.filter((e) => e.type === 'PotAwarded') as { seat: number; amount: number; stackAfter: number }[];
    expect(awards).toHaveLength(1);
    expect(awards[0]!.seat).toBe(h.winners[0]);
    expect(awards[0]!.amount).toBe(h.pot);
    expect(awards[0]!.stackAfter).toBe(Number(after[0]));
    // The session kept the record for "Verify this hand".
    expect(s.lastRecord?.handNo).toBe(5n);
    expect(s.lastMyCards).toEqual(holes[0]);
  });
});
