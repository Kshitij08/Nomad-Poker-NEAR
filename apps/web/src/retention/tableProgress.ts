/**
 * Free-play XP and mission progress from a table's event stream. Port of the progression hooks in
 * Net/PokerClientGame.cs (the networked client): OnLocalSeatChanged → RecordTableJoined + friend check,
 * OnHandStarted → RecordHandPlayed, OnShowdown → RecordShowdown(local entry), OnPotAwarded → RecordHandWon (once per
 * hand), TryRecordFriendMission. Money (SOL) tables never count. Unity's offline PokerGameController (Test.unity)
 * has no progression hooks at all; whether the web's offline table counts is the table session's call.
 */
import type { PokerEvent, SeatSnapshot } from '@nomad/engine/events/pokerEvent';
import type { PlayerProgression } from './playerProgression';

export interface TableProgressOptions {
  /** Seat the local player sits in (-1 = not seated). Can change later via `setLocalSeat`. */
  localSeat: number;
  /** SOL / money table: no XP, no missions (C# IsMoneyTable). */
  moneyTable?: boolean;
  /** Session/room name counted once per UTC day toward "Play 2 tables" (C# RoomCode). */
  roomCode?: string;
  /** Local player's name (skipped when matching friends). */
  playerName?: string;
  /** Confirmed-friend check (C# IsConfirmedFriendName over PlayFabFriends). Default: nobody is a friend. */
  isFriend?: (name: string) => boolean;
}

export class TableProgressTracker {
  private countedWinThisHand = false;
  private handTracked = false;
  private roster: SeatSnapshot[] | null = null;

  constructor(private readonly progression: PlayerProgression, private readonly opts: TableProgressOptions) {
    if (opts.localSeat >= 0) this.onSeated();
  }

  /** C# OnLocalSeatChanged: a non-negative seat on a free table counts the table (once per room per UTC day). */
  setLocalSeat(seat: number): void {
    const was = this.opts.localSeat;
    this.opts.localSeat = seat;
    if (seat >= 0 && seat !== was) this.onSeated();
  }

  private onSeated(): void {
    if (this.opts.moneyTable) return;
    if (this.opts.roomCode) this.progression.recordTableJoined(this.opts.roomCode);
    this.tryRecordFriendMission();
  }

  /** Feed every presented table event, in order. */
  onEvent(e: PokerEvent): void {
    const local = this.opts.localSeat;
    switch (e.type) {
      case 'TableRoster':
        this.roster = e.seats ?? this.roster;
        return;
      case 'HandStarted': {
        this.roster = e.seats ?? this.roster;
        this.countedWinThisHand = false;
        this.handTracked = false;
        const seat = local >= 0 ? e.seats?.[local] : undefined;
        if (!this.opts.moneyTable && seat?.isOccupied) {
          this.handTracked = true;
          this.progression.recordHandPlayed();
          this.tryRecordFriendMission();
        }
        return;
      }
      case 'Showdown': {
        if (this.opts.moneyTable || local < 0 || !e.entries) return;
        const mine = e.entries.find((x) => x && x.seat === local);
        if (mine) this.progression.recordShowdown(mine.value.category);
        return;
      }
      case 'PotAwarded':
        if (!this.opts.moneyTable && e.seat === local && e.amount > 0 && !this.countedWinThisHand) {
          this.countedWinThisHand = true;
          this.progression.recordHandWon();
        }
        return;
      case 'HandEnded':
        this.handTracked = false;
        return;
      default:
    }
  }

  /** Buddy System: any non-bot, non-agent occupied seat whose name is a confirmed friend counts once. */
  private tryRecordFriendMission(): void {
    const roster = this.roster;
    const local = this.opts.localSeat;
    if (!roster || local < 0 || !this.opts.isFriend) return;
    const self = this.opts.playerName ?? '';
    for (let i = 0; i < roster.length; i++) {
      if (i === local) continue;
      const s = roster[i];
      if (!s || !s.isOccupied || s.isBot || s.isAgent || !s.name) continue;
      if (self && s.name.toLowerCase() === self.toLowerCase()) continue;
      if (!this.opts.isFriend(s.name)) continue;
      this.progression.recordPlayedWithFriend();
      return;
    }
  }

  get trackingHand(): boolean {
    return this.handTracked;
  }
}
