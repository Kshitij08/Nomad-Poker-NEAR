/**
 * Port of Net/Chat/PokerTableChat.cs: the table's chat channel. Unity rode Photon Chat (channel
 * `poker.<appVersion>.<region>.<session>`); here the channel is the table socket itself, so joining the session is
 * subscribing. Kept: the token-bucket limiter, the 10 s duplicate drop, the 60-row log, per-sender mute, the sender
 * colour index, "Photon does not echo" (the local row is added on send), and the state machine the panel reads.
 */
import type { NetConnection } from './netConnection';
import { PokerChatRateLimiter, PokerChatSettings, PokerChatText } from './shared/chat';
import { LOCAL_APP_VERSION } from './shared/sessions';

export interface PokerChatRow {
  userId: string;
  name: string;
  body: string;
  isLocal: boolean;
  colorIndex: number;
}

export enum ChatLinkState {
  Idle,
  Connecting,
  Subscribing,
  Subscribed,
  Retrying,
  Unavailable,
}

const DuplicateWindowSeconds = 10;

export class TableChat {
  private readonly limiter = new PokerChatRateLimiter();
  private readonly rows: PokerChatRow[] = [];
  private readonly muted = new Set<string>();
  private lastSentBody: string | null = null;
  private lastSentAt = -Infinity;
  private off: (() => void)[] = [];
  private _state = ChatLinkState.Idle;
  channelName = '';
  /** PokerTableChat.IsTyping: the input has focus (table hotkeys stand down). */
  static isTyping = false;

  readonly messageAdded = new Set<(row: PokerChatRow) => void>();
  readonly stateChanged = new Set<() => void>();
  readonly logCleared = new Set<() => void>();

  constructor(
    private readonly conn: NetConnection,
    private readonly localUserId: string,
    private readonly displayName: () => string,
    private readonly now: () => number = () => performance.now() / 1000,
  ) {}

  get state(): ChatLinkState {
    return this._state;
  }

  get isAvailable(): boolean {
    return this._state !== ChatLinkState.Unavailable;
  }

  get canSend(): boolean {
    return this._state === ChatLinkState.Subscribed && this.conn.isOpen && this.limiter.secondsUntilNextToken(this.now()) <= 0;
  }

  get sendCooldownRemaining(): number {
    return this.limiter.secondsUntilNextToken(this.now());
  }

  get log(): readonly PokerChatRow[] {
    return this.rows;
  }

  /** JoinTable: the session is live, so the channel is too. */
  join(session: string, region: string): void {
    this.end();
    this.channelName = PokerChatText.channelName(LOCAL_APP_VERSION, region || 'in', session);
    this.limiter.reset();
    this.lastSentBody = null;
    this.lastSentAt = -Infinity;
    this.off.push(
      this.conn.onMessage((m) => {
        if (m.t !== 'chat') return;
        if (this.isMuted(m.userId)) return;
        const p = PokerChatText.decode([m.name, m.body], m.userId);
        if (!p.body) return;
        this.append({ userId: m.userId, name: p.name, body: p.body, isLocal: false, colorIndex: PokerChatText.colorIndex(m.userId, PokerChatSettings.PaletteSize) });
      }),
      this.conn.onClose(() => this.setState(ChatLinkState.Unavailable)),
    );
    this.setState(ChatLinkState.Subscribed);
  }

  /** LeaveTable: drop the channel and its log. */
  end(): void {
    for (const f of this.off.splice(0)) f();
    this.channelName = '';
    this.lastSentBody = null;
    if (this.rows.length > 0) {
      this.rows.length = 0;
      for (const fn of [...this.logCleared]) fn();
    }
    this.setState(ChatLinkState.Idle);
  }

  send(body: string): boolean {
    if (this._state !== ChatLinkState.Subscribed || !this.conn.isOpen) return false;
    const clean = PokerChatText.sanitize(body);
    if (!clean) return false;
    const t = this.now();
    // A double-tapped send costs nothing and says nothing.
    if (clean === this.lastSentBody && t - this.lastSentAt < DuplicateWindowSeconds) return false;
    if (!this.limiter.tryConsume(t)) return false;
    const [name] = PokerChatText.encode(this.displayName(), clean);
    this.conn.send({ t: 'chat', name, body: clean });
    this.lastSentBody = clean;
    this.lastSentAt = t;
    this.append({ userId: this.localUserId, name, body: clean, isLocal: true, colorIndex: PokerChatText.colorIndex(this.localUserId, PokerChatSettings.PaletteSize) });
    for (const fn of [...this.stateChanged]) fn();
    return true;
  }

  isMuted(userId: string): boolean {
    return !!userId && this.muted.has(userId);
  }

  setMuted(userId: string, muted: boolean): void {
    if (!userId) return;
    if (muted) this.muted.add(userId);
    else this.muted.delete(userId);
  }

  private append(row: PokerChatRow): void {
    this.rows.push(row);
    while (this.rows.length > PokerChatSettings.LogCapacity) this.rows.shift();
    for (const fn of [...this.messageAdded]) fn(row);
  }

  private setState(s: ChatLinkState): void {
    if (this._state === s) return;
    this._state = s;
    for (const fn of [...this.stateChanged]) fn();
  }
}
