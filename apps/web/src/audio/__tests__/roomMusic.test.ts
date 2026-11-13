import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOM_MUSIC, musicTrackFor } from '../roomMusic';

describe('room music', () => {
  it('plays the menu BGM away from the table', () => {
    expect(musicTrackFor('menu', 'Desert')).toBeNull();
    expect(musicTrackFor(null, 'Forest')).toBeNull();
  });

  it("plays each room's own loop at the table", () => {
    expect(musicTrackFor('table', 'Default')).toBe('solana');
    expect(musicTrackFor('table', 'Forest')).toBe('forest');
    expect(musicTrackFor('table', 'Town')).toBe('town');
    expect(musicTrackFor('table', 'Desert')).toBe('desert');
    expect(musicTrackFor('table', 'Neon_City')).toBe('neon-city');
  });

  it('falls back to the Solana loop for an unknown room', () => {
    expect(musicTrackFor('table', 'Nope')).toBe('solana');
    expect(musicTrackFor('table', null)).toBe('solana');
  });

  it('ships one small loop file per room', () => {
    for (const key of new Set(Object.values(ROOM_MUSIC))) {
      const file = fileURLToPath(new URL(`../../../public/assets/music/${key}.mp3`, import.meta.url));
      expect(existsSync(file), key).toBe(true);
      expect(statSync(file).size).toBeLessThan(1_100_000);
    }
  });
});
