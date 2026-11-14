import { describe, expect, it } from 'vitest';
import { deckCommitment, verifyDeck, type DeckReveal } from '@nomad/engine/cards/deckCommitment';
import type { SettledHand } from '@nomad/table-server/pokerServerGame';
import { gunzip, HandRecorder, type RecordedHand } from '../handRecorder';

async function record(hands: SettledHand[]): Promise<RecordedHand[]> {
  const r2 = new Map<string, Uint8Array>();
  const rec = new HandRecorder('room', async (key, body) => void r2.set(key, body), () => {}, 10);
  for (const h of hands) {
    rec.event(0, new Uint8Array([1, 2, 3]));
    rec.settled(h, Date.UTC(2026, 10, 15));
  }
  await rec.flush();
  const [body] = [...r2.values()];
  return (await gunzip(body!)).trim().split('\n').map((l) => JSON.parse(l) as RecordedHand);
}

const base: SettledHand = { tableId: 't-1', handNumber: 1, botDelta: 0, humanDelta: 0, agentDelta: 0, stacks: [] };

describe('HandRecorder', () => {
  it("puts a committed hand's seed reveal into the R2 record", async () => {
    const seed = '07'.repeat(32);
    const deck: DeckReveal = {
      tableId: 't-1',
      handNumber: 1,
      seed,
      commitment: deckCommitment(seed, 't-1', 1),
      // Seat 0 and seat 2 dealt in; the board was never dealt (everyone folded preflop): only the commitment matters.
      dealt: { holeCards: [{ seat: 0 }, { seat: 2 }], board: [] },
    };
    const [rec] = await record([{ ...base, deck }]);
    expect(rec!.deck).toEqual(deck);
    expect(verifyDeck(rec!.deck!).ok).toBe(true);
  });

  it('records ordinary hands exactly as before (no deck field)', async () => {
    const [rec] = await record([base]);
    expect('deck' in rec!).toBe(false);
    expect(rec!.events).toHaveLength(1);
  });
});
