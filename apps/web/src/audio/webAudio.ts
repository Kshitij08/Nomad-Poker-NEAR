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
      this.ctx.createMediaElementSource(el).connect(g).connect(this.musicGain);
      return el;
    };
    const loop = loopEntry ? stream(loopEntry.file, loopEntry.volume, true) : null;
    if (introEntry) {
      const intro = stream(introEntry.file, introEntry.volume, false);
      intro.addEventListener('ended', () => void loop?.play().catch(() => {}), { once: true });
      void intro.play().catch(() => {});
    } else void loop?.play().catch(() => {});
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
