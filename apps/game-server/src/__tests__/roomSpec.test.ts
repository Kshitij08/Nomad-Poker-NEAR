import { describe, expect, it } from 'vitest';
import { canonicalSession, qaSpeed, qaStake, roomSpecFor } from '../roomSpec';

describe('room names', () => {
  it('canonicalises pools, party codes and qa rooms', () => {
    expect(canonicalSession('Poker-Free-ST50')).toBe('poker-free-st50');
    expect(canonicalSession('abcd2345')).toBe('ABCD2345');
    expect(canonicalSession('QA-Soak-1')).toBe('qa-soak-1');
    expect(canonicalSession('../etc')).toBeNull();
    expect(canonicalSession('x'.repeat(65))).toBeNull();
    // The Solana side-channel rooms (`SC-<base58>`) are gone.
    expect(canonicalSession('SC-GV5LYvyakPHtjNWENbFKnfyG2NuMLkL6xYPxo6YyEcJw')).toBeNull();
  });

  it('opens pools on demand, party rooms only once spawned, qa rooms only where enabled', () => {
    expect(roomSpecFor('poker-free-2', { spawned: false, qaRooms: false })).toMatchObject({ ok: true, spec: { kind: 'quick', child: true } });
    expect(roomSpecFor('poker-money', { spawned: false, qaRooms: false })).toMatchObject({ ok: false, reason: 'GameNotFound' });
    expect(roomSpecFor('ABCD2345', { spawned: false, qaRooms: false })).toMatchObject({ ok: false, reason: 'GameNotFound' });
    expect(roomSpecFor('ABCD2345', { spawned: true, qaRooms: false })).toMatchObject({ ok: true, spec: { kind: 'private' } });
    expect(roomSpecFor('qa-x', { spawned: false, qaRooms: false })).toMatchObject({ ok: false });
    expect(roomSpecFor('qa-x', { spawned: false, qaRooms: true })).toMatchObject({ ok: true, spec: { properties: { stake: '1000' } } });
  });

  it('reads a qa room stake suffix when it names a known tier', () => {
    expect(qaStake('qa-soak-1-st100')).toBe(100);
    expect(qaStake('qa-soak-1-st123')).toBe(1000);
    expect(qaStake('qa-soak-1')).toBe(1000);
    expect(qaStake('qa-load-a-0-x1-st100')).toBe(100);
  });

  it("a QA room's speed: the stage's, or the room's own -x<n>- (1 to 20)", () => {
    expect(qaSpeed('qa-soak-1-st100', 20)).toBe(20);
    expect(qaSpeed('qa-load-a-0-x1-st100', 20)).toBe(1);
    expect(qaSpeed('qa-load-a-0-x5', 20)).toBe(5);
    expect(qaSpeed('qa-load-a-0-x50-st100', 20)).toBe(20);
    expect(qaSpeed('qa-soak-1', 0)).toBe(1);
    expect(roomSpecFor('qa-soak-1-st50', { spawned: false, qaRooms: true })).toMatchObject({ ok: true, spec: { properties: { stake: '50' } } });
  });
});
