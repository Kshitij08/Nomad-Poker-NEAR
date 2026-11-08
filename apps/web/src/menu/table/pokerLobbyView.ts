/**
 * Port of Game/UI/PokerLobbyView.cs: the networked table's lobby readout — who is seated, and for the table owner add
 * bot / remove bot / start; leave and buy-in for anyone. It holds no networking: the net module binds the callbacks and
 * calls render() with the replicated lobby state and roster. Widgets are handed in as small handles so any panel (the
 * table HUD's Join_Table / Start Game / AddBotButton / InviteButton nodes, or a net module's own) can use it.
 */
import { formatN0 } from '@nomad/engine';

export interface LobbyWidget {
  setActive(on: boolean): void;
  readonly activeSelf: boolean;
}
export interface LobbyLabel extends LobbyWidget {
  setText(text: string): void;
}
export interface LobbyButton extends LobbyWidget {
  setInteractable(on: boolean): void;
  /** Replaces every listener (Rebind: RemoveAllListeners + AddListener). */
  rebind(fn: () => void): void;
}

export enum TablePhase {
  Waiting = 0,
  Playing = 1,
  GameOver = 2,
}
export interface LobbyState {
  phase: TablePhase;
  seatedCount: number;
  readyCount: number;
  minToStart: number;
  autoStart: boolean;
  youAreOwner: boolean;
  youCanBuyIn: boolean;
  youJoinNextHand: boolean;
}
export interface SeatSnapshot {
  isOccupied: boolean;
  isBot: boolean;
  name: string;
  stack: number;
  isPendingNextHand: boolean;
  isLeaving: boolean;
  isBusted: boolean;
}

export interface LobbyParts {
  root?: LobbyWidget;
  statusLabel?: LobbyLabel;
  roomCodeLabel?: LobbyLabel;
  roomCodeFormat?: string;
  copyCodeButton?: LobbyButton;
  copiedMessage?: string;
  copiedMessageSeconds?: number;
  seatListRoot?: LobbyWidget;
  seatLabels?: LobbyLabel[];
  ownerControls?: LobbyWidget;
  addBotButton?: LobbyButton;
  removeBotButton?: LobbyButton;
  startButton?: LobbyButton;
  startLabel?: LobbyLabel;
  leaveButton?: LobbyButton;
  buyInButton?: LobbyButton;
  buyInLabel?: LobbyLabel;
  /** UiClipboard.Copy. */
  copy?(text: string): void;
  /** PokerAudio.AssignButton(start / buy-in, ButtonStart): the net module plays it on those presses. */
  playStart?(): void;
}

const set = (w: LobbyWidget | undefined, on: boolean) => {
  if (w && w.activeSelf !== on) w.setActive(on);
};

export class PokerLobbyView {
  private onAddBot?: () => void;
  private onRemoveBot?: () => void;
  private onStart?: () => void;
  private onLeave?: () => void;
  private onBuyIn?: () => void;
  private roomCode = '';
  private flash = 0;
  private joinInFlight = false;
  private startSlotFree = false;
  private buyInSlotFree = false;
  private lobby: LobbyState | null = null;
  private moneyTable = false;
  private moneyHalted = false;
  private moneyBuyInLabel: string | null = null;

  constructor(private readonly p: LobbyParts) {
    p.addBotButton?.rebind(() => this.onAddBot?.());
    p.removeBotButton?.rebind(() => this.onRemoveBot?.());
    p.startButton?.rebind(() => (p.playStart?.(), this.onStart?.()));
    p.leaveButton?.rebind(() => this.onLeave?.());
    p.buyInButton?.rebind(() => (p.playStart?.(), this.onBuyIn?.()));
    p.copyCodeButton?.rebind(() => this.copyRoomCode());
  }

  bind(addBot: () => void, removeBot: () => void, start: () => void, leave?: () => void, buyIn?: () => void): void {
    this.onAddBot = addBot;
    this.onRemoveBot = removeBot;
    this.onStart = start;
    this.onLeave = leave;
    this.onBuyIn = buyIn;
  }

  setMoneyTable(moneyTable: boolean, buyInLabel: string | null = null, halted = false): void {
    this.moneyTable = moneyTable;
    this.moneyBuyInLabel = buyInLabel;
    this.moneyHalted = halted;
  }

  hideBotControls(): void {
    set(this.p.addBotButton, false);
    set(this.p.removeBotButton, false);
  }

  setRoomCode(code: string | null): void {
    this.roomCode = code ?? '';
    window.clearTimeout(this.flash);
    // Quick Play's shared rooms are named "poker-free…": a server name, not a code anyone can join with.
    const shared = this.roomCode.toLowerCase().startsWith('poker-');
    if (this.p.roomCodeLabel) {
      this.p.roomCodeLabel.setActive(this.roomCode.length > 0);
      this.p.roomCodeLabel.setText(shared ? 'Quick Play' : this.format(this.roomCode));
    }
    this.p.copyCodeButton?.setInteractable(this.roomCode.length > 0 && !shared);
  }

  private format(code: string): string {
    return (this.p.roomCodeFormat ?? 'Room  {0}').replace('{0}', code);
  }

  get isJoinInFlight(): boolean {
    return this.joinInFlight;
  }
  set isJoinInFlight(v: boolean) {
    if (this.joinInFlight === v) return;
    this.joinInFlight = v;
    this.applyJoinDependentVisibility();
  }

  private copyRoomCode(): void {
    if (!this.roomCode) return;
    this.p.copy ? this.p.copy(this.roomCode) : void navigator.clipboard?.writeText(this.roomCode).catch(() => undefined);
    const label = this.p.roomCodeLabel;
    if (!label) return;
    window.clearTimeout(this.flash);
    label.setText(this.p.copiedMessage ?? 'COPIED!');
    this.flash = window.setTimeout(() => label.setText(this.format(this.roomCode)), (this.p.copiedMessageSeconds ?? 1.2) * 1000);
  }

  render(lobby: LobbyState | null, roster: SeatSnapshot[] | null, localSeat: number): void {
    this.lobby = lobby;
    if (!lobby) return this.setVisible(false);
    this.setVisible(true);
    this.p.statusLabel?.setText(statusFor(lobby));
    this.drawSeats(roster, localSeat, lobby.phase === TablePhase.Playing);
    if (this.p.leaveButton) {
      const holds = localSeat >= 0;
      this.p.leaveButton.setActive(holds);
      this.p.leaveButton.setInteractable(holds);
    }
    this.buyInSlotFree = (this.moneyTable && this.moneyHalted) || lobby.youCanBuyIn;
    this.applyJoinDependentVisibility();
    this.p.buyInLabel?.setText(this.moneyTable ? (this.moneyHalted ? 'Cash out' : this.moneyBuyInLabel ?? 'Buy in') : 'Add Funds');
    if (!this.showBotControls) this.hideBotControls();
    if (!lobby.youAreOwner) return;
    this.p.addBotButton?.setInteractable(this.showBotControls && !!roster?.some((s) => !s.isOccupied));
    this.p.removeBotButton?.setInteractable(this.showBotControls && !!roster?.some((s) => s.isOccupied && s.isBot));
    this.p.startButton?.setInteractable(!lobby.autoStart && lobby.seatedCount >= lobby.minToStart && lobby.readyCount >= lobby.minToStart);
    this.p.startLabel?.setText(lobby.phase === TablePhase.GameOver ? 'Play again' : 'Start game');
  }

  setVisible(visible: boolean): void {
    set(this.p.root, visible);
    const l = this.lobby;
    const playing = l?.phase === TablePhase.Playing;
    const owner = !!l?.youAreOwner;
    const autoStart = !!l?.autoStart;
    set(this.p.statusLabel, visible);
    set(this.p.seatListRoot, visible && !playing);
    set(this.p.ownerControls, visible && owner && !autoStart);
    const showBots = visible && owner && this.showBotControls;
    set(this.p.addBotButton, showBots);
    set(this.p.removeBotButton, showBots);
    this.startSlotFree = visible && owner && !playing && !autoStart;
    this.applyJoinDependentVisibility();
    if (!visible) set(this.p.buyInButton, false);
  }

  private applyJoinDependentVisibility(): void {
    set(this.p.startButton, this.startSlotFree && !this.joinInFlight);
    if (!this.p.buyInButton) return;
    const on = this.buyInSlotFree && !this.joinInFlight;
    set(this.p.buyInButton, on);
    this.p.buyInButton.setInteractable(on);
  }

  private get showBotControls(): boolean {
    return !this.moneyTable && (this.lobby === null || !this.lobby.autoStart);
  }

  private drawSeats(roster: SeatSnapshot[] | null, localSeat: number, playing: boolean): void {
    this.p.seatLabels?.forEach((label, i) => {
      const inRange = !playing && !!roster && i < roster.length;
      label.setActive(inRange);
      if (inRange) label.setText(seatLine(roster![i]!, i, localSeat));
    });
  }
}

function statusWaiting(l: LobbyState): string {
  if (l.seatedCount < l.minToStart) return `Waiting for players… ${l.seatedCount}/${l.minToStart}`;
  if (l.readyCount < l.minToStart) return `Buying in… ${l.readyCount}/${l.seatedCount} seats funded`;
  if (l.autoStart) return `${l.readyCount} ready — starting…`;
  return l.youAreOwner ? `${l.seatedCount} seated — start when ready.` : 'Waiting for the host to start…';
}

function statusFor(l: LobbyState): string {
  if (l.youCanBuyIn) return l.phase === TablePhase.Playing ? "You're out of chips — add funds to sit back down." : 'Add funds to take a seat.';
  switch (l.phase) {
    case TablePhase.GameOver:
      return l.autoStart ? statusWaiting(l) : l.youAreOwner ? 'Game over — play again?' : 'Game over.';
    case TablePhase.Playing:
      return l.youJoinNextHand ? "You're in from the next hand." : 'Hand in progress.';
    default:
      return statusWaiting(l);
  }
}

/** Rich text (TMP): the labels showing these need `text.rich = true`. */
function seatLine(seat: SeatSnapshot, index: number, localSeat: number): string {
  if (!seat.isOccupied) return `<color=#FFFFFF60>${index + 1}.  Empty</color>`;
  let name = seat.name;
  if (index === localSeat) name += '  (you)';
  if (seat.isPendingNextHand) name += '  <color=#FFD966>· next hand</color>';
  else if (seat.isLeaving) name += '  <color=#FF8A8A>· leaving</color>';
  else if (seat.isBusted) name += '  <color=#FF8A8A>· busted</color>';
  return `${index + 1}.  ${name}<color=#8CD98C>     ${formatN0(seat.stack)}</color>`;
}
