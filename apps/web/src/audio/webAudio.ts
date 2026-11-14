import { DEFAULT_VOLUMES, PokerSound, SFX_LIBRARY, type AudioPort } from '@nomad/engine';

/**
 * Port of PokerAudio / PokerAudioRuntime on the Web Audio API. One-shots play at
 * master × sfx × clip trim, with each clip's retrigger guard (unscaled time). Music plays the intro,
 * then the loop. Music is STREAMED through <audio> elements routed into the music gain — decoding the two
 * ~2-minute tracks would hold ~90 MB of PCM, too much on phones; the cost is a few-ms seam at the intro→loop
 * hand-off and at loop wrap on some browsers (Unity schedules them sample-accurately). The turn-timer bed starts so its last tick lands on the
 * timeout. Browsers only allow audio after a user gesture, so everything is unlocked on the first
 * pointer/key press (Unity's WebGL build has the same constraint).
 */
export class WebAudio implements AudioPort {
  private readonly ctx = new AudioContext();
  private readonly buffers = new Map<PokerSound, AudioBuffer>();
  private readonly lastPlayed = new Map<PokerSound, number>();
  private readonly masterGain: GainNode;
  private readonly sfxGain: GainNode;
  private readonly musicGain: GainNode;
  private timerSource: AudioBufferSourceNode | null = null;
  private musicStarted = false;
  /** The menu BGM (intro → loop) and each room's loop, each on its own gain so they can crossfade. */
  private readonly menuGain: GainNode;
  private menuEls: HTMLAudioElement[] = [];
  private menuPlaying: HTMLAudioElement | null = null;
  private readonly rooms = new Map<string, { el: HTMLAudioElement; gain: GainNode }>();
  /** What should be playing: null = the menu BGM, else a room key (public/assets/music/<key>.mp3). */
  private wantTrack: string | null = null;
  private activeTrack: string | null | undefined = undefined;
  private readonly fadeTimers = new Map<HTMLAudioElement, number>();

  constructor(
    private readonly base = `${import.meta.env.BASE_URL}assets/sfx/`,
    volumes = DEFAULT_VOLUMES,
  ) {
    const master = (this.masterGain = this.ctx.createGain());
    master.gain.value = volumes.master;
    master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = volumes.sfx;
    this.sfxGain.connect(master);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = volumes.music;
    this.musicGain.connect(master);
    this.menuGain = this.ctx.createGain();
    this.menuGain.gain.value = 0; // faded in by applyTrack when the menu BGM is the wanted track
    this.menuGain.connect(this.musicGain);

    const unlock = () => {
      void this.ctx.resume();
      this.startMusic();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** PokerVolumeControl: master / music / sfx levels (0..1), applied immediately. */
  setVolumes(master: number, music: number, sfx: number): void {
    this.masterGain.gain.value = master;
    this.musicGain.gain.value = music;
    this.sfxGain.gain.value = sfx;
  }

  /** Fetches and decodes every mapped clip except the music, which streams. */
  async load(): Promise<void> {
    await Promise.all(
      Object.entries(SFX_LIBRARY).map(async ([key, entry]) => {
        const sound = Number(key) as PokerSound;
        if (sound === PokerSound.MusicIntro || sound === PokerSound.MusicLoop) return;
        try {
          const res = await fetch(this.base + encodeURIComponent(entry!.file));
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(Number(key) as PokerSound, buf);
        } catch (err) {
          console.warn('[audio] could not load', entry!.file, err);
        }
      }),
    );
    if (this.ctx.state === 'running') this.startMusic(); // unlocked before the clips arrived
  }

  play(sound: PokerSound): void {
    const entry = SFX_LIBRARY[sound];
    const buf = this.buffers.get(sound);
    if (!entry || !buf || this.ctx.state !== 'running') return;
    const now = performance.now() / 1000;
    const last = this.lastPlayed.get(sound) ?? -Infinity;
    if (entry.minRetrigger > 0 && now - last < entry.minRetrigger) return;
    this.lastPlayed.set(sound, now);
    this.source(buf, entry.volume, this.sfxGain).start();
  }

  startTurnTimer(seconds: number): void {
    this.stopTurnTimer();
    const entry = SFX_LIBRARY[PokerSound.TurnTimer];
    const buf = this.buffers.get(PokerSound.TurnTimer);
    if (!entry || !buf || this.ctx.state !== 'running') return;
    const src = this.source(buf, entry.volume, this.sfxGain);
    // Longer clip: start (length - seconds) in. Shorter clip: delay its start by (seconds - length).
    if (buf.duration > seconds) src.start(0, buf.duration - seconds);
    else src.start(this.ctx.currentTime + (seconds - buf.duration));
    this.timerSource = src;
  }

  stopTurnTimer(): void {
    try {
      this.timerSource?.stop();
    } catch {
      /* already stopped */
    }
    this.timerSource = null;
  }

  private startMusic(): void {
    if (this.musicStarted) return;
    const introEntry = SFX_LIBRARY[PokerSound.MusicIntro];
    const loopEntry = SFX_LIBRARY[PokerSound.MusicLoop];
    if (!introEntry && !loopEntry) return;
    this.musicStarted = true;
    const stream = (file: string, volume: number, loop: boolean): HTMLAudioElement => {
      const el = new Audio(this.base + encodeURIComponent(file));
      el.preload = 'auto';
      el.loop = loop;
      const g = this.ctx.createGain();
      g.gain.value = volume;
      this.ctx.createMediaElementSource(el).connect(g).connect(this.menuGain);
      this.menuEls.push(el);
      return el;
    };
    const loop = loopEntry ? stream(loopEntry.file, loopEntry.volume, true) : null;
    if (introEntry) {
      const intro = stream(introEntry.file, introEntry.volume, false);
      intro.addEventListener('ended', () => {
        this.menuPlaying = loop;
        if (this.activeTrack === null) void loop?.play().catch(() => {});
      }, { once: true });
      this.menuPlaying = intro;
    } else this.menuPlaying = loop;
    this.applyTrack(true);
  }

  // ------------------------------------------------------------------------------------------- room music

  /**
   * Background music for where the player is: null = the menu BGM, or a room key ('solana', 'forest', 'town',
   * 'desert', 'neon-city') for that table's own loop (public/assets/music). Crossfades over ~1.5 s; before the first
   * user gesture it only records the choice (browsers block audio until then).
   */
  setMusicTrack(key: string | null): void {
    this.wantTrack = key;
    if (this.musicStarted) this.applyTrack(false);
  }

  private roomChannel(key: string): { el: HTMLAudioElement; gain: GainNode } {
    let ch = this.rooms.get(key);
    if (!ch) {
      const el = new Audio(`${import.meta.env.BASE_URL}assets/music/${encodeURIComponent(key)}.mp3`);
      el.preload = 'auto';
      el.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      this.ctx.createMediaElementSource(el).connect(gain).connect(this.musicGain);
      ch = { el, gain };
      this.rooms.set(key, ch);
    }
    return ch;
  }

  private applyTrack(immediate: boolean): void {
    const want = this.wantTrack;
    if (want === this.activeTrack) return;
    const fade = immediate ? 0.05 : 1.5;
    const now = this.ctx.currentTime;
    const ramp = (g: GainNode, to: number) => {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(to, now + fade);
    };
    const stopLater = (el: HTMLAudioElement) => {
      window.clearTimeout(this.fadeTimers.get(el));
      this.fadeTimers.set(el, window.setTimeout(() => el.pause(), fade * 1000 + 100));
    };
    const startNow = (el: HTMLAudioElement) => {
      window.clearTimeout(this.fadeTimers.get(el));
      void el.play().catch(() => {});
    };
    // Fade out whatever is playing.
    if (this.activeTrack === null) {
      ramp(this.menuGain, 0);
      for (const el of this.menuEls) stopLater(el);
    } else if (this.activeTrack) {
      const ch = this.rooms.get(this.activeTrack);
      if (ch) {
        ramp(ch.gain, 0);
        stopLater(ch.el);
      }
    }
    // Fade in the wanted one.
    if (want === null) {
      ramp(this.menuGain, 1);
      if (this.menuPlaying) startNow(this.menuPlaying);
    } else {
      const ch = this.roomChannel(want);
      ch.el.currentTime = 0;
      ramp(ch.gain, 1);
      startNow(ch.el);
    }
    this.activeTrack = want;
  }

  private source(buf: AudioBuffer, volume: number, out: AudioNode): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(out);
    return src;
  }
}
