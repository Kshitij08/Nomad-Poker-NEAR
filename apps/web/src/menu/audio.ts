/**
 * PokerAudio's persisted volumes (Game/Audio/PokerAudio.cs, same PlayerPrefs keys) wired to ctx.audio, and a port of
 * PokerVolumeControl (Game/Audio/PokerVolumeControl.cs): binds a panel's sliders / mute toggle to those volumes,
 * finding them by name when they are not assigned.
 *
 * ctx.audio (src/audio/webAudio.ts) needs a `setVolumes(master, music, sfx)` setter for the volumes to be heard;
 * until it has one, the values are still saved and the sliders work (see README for the diff).
 */
import { PlayerPrefs } from '../app/services';
import type { AppContext } from '../app/app';
import type { UNode } from '../hud/unityUi';
import { widgetsOf, type MSlider, type MToggle } from './ui/tree';
import type { VolumeSink } from './deps';

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

const isMusic = (n: string) => n.includes('music') || n.includes('bg') || n.includes('background') || n.includes('bgm');
const isSfx = (n: string) => n.includes('sfx') || n.includes('effect') || (n.includes('sound') && !n.includes('music'));
const isMaster = (n: string) => n.includes('master') || n.includes('volume') || n.includes('audio');

/**
 * PokerVolumeControl.OnEnable on a panel: finds the master / music / sfx sliders by name (the lone unnamed slider is
 * music), shows the saved volumes, and writes them back as they move. Returns an unbind function (OnDisable).
 */
export function bindVolumeControl(panel: UNode, assigned: { master?: MSlider; music?: MSlider; sfx?: MSlider; sound?: MToggle } = {}): () => void {
  let { master: m, music: mu, sfx: s } = assigned;
  const sliders: [UNode, MSlider][] = [];
  for (const n of panel.walk()) {
    const sl = widgetsOf(n).slider;
    if (sl) sliders.push([n, sl]);
  }
  for (const [n, sl] of sliders) {
    const name = n.name.toLowerCase();
    if (!mu && isMusic(name)) mu = sl;
    else if (!s && isSfx(name)) s = sl;
    else if (!m && isMaster(name)) m = sl;
  }
  if (!mu && !s) {
    const rest = sliders.filter(([, sl]) => sl !== m);
    if (rest.length === 1) {
      mu = rest[0]![1];
      if (m === mu) m = undefined;
    }
  }
  for (const [n, sl] of sliders) {
    if (mu && s) break;
    if (sl === mu || sl === s || sl === m) continue;
    const name = n.name.toLowerCase();
    if (isMaster(name) && !isMusic(name) && !isSfx(name)) continue;
    if (!mu && !isSfx(name)) mu = sl;
    else if (!s && !isMusic(name)) s = sl;
  }
  const denorm = (sl: MSlider, v: number) => sl.min + (sl.max - sl.min) * Math.max(0, Math.min(1, v));
  const norm = (sl: MSlider, v: number) => (sl.max - sl.min <= 0 ? Math.max(0, Math.min(1, v)) : Math.max(0, Math.min(1, (v - sl.min) / (sl.max - sl.min))));
  m?.setValueWithoutNotify(denorm(m, PokerAudio.masterVolume));
  mu?.setValueWithoutNotify(denorm(mu, PokerAudio.musicVolume));
  s?.setValueWithoutNotify(denorm(s, PokerAudio.sfxVolume));
  assigned.sound?.setIsOnWithoutNotify(!PokerAudio.muted);
  const offs: (() => void)[] = [];
  const listen = <T>(arr: ((v: T) => void)[], fn: (v: T) => void) => {
    arr.push(fn);
    offs.push(() => arr.splice(arr.indexOf(fn), 1));
  };
  if (m) listen(m.listeners, (v) => {
    PokerAudio.masterVolume = norm(m!, v);
    assigned.sound?.setIsOnWithoutNotify(!PokerAudio.muted);
  });
  if (mu) listen(mu.listeners, (v) => (PokerAudio.musicVolume = norm(mu!, v)));
  if (s) listen(s.listeners, (v) => (PokerAudio.sfxVolume = norm(s!, v)));
  if (assigned.sound) listen(assigned.sound.listeners, (on) => {
    PokerAudio.muted = !on;
    m?.setValueWithoutNotify(denorm(m, PokerAudio.masterVolume));
  });
  return () => offs.forEach((f) => f());
}
