/**
 * Table voice — Net/Voice/PokerTableVoice.cs + PokerVoiceLevel.cs (PokerVoiceReporter). Unity used Vivox; the web
 * port uses a WebRTC audio mesh between the table's players, signalled through the table server (`rtc` messages).
 *
 * Kept from Unity: the mute pref (`Poker.Voice.Muted`, remembered across tables), the talking detector (level ≥ 0.045
 * held 0.1 s → talking, below for 0.4 s → silent) reported to the server only on a change, mute beats talking, and
 * "a muted mic is not speech whatever the meter says". Voice is OFF by default exactly like the shipped build
 * (PokerVoiceSettings.IsEnabled = false); the net module turns it on with `?voice=1`.
 */
import { PlayerPrefs } from '../../app/services';
import type { NetConnection } from '../netConnection';

export enum VoiceLinkState {
  Idle,
  Connecting,
  Joined,
  /** The microphone was refused or WebRTC is missing. */
  Unavailable,
}

export const PokerVoiceSettings = {
  MutePref: 'Poker.Voice.Muted',
  TalkThreshold: 0.045,
  AttackSeconds: 0.1,
  ReleaseSeconds: 0.4,
};

interface PeerLink {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
}

export class TableVoice {
  private _state = VoiceLinkState.Idle;
  private stream: MediaStream | null = null;
  private readonly peers = new Map<number, PeerLink>();
  private off: (() => void)[] = [];
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private talking = false;
  private aboveSince = -1;
  private belowSince = -1;
  private reported: { talking: boolean; muted: boolean } | null = null;
  private _muted = PlayerPrefs.getInt(PokerVoiceSettings.MutePref, 0) === 1;
  readonly stateChanged = new Set<() => void>();
  /** The live mic level 0..1 (PokerVoiceLevel.Level) for a meter. */
  level = 0;

  constructor(
    private readonly conn: NetConnection,
    private readonly report: (talking: boolean, muted: boolean) => void,
  ) {}

  get state(): VoiceLinkState {
    return this._state;
  }

  get isMuted(): boolean {
    return this._muted;
  }

  get isAvailable(): boolean {
    return this._state !== VoiceLinkState.Unavailable;
  }

  get canRetry(): boolean {
    return this._state === VoiceLinkState.Unavailable;
  }

  async join(): Promise<void> {
    if (this._state === VoiceLinkState.Connecting || this._state === VoiceLinkState.Joined) return;
    this.setState(VoiceLinkState.Connecting);
    try {
      if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('WebRTC unavailable');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      console.warn('[PokerVoice] Microphone unavailable:', (e as Error)?.message ?? e);
      this.setState(VoiceLinkState.Unavailable);
      return;
    }
    this.applyMute();
    this.startMeter();
    this.off.push(
      this.conn.onMessage((m) => {
        if (m.t === 'voicePeers') for (const p of m.peers) void this.call(p);
        else if (m.t === 'voiceLeft') this.drop(m.player);
        else if (m.t === 'rtc') void this.onSignal(m.from, m.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit });
      }),
    );
    this.conn.send({ t: 'voiceJoin' });
    this.setState(VoiceLinkState.Joined);
    this.evaluate(true);
  }

  retry(): void {
    if (this.canRetry) void this.join();
  }

  toggleMute(): void {
    this._muted = !this._muted;
    PlayerPrefs.setInt(PokerVoiceSettings.MutePref, this._muted ? 1 : 0);
    this.applyMute();
    this.evaluate(true);
    for (const fn of [...this.stateChanged]) fn();
  }

  leave(): void {
    // Report the mic closed on the way out, so nobody is left showing as mid-sentence.
    if (this.talking) this.report(false, this._muted);
    for (const f of this.off.splice(0)) f();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    for (const p of [...this.peers.keys()]) this.drop(p);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    if (this.conn.isOpen) this.conn.send({ t: 'voiceLeave' });
    this.setState(VoiceLinkState.Idle);
  }

  private applyMute(): void {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !this._muted));
  }

  private link(peer: number): PeerLink {
    let l = this.peers.get(peer);
    if (l) return l;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const audio = new Audio();
    audio.autoplay = true;
    this.stream?.getTracks().forEach((t) => pc.addTrack(t, this.stream!));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.conn.send({ t: 'rtc', to: peer, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => undefined);
    };
    l = { pc, audio };
    this.peers.set(peer, l);
    return l;
  }

  /** The newcomer calls everyone already in the channel. */
  private async call(peer: number): Promise<void> {
    const { pc } = this.link(peer);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.conn.send({ t: 'rtc', to: peer, data: { sdp: pc.localDescription?.toJSON() } });
  }

  private async onSignal(from: number, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): Promise<void> {
    try {
      const { pc } = this.link(from);
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.conn.send({ t: 'rtc', to: from, data: { sdp: pc.localDescription?.toJSON() } });
        }
      } else if (data.candidate) await pc.addIceCandidate(data.candidate);
    } catch (e) {
      console.warn('[PokerVoice] Signalling failed:', (e as Error)?.message ?? e);
    }
  }

  private drop(peer: number): void {
    const l = this.peers.get(peer);
    if (!l) return;
    l.pc.close();
    l.audio.srcObject = null;
    this.peers.delete(peer);
  }

  /** PokerVoiceLevel: RMS of the mic over a ~1024-sample window, polled ~30×/s. */
  private startMeter(): void {
    if (!this.stream) return;
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
    } catch {
      return;
    }
    const buf = new Float32Array(1024);
    this.meterTimer = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      this.level = Math.sqrt(sum / buf.length);
      this.evaluate(false);
    }, 33);
  }

  /** PokerVoiceReporter.Update/Evaluate: hysteresis, mute wins, report only on change. */
  private evaluate(force: boolean): void {
    const now = performance.now() / 1000;
    if (this.level >= PokerVoiceSettings.TalkThreshold) {
      this.belowSince = -1;
      if (this.aboveSince < 0) this.aboveSince = now;
      if (!this.talking && now - this.aboveSince >= PokerVoiceSettings.AttackSeconds) this.talking = true;
    } else {
      this.aboveSince = -1;
      if (this.belowSince < 0) this.belowSince = now;
      if (this.talking && now - this.belowSince >= PokerVoiceSettings.ReleaseSeconds) this.talking = false;
    }
    const talking = !this._muted && this.talking;
    if (force || !this.reported || this.reported.talking !== talking || this.reported.muted !== this._muted) {
      this.reported = { talking, muted: this._muted };
      this.report(talking, this._muted);
    }
  }

  private setState(s: VoiceLinkState): void {
    if (this._state === s) return;
    this._state = s;
    for (const fn of [...this.stateChanged]) fn();
  }
}
