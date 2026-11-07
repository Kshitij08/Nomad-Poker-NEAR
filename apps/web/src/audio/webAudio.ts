import { DEFAULT_VOLUMES, PokerSound, SFX_LIBRARY, type AudioPort } from '../core';

/**
 * Port of PokerAudio / PokerAudioRuntime on the Web Audio API. One-shots play at
 * master × sfx × clip trim, with each clip's retrigger guard (unscaled time). Music plays the intro,
 * then the loop scheduled seamlessly after it. The turn-timer bed starts so its last tick lands on the
 * timeout. Browsers only allow audio after a user gesture, so everything is unlocked on the first
 * pointer/key press (Unity's WebGL build has the same constraint).
 */
export class WebAudio implements AudioPort {
  private readonly ctx = new AudioContext();
  private readonly buffers = new Map<PokerSound, AudioBuffer>();
  private readonly lastPlayed = new Map<PokerSound, number>();
  private readonly sfxGain: GainNode;
  private readonly musicGain: GainNode;
  private timerSource: AudioBufferSourceNode | null = null;
  private musicStarted = false;

  constructor(
    private readonly base = `${import.meta.env.BASE_URL}assets/sfx/`,
    volumes = DEFAULT_VOLUMES,
  ) {
    const master = this.ctx.createGain();
    master.gain.value = volumes.master;
    master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = volumes.sfx;
    this.sfxGain.connect(master);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = volumes.music;
    this.musicGain.connect(master);

    const unlock = () => {
      void this.ctx.resume();
      this.startMusic();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  /** Fetches and decodes every mapped clip. */
  async load(): Promise<void> {
    await Promise.all(
      Object.entries(SFX_LIBRARY).map(async ([key, entry]) => {
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
    const intro = this.buffers.get(PokerSound.MusicIntro);
    const loop = this.buffers.get(PokerSound.MusicLoop);
    if (!intro && !loop) return;
    this.musicStarted = true;
    let at = this.ctx.currentTime + 0.05;
    if (intro) {
      this.source(intro, SFX_LIBRARY[PokerSound.MusicIntro]!.volume, this.musicGain).start(at);
      at += intro.duration;
    }
    if (loop) {
      const src = this.source(loop, SFX_LIBRARY[PokerSound.MusicLoop]!.volume, this.musicGain);
      src.loop = true;
      src.start(at);
    }
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
