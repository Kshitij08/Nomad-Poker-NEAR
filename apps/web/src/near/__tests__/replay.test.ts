// A settled testnet session (table.nomad-poker.testnet, web1-0) re-dealt with the real poker-wasm, then turned into
// table replays: every hand must add up, and the 3D replayer's event stream must build from it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReplayStep } from '@nomad/engine/agents';
import { replayToEvents } from '../../agents/replayEvents';
import { replaySettled, toAgentReplay, type WasmHand } from '../replay';
import { formatNear, parseNear, styleWords } from '../backing';
import record from './session.fixture.json';

async function wasm() {
  const bytes = readFileSync(fileURLToPath(new URL('../../../public/near/poker_wasm.wasm', import.meta.url)));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as never;
}

describe('NEAR session replay', () => {
  it('re-deals the settled session to the stacks the contract recorded', async () => {
    const out = await replaySettled(record, await wasm());
    expect(out.hands.length).toBe(record.hands);
    expect(out.stacks).toEqual(record.end_stacks);
  });

  it('turns every hand into a table replay that adds up', async () => {
    const out = await replaySettled(record, await wasm());
    const names = record.payouts!.seats.map((s) => s.agent);
    for (const h of out.hands as WasmHand[]) {
      const r = toAgentReplay(h, names, record.sb, record.bb, 0);
      const won = r.steps.filter((s) => s.type === ReplayStep.Award).reduce((a, s) => a + (s.amount ?? 0), 0);
      const pot = h.blinds.reduce((a, b) => a + b, 0) + h.steps.reduce((a, s) => a + s.put_in, 0);
      expect(won).toBe(pot);
      for (const seat of r.seats) expect(seat.endStack).toBe(h.stacks_before[seat.seat]! + h.deltas[seat.seat]!);
      expect(r.steps.filter((s) => s.type === ReplayStep.Blind).map((s) => s.action)).toEqual(['small_blind', 'big_blind']);
      const { items } = replayToEvents(r, 6);
      expect(items[0]!.event.type).toBe('HandStarted');
      expect(items.at(-1)!.event.type).toBe('HandEnded');
      expect(items.some((i) => i.event.type === 'PotAwarded')).toBe(true);
    }
  });

  it('shows the focus seat from the deal and others only at showdown', () => {
    const h: WasmHand = {
      index: 0, button: 0, stacks_before: [100, 100, 100], holes: [['As', 'Kd'], ['2c', '7h'], ['Qs', 'Qh']],
      board: ['Ts', '9s', '3d', '4c', '8h'], actions: 'fcc', deltas: [0, -1, 1], blinds: [0, 1, 2],
      steps: [{ seat: 0, act: 'f', street: 0, put_in: 0, pot: 3 }, { seat: 1, act: 'f', street: 0, put_in: 0, pot: 3 }],
    };
    const r = toAgentReplay(h, ['a', 'b', 'c'], 1, 2, 2);
    expect(r.agentCards).toEqual(['Qs', 'Qh']);
    expect(r.seats.find((s) => s.seat === 1)!.cards).toBeNull();
    expect(r.steps.at(-1)).toMatchObject({ type: 'award', seat: 2, amount: 3, description: 'Uncontested' });
  });
});

describe('NEAR amounts', () => {
  it('formats and parses yoctoNEAR', () => {
    expect(formatNear(parseNear('0.5'))).toBe('0.5');
    expect(formatNear(parseNear('12'))).toBe('12');
    expect(formatNear(0n)).toBe('0');
    expect(formatNear(-(10n ** 23n))).toBe('-0.1');
    expect(() => parseNear('abc')).toThrow();
    expect(styleWords(70, 80)).toBe('Tight, aggressive');
  });
});
