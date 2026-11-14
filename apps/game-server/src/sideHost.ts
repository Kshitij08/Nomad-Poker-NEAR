import type { ServerClock } from '@nomad/table-server/clock';
import { Room, type RoomSpec } from '@nomad/table-server/rooms';
import type { IPokerTableServer, PlayerRef, TableNet } from '@nomad/table-server/tableNet';
import { RoomHost, type LogFn } from './roomHost';

/**
 * A side channel for a table that is played somewhere else (an on-chain PER table, session `SC-<table address>`): the
 * room relays the table's chat, reactions (`sideReaction`) and voice signalling, and nothing else. No cards, no chips,
 * no seats; anyone with the address can join (it only carries what the players say).
 */
class SideServer implements IPokerTableServer {
  activate(_net: TableNet): void {}
  onHello(): void {}
  onActionSubmitted(): void {}
  onReaction(): void {}
  onVoiceState(): void {}
  onAvatar(): void {}
  onAddBot(): void {}
  onRemoveBot(): void {}
  onStartGame(): void {}
  onLeaveTable(): void {}
  onBuyIn(): void {}
  onRetentionGrant(): void {}
  onPlayerLeft(_player: PlayerRef): void {}
  seatOf(): number {
    return -1;
  }
  dispose(): void {}
}

export class SideHost extends RoomHost {
  readonly room: Room;

  constructor(spec: RoomSpec, clock: ServerClock, log: LogFn) {
    super(spec);
    const server = new SideServer();
    this.room = new Room(spec, server, clock, log);
    server.activate(this.room);
  }

  get label(): string {
    return `side channel ${this.spec.name}`;
  }

  get keepAwake(): boolean {
    return !this.closed && this.room.players.size > 0;
  }

  idleExpired(): boolean {
    return this.room.idleExpired();
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.room.close(reason);
  }

  async drain(): Promise<void> {
    await this.close('server restarting');
  }
}
