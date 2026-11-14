import { describe, expect, it, vi } from 'vitest';
import { deckCommitment, deckFromSeed, type DeckReveal } from '@nomad/engine/cards/deckCommitment';
import type { WireEvent } from '@nomad/engine/events/pokerEventCodec';
import { DeckLog, checkReveal, fetchDeckReveal, httpBase } from '../deckVerify';
import { handRow, verifyBody } from '../../net/chrome/verifyPanel';

const SESSION = 'poker-money-st50';
const seed = new Uint8Array(32).fill(7);
const seedHex = Array.from(seed, (x) => x.toString(16).padStart(2, '0')).join('');
const deck = deckFromSeed(seed);

/** A 2-player hand (seats 0 and 3) dealt to the river from `seed`, and what the server reveals after it. */
function reveal(handNumber = 4, over: Partial<DeckReveal> = {}): DeckReveal {
  return {
    tableId: SESSION,
    handNumber,
    seed: seedHex,
    commitment: deckCommitment(seed, SESSION, handNumber),
    dealt: {
      holeCards: [
        { seat: 0, cards: [deck[0]!.short, deck[1]!.short] },
        { seat: 3, cards: [deck[2]!.short, deck[3]!.short] },
      ],
      board: [5, 6, 7, 9, 11].map((i) => deck[i]!.short),
    },
    ...over,
  };
}

/** The events this client sees at seat 3. */
function handEvents(handNumber: number, commitment: string | undefined): WireEvent[] {
  return [
    { type: 'HandStarted', handNumber, buttonSeat: 0, smallBlindSeat: 0, bigBlindSeat: 3, seats: [], deckCommitment: commitment },
    { type: 'HoleCardsDealt', seat: 3, card0: deck[2]!, card1: deck[3]! },
    { type: 'CommunityDealt', round: 1, newCards: [], board: [deck[5]!, deck[6]!, deck[7]!] },
    { type: 'CommunityDealt', round: 3, newCards: [], board: [5, 6, 7, 9, 11].map((i) => deck[i]!) },
    { type: 'HandEnded', handNumber },
  ] as unknown as WireEvent[];
}

/** A fake game server: `reveals` by hand number; a hand not in it is 404 for its first `misses` fetches. */
function server(reveals: Record<number, DeckReveal>, misses = 0) {
  const urls: string[] = [];
  let left = misses;
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const n = Number(/hands\/(\d+)\/deck$/.exec(url)?.[1]);
    if (left > 0 || !reveals[n]) {
      left--;
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(reveals[n]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const noSleep = async () => {};

describe('checkReveal', () => {
  const hand = (n = 4) => ({ handNumber: n, commitment: deckCommitment(seed, SESSION, n), mySeat: 3, myCards: [deck[2]!.short, deck[3]!.short], board: [5, 6, 7, 9, 11].map((i) => deck[i]!.short), status: 'waiting' as const });

  it('accepts an honest reveal', () => {
    expect(checkReveal(hand(), reveal(), SESSION)).toEqual({ ok: true, reason: null });
  });

  it('rejects a reveal whose commitment is not the one announced before the deal', () => {
    const other = new Uint8Array(32).fill(9);
    const swapped = reveal(4, { seed: Array.from(other, (x) => x.toString(16).padStart(2, '0')).join(''), commitment: deckCommitment(other, SESSION, 4) });
    expect(checkReveal(hand(), swapped, SESSION).reason).toMatch(/not the one announced/);
  });

  it('rejects a seed that does not hash to the commitment', () => {
    const r = reveal();
    r.seed = 'ab'.repeat(32);
    expect(checkReveal(hand(), r, SESSION).reason).toMatch(/seed does not match/);
  });

  it('rejects dealt cards the seed does not deal', () => {
    const r = reveal();
    r.dealt.board = [...r.dealt.board.slice(0, 4), deck[30]!.short];
    expect(checkReveal(hand(), r, SESSION).ok).toBe(false);
  });

  it('rejects a reveal that deals me other hole cards than I got', () => {
    const h = { ...hand(), myCards: [deck[0]!.short, deck[1]!.short] };
    expect(checkReveal(h, reveal(), SESSION).reason).toMatch(/your hole cards/);
  });

  it('rejects a reveal for another table or hand', () => {
    expect(checkReveal(hand(), reveal(4, { tableId: 'poker-money-st100' }), SESSION).reason).toMatch(/for table/);
    expect(checkReveal(hand(5), reveal(4), SESSION).ok).toBe(false);
  });
});

describe('fetchDeckReveal', () => {
  it('GETs the hand from the game server, null on 404', async () => {
    const { fetchImpl, urls } = server({ 4: reveal() });
    expect((await fetchDeckReveal('https://game.example/', SESSION, 4, fetchImpl))?.seed).toBe(seedHex);
    expect(await fetchDeckReveal('https://game.example', SESSION, 5, fetchImpl)).toBeNull();
    expect(urls).toEqual(['https://game.example/v1/near-tables/poker-money-st50/hands/4/deck', 'https://game.example/v1/near-tables/poker-money-st50/hands/5/deck']);
  });

  it('turns the local ws:// server into its http address', () => {
    expect(httpBase('ws://127.0.0.1:7777')).toBe('http://127.0.0.1:7777');
    expect(httpBase('wss://x.dev/')).toBe('https://x.dev');
    expect(httpBase('https://g.workers.dev')).toBe('https://g.workers.dev');
  });
});

describe('DeckLog', () => {
  it('records the commitment at HandStarted and verifies the hand once the reveal is published', async () => {
    const { fetchImpl, urls } = server({ 4: reveal() }, 2);
    let changes = 0;
    const log = new DeckLog({ base: 'https://g', session: SESSION, fetchImpl, sleep: noSleep, onChange: () => changes++ });
    for (const e of handEvents(4, deckCommitment(seed, SESSION, 4))) log.onEvent(e, 3);
    const h = await log.check(4); // already running from HandEnded: returns it as it is
    expect(h?.myCards).toEqual([deck[2]!.short, deck[3]!.short]);
    await vi.waitFor(() => expect(log.hands[0]).toMatchObject({ handNumber: 4, status: 'verified', seed: seedHex }));
    expect(urls.length).toBe(3); // two 404s, then the reveal
    expect(changes).toBeGreaterThan(0);
    expect(handRow(log.hands[0]!)).toContain('Verified');
  });

  it('says "Does not match" when the server reveals another deck than it committed to', async () => {
    const other = new Uint8Array(32).fill(1);
    const otherHex = Array.from(other, (x) => x.toString(16).padStart(2, '0')).join('');
    const { fetchImpl } = server({ 4: reveal(4, { seed: otherHex, commitment: deckCommitment(other, SESSION, 4) }) });
    const log = new DeckLog({ base: 'https://g', session: SESSION, fetchImpl, sleep: noSleep });
    for (const e of handEvents(4, deckCommitment(seed, SESSION, 4))) log.onEvent(e, 3);
    await vi.waitFor(() => expect(log.hands[0]?.status).toBe('mismatch'));
    expect(handRow(log.hands[0]!)).toContain('Does not match');
  });

  it('keeps waiting while the reveal is not published, and checks again on demand', async () => {
    const reveals: Record<number, DeckReveal> = {};
    const { fetchImpl } = server(reveals);
    const log = new DeckLog({ base: 'https://g', session: SESSION, fetchImpl, sleep: noSleep, retryDelays: [1, 1] });
    for (const e of handEvents(4, deckCommitment(seed, SESSION, 4))) log.onEvent(e, 3);
    await vi.waitFor(() => expect(log.hands[0]?.status).toBe('waiting'));
    expect(handRow(log.hands[0]!)).toContain('Check again');
    reveals[4] = reveal();
    expect((await log.check(4, false))?.status).toBe('verified');
  });

  it('a hand without a commitment is marked as such and never fetched', () => {
    const { fetchImpl, urls } = server({});
    const log = new DeckLog({ base: 'https://g', session: SESSION, fetchImpl, sleep: noSleep });
    for (const e of handEvents(2, undefined)) log.onEvent(e, 3);
    expect(log.hands[0]?.status).toBe('none');
    expect(urls).toEqual([]);
    expect(verifyBody(log)).toContain('No commitment');
    expect(verifyBody(null)).toContain('No hands yet');
  });
});
