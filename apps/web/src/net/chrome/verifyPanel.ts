/**
 * The Verify chip at a NEAR money table: each finished hand's deck commitment (announced on HandStarted, before the
 * deal) and whether the game server's reveal checks out against it ("Verified" / "Does not match"), with the seed.
 * The checking itself is near/deckVerify.ts (DeckLog), fed by the table session.
 */
import type { AppContext } from '../../app/app';
import { esc } from '../../ui2/core';
import { chipButton, tableSheet, tIcon, type ChromeSlots } from '../../ui2/tableChrome';
import { v2tEl } from '../../ui2/tableKit';
import type { DeckLog, HandCheck } from '../../near/deckVerify';
import type { NetTableSession } from '../netService';

const short = (hex: string): string => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

const STATUS: Record<HandCheck['status'], [string, string]> = {
  playing: ['In play', ''],
  waiting: ['Waiting for the reveal', ''],
  checking: ['Checking…', ''],
  verified: ['Verified', 'ok'],
  mismatch: ['Does not match', 'bad'],
  none: ['No commitment', ''],
  error: ["Couldn't fetch the reveal", 'bad'],
};

/** One hand's row (exported for tests and the panel). */
export function handRow(h: HandCheck): string {
  const [label, tone] = STATUS[h.status];
  const retry = h.status === 'waiting' || h.status === 'error' ? `<button type="button" class="v2t-b sm" data-check="${h.handNumber}">Check again</button>` : '';
  const lines = [
    h.commitment ? `<div class="v2t-vf-k"><span>Commitment</span><code title="${esc(h.commitment)}">${esc(short(h.commitment))}</code></div>` : '',
    h.seed ? `<div class="v2t-vf-k"><span>Seed</span><code title="${esc(h.seed)}">${esc(short(h.seed))}</code></div>` : '',
    h.status === 'mismatch' || h.status === 'error' ? `<div class="v2t-vf-why">${esc(h.reason ?? '')}</div>` : '',
  ].join('');
  return `<div class="v2t-vf-row"><div class="v2t-vf-head"><b>Hand ${h.handNumber}</b><span class="v2t-vf-st ${tone}">${label}</span>${retry}</div>${lines}</div>`;
}

export function verifyBody(log: DeckLog | null): string {
  const intro = '<p class="v2t-vf-intro">Before each deal the server commits to the deck\'s seed. After the hand it reveals the seed; your browser checks it matches the commitment and deals exactly the cards that were played.</p>';
  const hands = log?.hands ?? [];
  if (!hands.length) return intro + '<div class="v2t-vf-empty">No hands yet. Each hand shows here once it starts.</div>';
  return intro + hands.map(handRow).join('');
}

/** The chip in the top-left bar and its sheet; shown only at a NEAR money table. */
export class VerifyView {
  private readonly chip: HTMLButtonElement;
  private session: NetTableSession | null = null;
  private sheet: { body: HTMLElement; close: () => void } | null = null;
  private readonly off: () => void;

  constructor(private readonly slots: ChromeSlots, ctx: AppContext) {
    this.chip = chipButton(slots.left, `${tIcon('check', 1.1)}<span>Verify</span>`, 'Verify the deals', () => this.open(), 'verify', 3);
    this.chip.hidden = true;
    this.off = ctx.events.on('near:deck', () => this.draw());
  }

  render(session: NetTableSession | null): void {
    this.session = session;
    this.chip.hidden = !session?.money || session.status === 'closed';
  }

  private open(): void {
    if (this.sheet) return;
    const { body, foot, close } = tableSheet(this.slots.layer, 'Verify the deals', { wide: true, onClose: () => (this.sheet = null) });
    body.classList.add('v2t-vf');
    body.addEventListener('click', (e) => {
      const n = (e.target as HTMLElement).closest<HTMLElement>('[data-check]')?.dataset.check;
      if (n) void this.session?.deck?.check(Number(n));
    });
    const ok = v2tEl('button', 'v2t-b gold', foot, 'Done');
    ok.type = 'button';
    ok.addEventListener('click', close);
    this.sheet = { body, close };
    this.draw();
  }

  private draw(): void {
    if (this.sheet) this.sheet.body.innerHTML = verifyBody(this.session?.deck ?? null);
  }

  dispose(): void {
    this.off();
    this.sheet?.close();
    this.chip.remove();
  }
}
