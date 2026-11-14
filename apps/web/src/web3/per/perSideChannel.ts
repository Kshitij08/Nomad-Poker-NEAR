import { PokerChatRateLimiter } from '@nomad/table-server/chat';
import { NetConnection } from '../../net/netConnection';
import { TableChat } from '../../net/tableChat';

/**
 * Chat and reactions at an on-chain (PER) table. The table itself is played on Solana and has no message channel, so
 * the players of one table meet in a side room on the game server, `SC-<table address>`, which relays the chat
 * (TableChat, as at Coins tables) and reactions (`sideReaction`, keyed by the table's own seat number). It carries
 * nothing about the game: no cards, no chips.
 */
export class PerSideChannel {
  readonly conn: NetConnection;
  readonly chat: TableChat;
  private readonly limiter = new PokerChatRateLimiter(4, 1.5);
  private off: (() => void) | null = null;
  private closed = false;

  constructor(
    gameServer: string,
    private readonly tableAddress: string,
    /** Your seat at the table (on-chain seat number), or -1 while not seated. */
    private readonly mySeat: () => number,
    /** Draws a reaction over an on-chain seat. */
    private readonly show: (seat: number, id: number) => void,
    private readonly chatUserId: string,
    private readonly displayName: () => string,
  ) {
    this.conn = new NetConnection(gameServer);
    this.chat = new TableChat(this.conn, chatUserId, displayName);
  }

  async open(): Promise<boolean> {
    try {
      const r = await this.conn.join(`SC-${this.tableAddress}`);
      if (!r.ok || this.closed) {
        if (!r.ok) console.warn('[PER] chat channel unavailable:', r.message);
        this.conn.close();
        return false;
      }
    } catch (e) {
      console.warn('[PER] chat channel unavailable:', (e as Error).message);
      return false;
    }
    // The hello only names this member for the room's chat attribution (the side room seats nobody).
    this.conn.send({ t: 'hello', name: this.displayName(), token: this.chatUserId, ticket: '', buyIn: 0 });
    this.chat.join(this.conn.session || `SC-${this.tableAddress}`, this.conn.region);
    this.off = this.conn.onMessage((m) => {
      if (m.t === 'sideReaction') this.show(m.seat, m.id);
    });
    return true;
  }

  close(): void {
    this.closed = true;
    this.off?.();
    this.off = null;
    this.conn.close();
  }

  // ---- What the reaction tray reads (netChrome ReactionPort) ----

  get localSeat(): number {
    return this.conn.isOpen ? this.mySeat() : -1;
  }

  get canReact(): boolean {
    return this.localSeat >= 0 && this.limiter.secondsUntilNextToken(performance.now() / 1000) <= 0;
  }

  get reactionCooldownRemaining(): number {
    return this.limiter.secondsUntilNextToken(performance.now() / 1000);
  }

  sendReaction(reactionId: number): boolean {
    const seat = this.localSeat;
    if (seat < 0 || !this.limiter.tryConsume(performance.now() / 1000)) return false;
    const id = reactionId & 0xff;
    this.conn.send({ t: 'sideReaction', seat, id });
    this.show(seat, id); // the room doesn't echo it back
    return true;
  }
}
