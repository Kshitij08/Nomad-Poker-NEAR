/**
 * PerTableController.BuildHud in the Redesign v2 look (Screen Atlas › Private SOL table (TEE)):
 *  - centred at the top, three pills: "TEE · MagicBlock" (neutral: no attestation claim, worklog decision 30), the table status, and "ON-CHAIN · DEVNET" (Unity's grey
 *    code-built strip becomes these pills);
 *  - Verify hand (blue) and Start round (gold) as v2 buttons in the top-right corner, Back to lobby under them at a
 *    tournament table;
 *  - the Verify panel as a v2 panel left of the buttons, with the client-side checks (OK green, FAIL orange).
 */
import type { NomadHost } from '../../menu/host';
import { v2tButton, v2tEl, v2tLayer } from '../../ui2/tableKit';

export interface PerHudHandlers {
  onVerify: () => string;
  onStart: () => void;
  onBackToLobby: (() => void) | null;
}

/** What the controller drives (DOM fallback in perTableController.ts when the menu isn't installed). */
export interface PerHud {
  setStatus(s: string): void;
  showStart(on: boolean): void;
  dispose(): void;
}

export class NomadPerTableHud implements PerHud {
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly start: HTMLButtonElement;
  private readonly verifyPanel: HTMLElement;
  private readonly verifyTitle: HTMLElement;
  private readonly verifyBody: HTMLElement;

  constructor(_nomad: NomadHost, layer: HTMLElement, private readonly h: PerHudHandlers) {
    this.root = v2tLayer(layer, 30, 'per-table-hud');

    const bar = v2tEl('div', 'v2t-perbar', this.root);
    // Neutral, not "attested": attestation checks were removed on 9 Nov (worklog decision 30).
    v2tEl('span', 'v2t-pill', bar, 'TEE · MagicBlock');
    this.status = v2tEl('span', 'v2t-pill v2t-status', bar);
    this.status.hidden = true;
    v2tEl('span', 'v2t-pill sol', bar, 'ON-CHAIN · DEVNET');

    const btns = v2tEl('div', 'v2t-perbtns', this.root);
    v2tButton(btns, 'Verify hand', 'blue', () => this.toggleVerify(), 'w');
    this.start = v2tButton(btns, 'Start round', 'gold', () => this.h.onStart(), 'w');
    this.start.hidden = true;
    if (h.onBackToLobby) v2tButton(btns, 'Back to lobby', 'ghost', h.onBackToLobby, 'w');

    this.verifyPanel = v2tEl('div', 'v2t-panel v2t-verify', this.root);
    this.verifyTitle = v2tEl('b', 'v2t-h', this.verifyPanel);
    this.verifyBody = v2tEl('div', 'v2t-verify-body', this.verifyPanel);
    this.verifyPanel.hidden = true;
  }

  setStatus(s: string): void {
    const t = s.replace(/<[^>]+>/g, '');
    if (this.status.textContent !== t) this.status.textContent = t;
    this.status.title = t;
    this.status.hidden = !t;
  }

  showStart(on: boolean): void {
    this.start.hidden = !on;
  }

  private toggleVerify(): void {
    const show = this.verifyPanel.hidden;
    this.verifyPanel.hidden = !show;
    if (!show) return;
    const lines = this.h.onVerify().split('\n');
    this.verifyTitle.textContent = lines[0] ?? 'Verify';
    this.verifyBody.innerHTML = toRichHtml(lines.slice(1));
  }

  dispose(): void {
    this.root.remove();
  }
}

/** The Verify text with PerTableController's marks: OK green, FAIL orange, the footer small. */
function toRichHtml(lines: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return lines
    .map((line) => {
      if (line.startsWith('OK ')) return `<span class="ok"><b>✓ OK</b></span>${esc(line.slice(2))}`;
      if (line.startsWith('FAIL ') && /^FAIL (deck|button|the|your)/.test(line)) return `<span class="bad"><b>✗ FAIL</b></span>${esc(line.slice(4))}`;
      if (line.startsWith('FAIL ')) return `<span class="bad">${esc(line)}</span>`;
      if (line.startsWith('Table ')) return `<span class="ft">${esc(line)}</span>`;
      return esc(line);
    })
    .join('\n');
}
