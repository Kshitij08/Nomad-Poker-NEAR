# Room music

One seamless background loop per table room, synthesised from scratch by `tools/music/render-room-music.py`
(numpy + ffmpeg; no samples, nothing downloaded). Loudness-matched to about −15 LUFS (the menu BGM is −13.8),
MP3 80 kbps, 44.1 kHz stereo. The menu keeps `assets/sfx/Nomad Poker game BGM*.mp3`. Wiring:
`src/audio/roomMusic.ts` (room → file) and `WebAudio.setMusicTrack` (crossfade).

| File | Room (theme id) | Style | Tempo · key | Length |
|---|---|---|---|---|
| `solana.mp3` | Default (Solana arena) | Synthwave: driving 8th bass, gated pads, 16th saw arpeggio, big snare, square-lead hook | 100 BPM · A minor | 96 s |
| `forest.mp3` | Forest | Calm acoustic: fingerpicked plucks, soft breathy flute, shaker, wind, crickets, birds | 78 BPM · D major | 86 s |
| `town.mp3` | Town | Lo-fi jazz hop: Rhodes-style 7th chords with tremolo, walking upright bass, swung boom-bap, vinyl crackle | 84 BPM · ii–V–I in C | 91 s |
| `desert.mp3` | Desert | Dusk western: handpan ostinato over a drone, tremolo twang guitar, frame drum, shaker, wind | 90 BPM · D Phrygian dominant | 85 s |
| `neon-city.mp3` | Neon_City | Upbeat electro: four-on-the-floor, offbeat open hats, sidechained supersaw pad, plucky saw hook, claps | 118 BPM · F# minor | 98 s |

Re-render: `python tools/music/render-room-music.py [room…]` (deterministic: same script, same audio).
