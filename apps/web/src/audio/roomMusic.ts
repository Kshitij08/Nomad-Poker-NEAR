/**
 * Per-room background music: each table room plays its own loop from public/assets/music (rendered by
 * tools/music/render-room-music.py); every other screen plays the menu BGM.
 */

/** Table rooms (theme ids) → their loop file key. */
export const ROOM_MUSIC: Readonly<Record<string, string>> = {
  Default: 'solana',
  Forest: 'forest',
  Town: 'town',
  Desert: 'desert',
  Neon_City: 'neon-city',
};

/** The track for a base screen: a table plays its room's loop; anything else plays the menu BGM (null). */
export function musicTrackFor(screen: string | null | undefined, theme: string | null | undefined): string | null {
  if (screen !== 'table') return null;
  return (theme && ROOM_MUSIC[theme]) || ROOM_MUSIC.Default!;
}
