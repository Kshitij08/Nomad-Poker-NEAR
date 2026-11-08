/**
 * Every sound the table can ask for, named by the moment. Port of Game/Audio/PokerSound.cs, plus the clip mapping
 * from Assets/Resources/PokerSfxLibrary.asset (file under Assets/Sfx, per-clip volume trim, retrigger guard seconds).
 */
export enum PokerSound {
  None = 0,
  HoleCardsDealt = 1,
  FlopDealt = 2,
  TurnDealt = 3,
  RiverDealt = 4,
  CardsReturned = 5,
  Fold = 10,
  Check = 11,
  Call = 12,
  Raise = 13,
  AllIn = 14,
  ChipsToPot = 20,
  ChipsToWinner = 21,
  HandWon = 22,
  YourTurn = 30,
  TurnTimer = 31,
  PlayerJoined = 40,
  BotRemoved = 41,
  ButtonGeneric = 50,
  ButtonStart = 51,
  ChatMessage = 60,
  VoiceChatOn = 61,
  VoiceChatOff = 62,
  Reaction = 63, // no clip mapped: silent
  MusicIntro = 70,
  MusicLoop = 71,
}

export interface SfxEntry {
  /** File name under Assets/Sfx. */
  readonly file: string;
  /** Per-clip trim (0..2), multiplied onto master * sfx (or music) volume. */
  readonly volume: number;
  /** Seconds this sound refuses to restart for (unscaled time). 0 = always plays. */
  readonly minRetrigger: number;
}

/** PokerSfxLibrary.asset entries. masterTrim = 1, playMusicOnStart = true. Sounds with no entry are silent. */
export const SFX_LIBRARY: Readonly<Partial<Record<PokerSound, SfxEntry>>> = Object.freeze({
  [PokerSound.HoleCardsDealt]: { file: 'cards flying dealt.mp3', volume: 0.9, minRetrigger: 0.5 },
  [PokerSound.FlopDealt]: { file: '3 cards dealt (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.3 },
  [PokerSound.TurnDealt]: { file: '4th card dealt (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.3 },
  [PokerSound.RiverDealt]: { file: 'final card dealt (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.3 },
  [PokerSound.CardsReturned]: { file: 'cards fly back.mp3', volume: 0.8, minRetrigger: 0.5 },
  [PokerSound.Fold]: { file: 'fold.mp3', volume: 0.9, minRetrigger: 0.05 },
  [PokerSound.Check]: { file: 'check sfx (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.05 },
  [PokerSound.Call]: { file: 'call sfx (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.05 },
  [PokerSound.Raise]: { file: 'raise bet sfx (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.05 },
  [PokerSound.AllIn]: { file: 'All in complete sfx (mp3cut.net).mp3', volume: 1.0, minRetrigger: 0.2 },
  [PokerSound.ChipsToPot]: { file: 'bet money collect sfx (mp3cut.net).mp3', volume: 0.8, minRetrigger: 0.1 },
  [PokerSound.ChipsToWinner]: { file: 'winner coins collect sfx (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.1 },
  [PokerSound.HandWon]: { file: 'win sfx (mp3cut.net).mp3', volume: 1.0, minRetrigger: 0.3 },
  [PokerSound.YourTurn]: { file: 'your turn sfx (mp3cut.net).mp3', volume: 1.0, minRetrigger: 0.3 },
  [PokerSound.TurnTimer]: { file: 'timer.mp3', volume: 0.5, minRetrigger: 0 },
  [PokerSound.PlayerJoined]: { file: 'player and bot table join sfx (mp3cut.net).mp3', volume: 0.8, minRetrigger: 0.2 },
  [PokerSound.BotRemoved]: { file: 'bot cancel sfx (mp3cut.net).mp3', volume: 0.8, minRetrigger: 0.1 },
  [PokerSound.ButtonGeneric]: { file: 'generic button (mp3cut.net).mp3', volume: 0.6, minRetrigger: 0.04 },
  [PokerSound.ButtonStart]: { file: 'join table and start match button (mp3cut.net).mp3', volume: 0.9, minRetrigger: 0.1 },
  [PokerSound.ChatMessage]: { file: 'chat message notification (mp3cut.net).mp3', volume: 0.8, minRetrigger: 0.15 },
  [PokerSound.VoiceChatOn]: { file: 'voice chat on sfx (mp3cut.net).mp3', volume: 0.8, minRetrigger: 0.2 },
  [PokerSound.VoiceChatOff]: { file: 'voice chat off sfx (mp3cut.net).mp3', volume: 0.8, minRetrigger: 0.2 },
  [PokerSound.MusicIntro]: { file: 'Nomad Poker game BGM.mp3', volume: 1.0, minRetrigger: 0 },
  [PokerSound.MusicLoop]: { file: 'Nomad Poker game BGM looped.mp3', volume: 1.0, minRetrigger: 0 },
});

/** PokerAudio volume defaults (PlayerPrefs poker.audio.master / .music / .sfx). */
export const DEFAULT_VOLUMES = Object.freeze({ master: 1.0, music: 0.6, sfx: 0.6 });

/** What the presenter/controller need from an audio backend (PokerAudio's static API). */
export interface AudioPort {
  play(sound: PokerSound): void;
  /**
   * Starts the countdown bed so its last tick lands on the timeout: a clip longer than `seconds` starts
   * (length - seconds) in; a shorter one is delayed by (seconds - length).
   */
  startTurnTimer(seconds: number): void;
  stopTurnTimer(): void;
}

export const SILENT_AUDIO: AudioPort = Object.freeze({ play() {}, startTurnTimer() {}, stopTurnTimer() {} });
