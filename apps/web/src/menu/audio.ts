/**
 * PokerAudio's persisted volumes (Game/Audio/PokerAudio.cs, same PlayerPrefs keys) wired to ctx.audio (its
 * `setVolumes(master, music, sfx)`), and the room music that follows the table's theme.
 */
import { PlayerPrefs } from '../app/services';
import type { AppContext } from '../app/app';
import type { VolumeSink } from './deps';
import { musicTrackFor } from '../audio/roomMusic';

const MASTER_KEY = 'poker.audio.master';
const MUSIC_KEY = 'poker.audio.music';
const SFX_KEY = 'poker.audio.sfx';

let master = -1;
let music = -1;
let sfx = -1;
let sink: Partial<VolumeSink> | null = null;

function ensureLoaded(): void {
  if (master >= 0) return;
  master = PlayerPrefs.getFloat(MASTER_KEY, 1);
  music = PlayerPrefs.getFloat(MUSIC_KEY, 0.6);
  sfx = PlayerPrefs.getFloat(SFX_KEY, 0.6);
}

function apply(): void {
  ensureLoaded();
  sink?.setVolumes?.(master, music, sfx);
}

function setVolume(key: string, current: number, value: number): number {
  ensureLoaded();
  const v = Math.max(0, Math.min(1, value));
  if (Math.abs(current - v) < 1e-6) return current;
  PlayerPrefs.setFloat(key, v);
  return v;
}

export const PokerAudio = {
  /** Connects the persisted volumes to the app's audio (once, from the menu's install). */
  attach(ctx: AppContext): void {
    sink = ctx.audio as unknown as Partial<VolumeSink>;
    apply();
    followRoomMusic(ctx);
  },
  get masterVolume(): number {
    ensureLoaded();
    return master;
  },
  set masterVolume(v: number) {
    master = setVolume(MASTER_KEY, PokerAudio.masterVolume, v);
    apply();
  },
  get musicVolume(): number {
    ensureLoaded();
    return music;
  },
  set musicVolume(v: number) {
    music = setVolume(MUSIC_KEY, PokerAudio.musicVolume, v);
    apply();
  },
  get sfxVolume(): number {
    ensureLoaded();
    return sfx;
  },
  set sfxVolume(v: number) {
    sfx = setVolume(SFX_KEY, PokerAudio.sfxVolume, v);
    apply();
  },
  /** Silences everything without losing the chosen level (backed by the master volume). */
  get muted(): boolean {
    return PokerAudio.masterVolume <= 0;
  },
  set muted(on: boolean) {
    PokerAudio.masterVolume = on ? 0 : 1;
  },
};

/** Switches the background music when the table opens / closes or its room theme changes. */
function followRoomMusic(ctx: AppContext): void {
  const audio = ctx.audio as unknown as { setMusicTrack?: (key: string | null) => void };
  if (!audio.setMusicTrack) return;
  // The base screen (the table or the menu), not an overlay pushed on top of it (level-up, a panel…).
  let base: string | null = null;
  const update = () => {
    const router = ctx.router as unknown as { current?: string | null; depth?: number };
    if ((router.depth ?? 1) <= 1) base = router.current ?? null;
    const theme = (ctx.services as unknown as { theme?: { current?: string } }).theme?.current ?? null;
    audio.setMusicTrack!(musicTrackFor(base, theme));
  };
  ctx.events.on('router:changed', update);
  ctx.events.on('theme:changed', update);
  update();
}
