#!/usr/bin/env python3
"""
Renders one seamless background-music loop per table room (Solana, Forest, Town, Desert, Neon City) into
public/assets/music/<room>.mp3. Everything is synthesised here from scratch (no samples, no downloads):
additive / subtractive instruments, synthesised drums, procedural ambience, a circular (wrap-around) reverb so
the loop seams are sample-continuous, then loudness-matched to the menu BGM with ffmpeg.

  python tools/music/render-room-music.py            # all rooms
  python tools/music/render-room-music.py desert     # one room

Needs: numpy (tested 2.5.4) and ffmpeg (libmp3lame) on PATH. Deterministic: same input, same output.
"""
import os
import subprocess
import sys
import wave

import numpy as np

SR = 32000
TARGET_LUFS = -15.0  # menu BGM measures -13.8 LUFS; tables sit a touch under it
ROOM_LUFS = {'forest': -17.0}  # the forest loop sits further in the background
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'music')
NOTE_INDEX = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7,
              'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}


def hz(note):
    """'A4' → 440."""
    name, octave = note[:-1], int(note[-1])
    midi = 12 * (octave + 1) + NOTE_INDEX[name]
    return 440.0 * 2 ** ((midi - 69) / 12)


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def nmidi(note):
    name, octave = note[:-1], int(note[-1])
    return 12 * (octave + 1) + NOTE_INDEX[name]


# ----------------------------------------------------------------------------------------------- building blocks

class Track:
    """A stereo loop buffer. Notes past the end wrap to the start, so the loop is seamless."""

    def __init__(self, seconds):
        self.n = int(round(seconds * SR))
        self.buf = np.zeros((2, self.n))

    def _mix(self, ch, sig, start):
        """Adds sig at start, wrapping the part past the end of the loop to its beginning."""
        n = self.n
        pos = start
        i = 0
        while i < sig.size:
            take = min(sig.size - i, n - pos)
            self.buf[ch, pos:pos + take] += sig[i:i + take]
            i += take
            pos = 0

    def add(self, sig, start_s, gain=1.0, pan=0.0):
        if sig.size == 0:
            return
        start = int(round(start_s * SR)) % self.n
        l = gain * np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
        r = gain * np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
        self._mix(0, sig * l, start)
        self._mix(1, sig * r, start)

    def add_stereo(self, sig2, start_s=0.0, gain=1.0):
        start = int(round(start_s * SR)) % self.n
        self._mix(0, sig2[0] * gain, start)
        self._mix(1, sig2[1] * gain, start)


def t_axis(n):
    return np.arange(n) / SR


def env(n, a=0.005, d=0.1, s=0.7, r=0.2, hold=None):
    """ADSR over n samples; `hold` = sustain length (s) before release, default fills the note."""
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    total = n
    hold_n = total - a_n - d_n - r_n if hold is None else int(hold * SR)
    hold_n = max(hold_n, 0)
    e = np.concatenate([
        np.linspace(0, 1, max(a_n, 1), endpoint=False),
        np.linspace(1, s, max(d_n, 1), endpoint=False),
        np.full(hold_n, s),
        np.linspace(s, 0, max(r_n, 1)),
    ])
    if e.size < total:
        e = np.concatenate([e, np.zeros(total - e.size)])
    return e[:total]


def fft_filter(x, kind='low', fc=1000.0, order=2, q_width=0.6):
    """Zero-phase filter in the frequency domain (fine for rendered notes)."""
    if x.size < 8:
        return x
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(x.size, 1 / SR)
    f[0] = 1e-6
    if kind == 'low':
        h = 1 / np.sqrt(1 + (f / fc) ** (2 * order))
    elif kind == 'high':
        h = 1 / np.sqrt(1 + (fc / f) ** (2 * order))
    else:  # band
        h = np.exp(-0.5 * (np.log2(f / fc) / q_width) ** 2)
    return np.fft.irfft(X * h, n=x.size)


def saw(f, n, detune_cents=0.0, phase=0.0):
    t = t_axis(n)
    ff = f * 2 ** (detune_cents / 1200)
    return 2 * ((t * ff + phase) % 1.0) - 1


def square(f, n, duty=0.5):
    t = t_axis(n)
    return np.where((t * f) % 1.0 < duty, 1.0, -1.0)


def tri(f, n):
    t = t_axis(n)
    return 2 * np.abs(2 * ((t * f) % 1.0) - 1) - 1


def additive(f, dur, partials, decay=1.0, attack=0.003, vib=0.0, vib_rate=5.0):
    """partials: [(ratio, amp, decay_scale)]; exponential decay per partial (plucked / struck tones)."""
    n = int(dur * SR)
    t = t_axis(n)
    out = np.zeros(n)
    pitch = 2 * np.pi * f * (t + (vib / (2 * np.pi * vib_rate)) * np.sin(2 * np.pi * vib_rate * t) if vib else t)
    for ratio, amp, dscale in partials:
        if f * ratio > SR / 2.2:
            continue
        out += amp * np.sin(pitch * ratio) * np.exp(-t * decay * dscale)
    a = int(attack * SR)
    if a > 1:
        out[:a] *= np.linspace(0, 1, a)
    fade = min(int(0.02 * SR), n)
    out[-fade:] *= np.linspace(1, 0, fade)
    return out


def noise(n, rng):
    return rng.uniform(-1, 1, n)


# ----------------------------------------------------------------------------------------------------- instruments

def pluck(f, dur, bright=1.0):
    parts = [(k, (1 / k) ** (1.2 - 0.4 * bright), 0.8 + 0.55 * k) for k in range(1, 14)]
    return additive(f, dur, parts, decay=2.6)


def epiano(f, dur):
    # Rhodes-like: fundamental + bell partials, slow decay, tremolo applied by caller.
    parts = [(1, 1.0, 1.0), (2, 0.35, 1.6), (3, 0.12, 2.2), (4.0, 0.08, 3.0), (7.03, 0.05, 6.0), (13.1, 0.02, 9.0)]
    return additive(f, dur, parts, decay=1.4, attack=0.004)


def marimba(f, dur):
    parts = [(1, 1.0, 1.0), (3.93, 0.35, 3.5), (9.0, 0.08, 7.0)]
    return additive(f, dur, parts, decay=4.0, attack=0.002)


def handpan(f, dur):
    # Tuned steel: fundamental, octave, compound fifth, slightly inharmonic shimmer.
    parts = [(1, 1.0, 1.0), (2.0, 0.55, 1.3), (3.01, 0.3, 1.8), (4.03, 0.12, 2.6), (5.4, 0.05, 4.0)]
    sig = additive(f, dur, parts, decay=1.1, attack=0.004)
    t = t_axis(sig.size)
    return sig * (1 + 0.06 * np.sin(2 * np.pi * 4.8 * t))  # gentle beating


def bell(f, dur):
    parts = [(1, 1.0, 1.0), (2.76, 0.5, 1.7), (5.4, 0.25, 2.8), (8.93, 0.1, 4.0)]
    return additive(f, dur, parts, decay=1.2, attack=0.002)


def flute(f, dur, rng):
    n = int(dur * SR)
    t = t_axis(n)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 0.4, 0, 1)
    ph = 2 * np.pi * f * np.cumsum(vib) / SR
    sig = np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.06 * np.sin(3 * ph)
    breath = fft_filter(noise(n, rng), 'band', fc=f * 2, q_width=0.4) * 0.12
    return (sig + breath) * env(n, a=0.09, d=0.15, s=0.85, r=0.18)


def pad(freqs, dur, cutoff=1400.0, detune=12.0, attack=0.6, release=0.8, kind='saw'):
    n = int(dur * SR)
    out = np.zeros(n)
    for f in freqs:
        for dc, ph in ((-detune, 0.0), (0.0, 0.33), (detune, 0.71)):
            if kind == 'saw':
                out += saw(f, n, dc, ph)
            else:
                out += tri(f * 2 ** (dc / 1200), n)
    out = fft_filter(out / (3 * len(freqs)), 'low', fc=cutoff, order=2)
    return out * env(n, a=attack, d=0.3, s=0.85, r=release)


def sub_bass(f, dur, drive=0.0, cutoff=500.0):
    n = int(dur * SR)
    sig = np.sin(2 * np.pi * f * t_axis(n)) + 0.35 * square(f, n, 0.5)
    sig = fft_filter(sig, 'low', fc=cutoff, order=3)
    if drive:
        sig = np.tanh(sig * (1 + drive)) / np.tanh(1 + drive)
    return sig * env(n, a=0.006, d=0.12, s=0.75, r=0.06)


def upright_bass(f, dur):
    parts = [(1, 1.0, 1.0), (2, 0.45, 1.6), (3, 0.2, 2.4), (4, 0.08, 3.4)]
    sig = additive(f, dur, parts, decay=2.2, attack=0.008)
    return fft_filter(sig, 'low', fc=900)


def kick(rng, dur=0.45, f0=150.0, f1=45.0, punch=1.0):
    n = int(dur * SR)
    t = t_axis(n)
    freq = f1 + (f0 - f1) * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(freq) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = fft_filter(noise(n, rng), 'high', fc=2500) * np.exp(-t * 180) * 0.3 * punch
    return np.tanh((body + click) * 1.4)


def snare(rng, dur=0.3, tone=185.0, snappy=1.0):
    n = int(dur * SR)
    t = t_axis(n)
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t * 22)
    nz = fft_filter(noise(n, rng), 'band', fc=3200, q_width=1.4) * np.exp(-t * 16) * snappy
    return body * 0.6 + nz


def clap(rng, dur=0.3):
    n = int(dur * SR)
    t = t_axis(n)
    nz = fft_filter(noise(n, rng), 'band', fc=1400, q_width=0.9)
    e = np.zeros(n)
    for off in (0.0, 0.011, 0.022):
        o = int(off * SR)
        e[o:] += np.exp(-(t[: n - o]) * 70)
    e += 0.4 * np.exp(-t * 14)
    return nz * e


def hat(rng, dur=0.08, open_=False):
    n = int((0.35 if open_ else dur) * SR)
    t = t_axis(n)
    nz = fft_filter(noise(n, rng), 'high', fc=7500, order=3)
    return nz * np.exp(-t * (9 if open_ else 55))


def shaker(rng, dur=0.12):
    n = int(dur * SR)
    t = t_axis(n)
    nz = fft_filter(noise(n, rng), 'band', fc=6000, q_width=0.8)
    return nz * np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2


def frame_drum(rng, dur=0.5, f=95.0):
    n = int(dur * SR)
    t = t_axis(n)
    body = np.sin(2 * np.pi * f * t * (1 + 0.3 * np.exp(-t * 30))) * np.exp(-t * 6)
    skin = fft_filter(noise(n, rng), 'band', fc=700, q_width=1.0) * np.exp(-t * 25) * 0.4
    return body + skin


def rim(rng):
    n = int(0.06 * SR)
    t = t_axis(n)
    return (np.sin(2 * np.pi * 1700 * t) + 0.5 * np.sin(2 * np.pi * 820 * t)) * np.exp(-t * 90)


# ----------------------------------------------------------------------------------------------------- effects

def reverb_ir(seconds, rng, damp=6000.0, predelay=0.012):
    n = int(seconds * SR)
    t = t_axis(n)
    ir = np.zeros((2, n))
    for ch in range(2):
        nz = noise(n, rng) * np.exp(-t * (6.9 / seconds))
        ir[ch] = fft_filter(nz, 'low', fc=damp)
    pd = int(predelay * SR)
    ir = np.concatenate([np.zeros((2, pd)), ir[:, : n - pd]], axis=1)
    return ir / np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))


def circular_conv(x, ir):
    """Wrap-around convolution: the reverb tail of the end of the loop lands at its start (seamless)."""
    n = x.size
    irp = np.zeros(n)
    irp[: min(ir.size, n)] = ir[:n]
    return np.fft.irfft(np.fft.rfft(x) * np.fft.rfft(irp), n=n)


def add_reverb(track_buf, ir, wet):
    out = track_buf.copy()
    for ch in range(2):
        out[ch] += wet * circular_conv(track_buf[ch], ir[ch])
    return out


def delay(track_buf, seconds, feedback, mix, pingpong=True):
    n = track_buf.shape[1]
    d = int(seconds * SR)
    out = track_buf.copy()
    gain = mix
    for k in range(1, 7):
        shifted = np.roll(track_buf, d * k, axis=1)
        if pingpong and k % 2 == 1:
            shifted = shifted[::-1]
        out += shifted * gain
        gain *= feedback
    return out


def tremolo(sig, rate, depth):
    t = t_axis(sig.size)
    return sig * (1 - depth / 2 + depth / 2 * np.sin(2 * np.pi * rate * t))


# ----------------------------------------------------------------------------------------------------- rooms

def beats_to_s(b, bpm):
    return b * 60.0 / bpm


def chord_notes(root_midi, quality):
    shapes = {'maj': [0, 4, 7], 'min': [0, 3, 7], 'maj7': [0, 4, 7, 11], 'min7': [0, 3, 7, 10], 'dom7': [0, 4, 7, 10],
              'min9': [0, 3, 7, 10, 14], 'maj9': [0, 4, 7, 11, 14], 'sus2': [0, 2, 7], 'sus4': [0, 5, 7]}
    return [root_midi + i for i in shapes[quality]]


def solana(rng):
    """Synthwave: driving 8th bass, gated pads, 16th arpeggio, big gated snare."""
    bpm, bars = 100, 40
    tr = Track(beats_to_s(bars * 4, bpm))
    drums = Track(tr.n / SR)
    prog = [('A2', 'min'), ('F2', 'maj'), ('C3', 'maj'), ('G2', 'maj')]
    for bar in range(bars):
        root, q = prog[bar % 4]
        rm = nmidi(root)
        notes = chord_notes(rm + 12, q)
        bar_s = beats_to_s(bar * 4, bpm)
        tr.add(pad([midi_hz(m) for m in notes], beats_to_s(4, bpm) + 0.6, cutoff=1800 + 600 * (bar % 8 > 3), attack=0.25,
                   release=0.6), bar_s, gain=0.22, pan=0.0)
        for e8 in range(8):
            tr.add(sub_bass(midi_hz(rm - 12 + (12 if e8 % 4 == 3 else 0)), beats_to_s(0.45, bpm), drive=0.6, cutoff=700),
                   bar_s + beats_to_s(e8 * 0.5, bpm), gain=0.42)
        if bar >= 4:
            arp = notes + [notes[1] + 12]
            for s16 in range(16):
                m = arp[(s16 * 3 + bar) % len(arp)] + 12
                n = int(beats_to_s(0.25, bpm) * SR * 0.9)
                sig = fft_filter(saw(midi_hz(m), n) + saw(midi_hz(m), n, 9), 'low', fc=2600) * env(n, 0.002, 0.08, 0.3, 0.05)
                tr.add(sig, bar_s + beats_to_s(s16 * 0.25, bpm), gain=0.07, pan=0.35 if s16 % 2 else -0.35)
        for b in range(4):
            drums.add(kick(rng, f0=130, f1=48), bar_s + beats_to_s(b, bpm), gain=0.85)
            if b in (1, 3):
                drums.add(snare(rng, 0.35, 200, 1.2), bar_s + beats_to_s(b, bpm), gain=0.5)
            for h in (0.5,):
                drums.add(hat(rng), bar_s + beats_to_s(b + h, bpm), gain=0.16, pan=0.25)
        if bar % 8 == 7:
            for k in range(4):
                drums.add(snare(rng, 0.2, 230), bar_s + beats_to_s(3 + k * 0.25, bpm), gain=0.22 + 0.06 * k)
        # lead hook in the B section
        if 16 <= bar < 32 and bar % 2 == 0:
            hook = [76, 74, 72, 74, 76, 79, 76, 74]
            for i, m in enumerate(hook):
                n = int(beats_to_s(0.9, bpm) * SR)
                sig = fft_filter(square(midi_hz(m - 12), n, 0.3) * 0.6 + saw(midi_hz(m - 12), n, 6) * 0.4,
                                 'low', fc=2200) * env(n, 0.01, 0.1, 0.7, 0.2)
                tr.add(sig, bar_s + beats_to_s(i, bpm), gain=0.08, pan=-0.1)
    ir = reverb_ir(2.4, rng, damp=5000)
    mix = add_reverb(tr.buf, ir, 0.35) + add_reverb(drums.buf, ir, 0.18)
    return delay(mix, beats_to_s(0.75, bpm), 0.35, 0.12)


def forest(rng):
    """Calm acoustic, kept mellow: soft low fingerpicked plucks, breathy flute, shaker, wind, distant birds."""
    bpm, bars = 78, 28
    tr = Track(beats_to_s(bars * 4, bpm))
    prog = [('D3', 'maj9'), ('B2', 'min7'), ('G2', 'maj7'), ('A2', 'sus4')]
    pattern = [0, 2, 1, 3, 2, 4, 3, 1]
    melody = [74, 76, 78, 81, 78, 76, 74, None, 73, 74, 76, 78, 76, 74, 71, None]
    for bar in range(bars):
        root, q = prog[bar % 4]
        rm = nmidi(root)
        notes = chord_notes(rm, q)
        bar_s = beats_to_s(bar * 4, bpm)
        tr.add(fft_filter(pluck(midi_hz(rm - 12), 2.4, 0.4), 'low', fc=900), bar_s, gain=0.30, pan=-0.05)
        for i, idx in enumerate(pattern):
            # The picked strings stay in the guitar's middle register and dark (no glassy upper partials).
            m = notes[idx % len(notes)]
            if m < nmidi('A2'):
                m += 12
            g = fft_filter(pluck(midi_hz(m), 1.8, 0.35), 'low', fc=1800, order=2)
            tr.add(g, bar_s + beats_to_s(i * 0.5, bpm) + rng.uniform(0, 0.008), gain=0.12, pan=-0.3 + 0.6 * (i % 2))
        tr.add(pad([midi_hz(m) for m in notes[:3]], beats_to_s(4, bpm) + 1.0, cutoff=800, kind='tri', attack=1.2,
                   release=1.2), bar_s, gain=0.11)
        if bar >= 8 and bar < 24:
            for i in range(4):
                m = melody[((bar - 8) * 4 + i) % len(melody)]
                if m is not None and (bar + i) % 3 != 2:
                    # An octave below the old line: a low, breathy flute instead of a piercing one.
                    fl = fft_filter(flute(midi_hz(m - 12), beats_to_s(0.95, bpm), rng), 'low', fc=1600)
                    tr.add(fl, bar_s + beats_to_s(i, bpm), gain=0.11, pan=0.2)
        for b in range(8):
            sh = fft_filter(shaker(rng), 'low', fc=5000)
            tr.add(sh, bar_s + beats_to_s(b * 0.5, bpm), gain=0.03 if b % 2 else 0.045, pan=0.4)
    # Ambience: a wind bed and a few distant, low birds (no crickets: their 4 kHz chirp grated).
    wind = fft_filter(noise(tr.n, rng), 'band', fc=420, q_width=1.2)
    wind *= 0.5 + 0.5 * np.sin(2 * np.pi * np.arange(tr.n) / tr.n * 3)  # whole-number cycles keep the loop seamless
    tr.add(wind, 0, gain=0.035)
    t_loop = tr.n / SR
    for k in range(6):
        start = rng.uniform(0, t_loop)
        for chirp in range(int(rng.integers(2, 4))):
            n = int(0.14 * SR)
            t = t_axis(n)
            f = 1500 + 400 * np.sin(np.pi * t / 0.14) + rng.uniform(-100, 100)
            sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / 0.14) ** 2
            tr.add(sig, start + chirp * 0.18, gain=0.010, pan=rng.uniform(-0.7, 0.7))
    ir = reverb_ir(3.0, rng, damp=3500)
    mix = add_reverb(tr.buf, ir, 0.4)
    return np.array([fft_filter(mix[0], 'low', fc=4500, order=2), fft_filter(mix[1], 'low', fc=4500, order=2)])


def town(rng):
    """Lo-fi jazz hop: Rhodes 7ths, upright bass walk, swung boom-bap, vinyl crackle."""
    bpm, bars = 84, 32
    tr = Track(beats_to_s(bars * 4, bpm))
    prog = [('D3', 'min9'), ('G2', 'dom7'), ('C3', 'maj9'), ('A2', 'min7')]
    swing = 0.62

    def sw(beat):
        whole = int(beat)
        frac = beat - whole
        return whole + (swing if abs(frac - 0.5) < 1e-6 else frac)

    for bar in range(bars):
        root, q = prog[bar % 4]
        rm = nmidi(root)
        notes = chord_notes(rm + 12, q)
        bar_s = beats_to_s(bar * 4, bpm)
        for hit in ((0.0, 1.4), (1.5, 0.9), (2.5, 1.3)):
            ch = sum(epiano(midi_hz(m), 2.0) for m in notes)
            tr.add(tremolo(ch, 4.5, 0.25), bar_s + beats_to_s(sw(hit[0]), bpm), gain=0.06 * hit[1], pan=-0.15)
        walk = [rm - 12, rm - 12 + 7, rm - 12 + 10, rm - 12 + 12 - 1]
        for b in range(4):
            tr.add(upright_bass(midi_hz(walk[b]), beats_to_s(0.95, bpm)), bar_s + beats_to_s(b, bpm), gain=0.33)
        tr.add(kick(rng, 0.35, 120, 50, 0.5), bar_s + beats_to_s(0, bpm), gain=0.6)
        tr.add(kick(rng, 0.35, 120, 50, 0.5), bar_s + beats_to_s(sw(2.5), bpm), gain=0.45)
        for b in (1, 3):
            tr.add(fft_filter(snare(rng, 0.3, 190, 0.8), 'low', fc=5000), bar_s + beats_to_s(b, bpm), gain=0.32)
        for e in range(8):
            tr.add(hat(rng, 0.05), bar_s + beats_to_s(sw(e * 0.5), bpm), gain=0.05 if e % 2 else 0.08, pan=0.3)
        if bar % 4 == 3:
            tr.add(rim(rng), bar_s + beats_to_s(sw(3.5), bpm), gain=0.12, pan=0.2)
        if 8 <= bar < 24 and bar % 2 == 0:
            lick = [notes[2] + 12, notes[3] + 12, notes[1] + 12, notes[0] + 12]
            for i, m in enumerate(lick):
                tr.add(epiano(midi_hz(m), 1.2), bar_s + beats_to_s(sw(2 + i * 0.5), bpm), gain=0.07, pan=0.25)
    crackle = np.zeros(tr.n)
    pops = rng.integers(0, tr.n, int(tr.n / SR * 18))
    crackle[pops] = rng.uniform(-1, 1, pops.size)
    crackle = fft_filter(crackle, 'band', fc=3000, q_width=1.5) + fft_filter(noise(tr.n, rng), 'band', fc=6000, q_width=1.0) * 0.08
    tr.add(crackle, 0, gain=0.05)
    mix = add_reverb(tr.buf, reverb_ir(1.6, rng, damp=3500), 0.25)
    for ch in range(2):  # lo-fi tone
        mix[ch] = fft_filter(mix[ch], 'low', fc=7000)
    return mix


def clop(rng, f=950.0):
    """A hoof clop / coconut-shell knock: a hollow wooden tone with a short noise click."""
    n = int(0.09 * SR)
    t = t_axis(n)
    tone = (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 1.52 * t)) * np.exp(-t * 55)
    click = fft_filter(noise(n, rng), 'band', fc=f * 1.8, q_width=0.7) * np.exp(-t * 120) * 0.5
    return tone + click


def strum(freqs, dur, rng, down=True, bright=0.6, spread=0.014):
    """An acoustic strum: each string a pluck, a few ms apart (low to high on a downstroke)."""
    order = freqs if down else freqs[::-1]
    n = int((dur + spread * len(freqs)) * SR)
    out = np.zeros(n)
    for k, f in enumerate(order):
        g = pluck(f, dur, bright)
        o = int((k * spread + rng.uniform(0, 0.003)) * SR)
        take = min(g.size, n - o)
        out[o:o + take] += g[:take]
    return fft_filter(out / len(freqs), 'low', fc=3200) * env(n, a=0.002, d=0.05, s=0.9, r=0.05)


def whistle(f, dur):
    """A whistled note (the spaghetti-western lead): near-pure tone, a vibrato that grows, soft attack."""
    n = int(dur * SR)
    t = t_axis(n)
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.35, 0, 1)
    ph = 2 * np.pi * f * np.cumsum(vib) / SR
    sig = np.sin(ph) + 0.04 * np.sin(2 * ph)
    return sig * env(n, a=0.06, d=0.1, s=0.8, r=0.15)


def desert(rng):
    """Cowboy western: boom-chick bass and strummed acoustic, a clip-clop gallop, a tremolo twang lead and a whistled
    tune over Em - D - C - B7 (the classic trail-ride cadence) at a loping 100 BPM."""
    bpm, bars = 100, 32
    tr = Track(beats_to_s(bars * 4, bpm))
    chords = [
        ([52, 59, 64, 67, 71], (40, 35)),  # Em: E B e g b / bass E, B
        ([50, 57, 62, 66, 69], (38, 33)),  # D
        ([48, 55, 60, 64, 67], (36, 31)),  # C
        ([47, 51, 57, 59, 66], (35, 30)),  # B7
    ]
    # Eight bars of tune: (beat, midi, beats).
    tune = [
        [(0, 64, 1.5), (1.5, 67, 0.5), (2, 71, 2)],
        [(0, 69, 1), (1, 67, 1), (2, 66, 2)],
        [(0, 64, 1.5), (1.5, 67, 0.5), (2, 72, 1), (3, 71, 1)],
        [(0, 71, 3), (3, 66, 1)],
        [(0, 76, 1.5), (1.5, 74, 0.5), (2, 71, 2)],
        [(0, 69, 1), (1, 71, 1), (2, 74, 2)],
        [(0, 72, 1), (1, 71, 1), (2, 69, 1), (3, 67, 1)],
        [(0, 66, 2), (2, 63, 1), (3, 66, 1)],
    ]
    for bar in range(bars):
        bar_s = beats_to_s(bar * 4, bpm)
        voicing, (b1, b2) = chords[bar % 4]
        hz_v = [midi_hz(m) for m in voicing]
        # Boom (bass on 1 and 3, root then fifth) - chick (strum on 2 and 4), a light upstroke after each chick.
        tr.add(upright_bass(midi_hz(b1), beats_to_s(0.95, bpm)), bar_s, gain=0.42)
        tr.add(upright_bass(midi_hz(b2), beats_to_s(0.95, bpm)), bar_s + beats_to_s(2, bpm), gain=0.38)
        for beat in (1, 3):
            tr.add(strum(hz_v, beats_to_s(0.45, bpm), rng, True, 0.55), bar_s + beats_to_s(beat, bpm), gain=0.30, pan=-0.25)
            tr.add(strum(hz_v[2:], beats_to_s(0.3, bpm), rng, False, 0.45), bar_s + beats_to_s(beat + 0.66, bpm),
                   gain=0.14, pan=-0.25)
        # Gallop: da-da-DUM on every beat (shuffled), shell tones panned apart like hooves.
        if bar >= 2:
            for beat in range(4):
                bs = bar_s + beats_to_s(beat, bpm)
                tr.add(clop(rng, 820), bs, gain=0.09, pan=0.3)
                tr.add(clop(rng, 1050), bs + beats_to_s(0.33, bpm), gain=0.05, pan=0.45)
                tr.add(clop(rng, 900), bs + beats_to_s(0.66, bpm), gain=0.065, pan=0.38)
        # Lead: the twang guitar states the tune, the whistle answers, then both together, then the rhythm alone.
        section = bar // 8
        for beat, m, dur in tune[bar % 8]:
            at = bar_s + beats_to_s(beat, bpm)
            d = beats_to_s(dur, bpm)
            if section in (0, 2):
                g = tremolo(fft_filter(pluck(midi_hz(m - 12), d + 0.6, 0.8), 'low', fc=2800), 6.0, 0.45)
                tr.add(g, at, gain=0.20 if section == 0 else 0.14, pan=0.25)
            if section in (1, 2):
                tr.add(whistle(midi_hz(m), d * 0.95), at, gain=0.10 if section == 1 else 0.07, pan=-0.1)
        # A low tom on each bar's last off-beat leads into the next chord.
        tr.add(frame_drum(rng, 0.4, 110), bar_s + beats_to_s(3.5, bpm), gain=0.12)
    wind = fft_filter(noise(tr.n, rng), 'band', fc=350, q_width=1.0)
    wind *= 0.4 + 0.6 * (0.5 + 0.5 * np.sin(2 * np.pi * np.arange(tr.n) / tr.n * 4))
    tr.add(wind, 0, gain=0.03)
    # A short, bright "spring" room plus a slap-back echo: the old western-guitar sound.
    mix = add_reverb(tr.buf, reverb_ir(1.6, rng, damp=5000), 0.3)
    return delay(mix, 0.11, 0.25, 0.12, pingpong=False)


def neon_city(rng):
    """Upbeat electro: four-on-the-floor, offbeat hats, sidechained pad, plucky saw hook, claps."""
    bpm, bars = 118, 48
    tr = Track(beats_to_s(bars * 4, bpm))
    drums = Track(tr.n / SR)
    prog = [('F#2', 'min'), ('D2', 'maj'), ('A2', 'maj'), ('E2', 'maj')]
    hook = [0, 3, 7, 10, 12, 10, 7, 3, 0, 3, 7, 12, 15, 12, 10, 7]
    beat_n = int(beats_to_s(1, bpm) * SR)
    duck = np.ones(beat_n)
    duck_len = int(0.2 * SR)
    duck[:duck_len] = np.linspace(0.25, 1.0, duck_len) ** 1.5
    for bar in range(bars):
        root, q = prog[bar % 4]
        rm = nmidi(root)
        notes = chord_notes(rm + 12, q)
        bar_s = beats_to_s(bar * 4, bpm)
        p = pad([midi_hz(m) for m in notes + [notes[0] + 12]], beats_to_s(4, bpm), cutoff=2400 if bar % 16 > 7 else 1500,
                attack=0.05, release=0.1, detune=16)
        p = p * np.tile(duck, 5)[: p.size]
        tr.add(p, bar_s, gain=0.18)
        for e in range(8):
            if e % 2 == 1:
                tr.add(sub_bass(midi_hz(rm - 12 + (12 if e == 7 else 0)), beats_to_s(0.4, bpm), drive=1.2, cutoff=900),
                       bar_s + beats_to_s(e * 0.5, bpm), gain=0.4)
        if bar >= 8:
            for s16 in range(16):
                if (s16 + bar) % 5 == 4:
                    continue
                m = rm + 24 + hook[s16]
                n = int(beats_to_s(0.25, bpm) * SR)
                sig = fft_filter(saw(midi_hz(m), n) + saw(midi_hz(m), n, -12), 'low', fc=3200) * env(n, 0.002, 0.06, 0.2, 0.03)
                tr.add(sig, bar_s + beats_to_s(s16 * 0.25, bpm), gain=0.07, pan=0.4 if s16 % 4 < 2 else -0.4)
        for b in range(4):
            drums.add(kick(rng, 0.4, 160, 48, 1.2), bar_s + beats_to_s(b, bpm), gain=0.9)
            drums.add(hat(rng, open_=True), bar_s + beats_to_s(b + 0.5, bpm), gain=0.10, pan=0.2)
            if b in (1, 3):
                drums.add(clap(rng), bar_s + beats_to_s(b, bpm), gain=0.4)
            for s in (0.25, 0.75):
                drums.add(hat(rng, 0.04), bar_s + beats_to_s(b + s, bpm), gain=0.05, pan=-0.25)
        if bar % 8 == 7:
            for k in range(8):
                drums.add(clap(rng, 0.15), bar_s + beats_to_s(2 + k * 0.25, bpm), gain=0.12 + 0.03 * k)
    ir = reverb_ir(2.0, rng, damp=6500)
    mix = add_reverb(tr.buf, ir, 0.3) + add_reverb(drums.buf, ir, 0.1)
    return delay(mix, beats_to_s(0.75, bpm), 0.3, 0.1)


ROOMS = {
    'solana': solana,
    'forest': forest,
    'town': town,
    'desert': desert,
    'neon-city': neon_city,
}


# ----------------------------------------------------------------------------------------------------- output

def write_wav(path, stereo):
    pcm = np.clip(stereo.T, -1, 1)
    pcm = (pcm * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def loudness(path):
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    tail = out[out.rfind('Integrated loudness'):]
    for line in tail.splitlines():
        line = line.strip()
        if line.startswith('I:'):
            return float(line.split()[1])
    raise RuntimeError('no loudness in ffmpeg output')


def render(name):
    rng = np.random.default_rng(sum(map(ord, name)) * 7919)
    mix = ROOMS[name](rng)
    mix = np.tanh(mix / (np.max(np.abs(mix)) + 1e-9) * 1.2) * 0.9  # gentle saturation, headroom
    os.makedirs(OUT_DIR, exist_ok=True)
    wav = os.path.join(OUT_DIR, f'_{name}.wav')
    write_wav(wav, mix)
    gain = ROOM_LUFS.get(name, TARGET_LUFS) - loudness(wav)
    mp3 = os.path.join(OUT_DIR, f'{name}.mp3')
    subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-af',
                    f'volume={gain:.2f}dB,alimiter=limit=0.89:attack=5:release=60:level=false', '-ar', '44100',
                    '-codec:a', 'libmp3lame', '-b:a', '80k', mp3], check=True)
    os.remove(wav)
    secs = mix.shape[1] / SR
    print(f'{name}: {secs:.1f}s, {os.path.getsize(mp3) / 1024:.0f} KB, {loudness(mp3):.1f} LUFS')


if __name__ == '__main__':
    for room in (sys.argv[1:] or list(ROOMS)):
        render(room)
