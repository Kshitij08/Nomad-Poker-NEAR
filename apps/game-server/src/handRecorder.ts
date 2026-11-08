import type { SettledHand } from '@nomad/table-server/pokerServerGame';

/**
 * Records every hand a table plays: the exact event bytes the table sent (to everyone, and to each player — hole
 * cards included, for replays and coaching), closed by the settlement the table reported (stacks, house result).
 * Hands are batched and written to R2 gzipped as JSON lines:
 *   hands/<yyyy>/<mm>/<dd>/<room>/<tableId>/<first hand>-<last hand>.jsonl.gz
 */

export interface RecordedHand {
  room: string;
  tableId: string | null;
  hand: number;
  settledAt: string;
  botDelta: number;
  humanDelta: number;
  stacks: SettledHand['stacks'];
  /** [recipient PlayerRef or 0 for everyone, base64 event payload], in send order. */
  events: [number, string][];
}

export type PutObject = (key: string, body: Uint8Array) => Promise<void>;

export class HandRecorder {
  private events: [number, string][] = [];
  private batch: RecordedHand[] = [];
  private writing: Promise<void> = Promise.resolve();
  /** Hands written so far (for tests and logs). */
  written = 0;

  constructor(
    private readonly room: string,
    private readonly put: PutObject,
    private readonly log: (level: 'info' | 'warn' | 'error', m: string) => void,
    private readonly batchSize = 25,
  ) {}

  /** A payload the table sent; `to` = PlayerRef, 0 = broadcast. */
  event(to: number, payload: Uint8Array): void {
    this.events.push([to, toBase64(payload)]);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000); // a stuck lobby must not grow forever
  }

  settled(h: SettledHand, now = Date.now()): void {
    this.batch.push({
      room: this.room,
      tableId: h.tableId,
      hand: h.handNumber,
      settledAt: new Date(now).toISOString(),
      botDelta: h.botDelta,
      humanDelta: h.humanDelta,
      stacks: h.stacks,
      events: this.events,
    });
    this.events = [];
    if (this.batch.length >= this.batchSize) void this.flush();
  }

  get pending(): number {
    return this.batch.length;
  }

  /** Writes what is batched (one object). Writes are serialised; a failed write keeps its hands for the next try. */
  flush(): Promise<void> {
    if (this.batch.length === 0) return this.writing;
    const hands = this.batch;
    this.batch = [];
    this.writing = this.writing.then(async () => {
      const first = hands[0]!;
      const last = hands[hands.length - 1]!;
      const d = new Date(first.settledAt);
      const day = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
      const key = `hands/${day}/${this.room}/${first.tableId ?? 'free'}/${String(first.hand).padStart(6, '0')}-${String(last.hand).padStart(6, '0')}.jsonl.gz`;
      try {
        await this.put(key, await gzip(hands.map((h) => JSON.stringify(h)).join('\n') + '\n'));
        this.written += hands.length;
      } catch (e) {
        this.log('error', `[Hands] could not write ${key}: ${(e as Error).message}; keeping ${hands.length} hands for the next flush`);
        this.batch = hands.concat(this.batch);
      }
    });
    return this.writing;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
