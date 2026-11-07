/**
 * PerTableController.BuildHud in the Nomad look (the menu's NomadDialogs pieces, as Unity builds it):
 *  - the status strip: NomadDialogs.NewImage "Status" (0.03, 0.05, 0.18, 0.82), anchors 0.24–0.76 × 0.86–0.935,
 *    NomadDialogs.Round; a row with the TEE badge (flex 0.55, left) and the status (flex 1.45, centre), auto-size
 *    12–22, ellipsis, the Nomad font;
 *  - Verify hand (blue) and Start round (yellow) as NomadDialogs.Button, width 250, pinned to the top-right corner at
 *    (−150, −250) / (−150, −345); Back to lobby (blue) at (−150, −440) at a tournament table;
 *  - the Verify panel: PerUi.Box "Verify" in PerUi.Panel (0.07, 0.09, 0.12, 0.96), anchors 0.55–0.98 × 0.12–0.78, a
 *    padded column of TMP rich text (size 20).
 * The canvas uses CanvasScaler Expand, like the menu's (ScreenCanvas).
 */
import type { NomadHost } from '../../menu/host';
import { make, ScreenCanvas, setOffsets, synth, imageComp } from '../../menu/ui/canvas';
import type { UNode } from '../../hud/unityUi';
import type { AttestReport } from '../per/attestation';

export interface PerHudHandlers {
  onVerify: () => string;
  onStart: () => void;
  onBackToLobby: (() => void) | null;
}

/** What the controller drives (DOM fallback in perTableController.ts when the menu isn't installed). */
export interface PerHud {
  setStatus(s: string): void;
  setAttestation(r: AttestReport): void;
  showStart(on: boolean): void;
  dispose(): void;
}

const col = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const GOOD = '#5ed39b';
const BAD = '#e0915f';

export class NomadPerTableHud implements PerHud {
  private readonly holder = document.createElement('div');
  private readonly canvas: ScreenCanvas;
  private readonly badge: UNode;
  private readonly status: UNode;
  private readonly start: UNode;
  private readonly verifyPanel: UNode;
  private verifyText: UNode | null = null;

  constructor(nomad: NomadHost, layer: HTMLElement, private readonly h: PerHudHandlers) {
    const d = nomad.dialogs;
    this.holder.className = 'nm-layer per-table-hud';
    this.holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:30';
    layer.append(this.holder);
    const root = make(null, synth('PerTableHud', { rect: { anchorMin: [0, 0], anchorMax: [1, 1], sizeDelta: [0, 0] } }));
    root.el.style.pointerEvents = 'none';
    this.canvas = new ScreenCanvas(this.holder, root);

    const strip = make(root, synth('Status', { components: { image: imageComp(col(0.03, 0.05, 0.18, 0.82), null, 'Simple', 1, false) } }));
    strip.anchorMin = [0.24, 0.86];
    strip.anchorMax = [0.76, 0.935];
    setOffsets(strip, [0, 0], [0, 0]);
    d.round(strip);
    // The row (PerUi.Line inside the strip, 16 px side padding): badge 0.55, status 1.45 of the width.
    root.layout();
    const inner = () => (strip.w > 64 ? strip.w - 32 : 966);
    this.badge = d.line(strip, '<b>TEE: checking…</b>', 20, [0, 0], [100, 70], col(1, 1, 1), 'left');
    this.status = d.line(strip, '', 21, [0, 0], [100, 70], col(1, 1, 1), 'center');
    const place = () => {
      const w = inner();
      const bw = (w * 0.55) / 2;
      const sw = (w * 1.45) / 2;
      this.badge.sizeDelta = [bw, 70];
      this.badge.anchoredPosition = [-w / 2 + bw / 2, 0];
      this.status.sizeDelta = [sw, 70];
      this.status.anchoredPosition = [-w / 2 + bw + sw / 2, 0];
      this.badge.layout();
      this.status.layout();
    };
    place();
    window.addEventListener('resize', place);
    this.disposers.push(() => window.removeEventListener('resize', place));

    const corner = (n: UNode, y: number) => {
      n.anchorMin = n.anchorMax = [1, 1];
      n.anchoredPosition = [-150, y];
      n.el.style.pointerEvents = 'auto';
      n.layout();
    };
    corner(d.button(root, 'Verify hand', false, [0, 0], () => this.toggleVerify(), 250), -250);
    this.start = d.button(root, 'Start round', true, [0, 0], () => this.h.onStart(), 250);
    corner(this.start, -345);
    this.start.setActive(false);
    if (h.onBackToLobby) corner(d.button(root, 'Back to lobby', false, [0, 0], h.onBackToLobby, 250), -440);

    // Below the HUD bar, so its own button can close it again.
    // Under the corner buttons (index 1, right after the strip) so Verify hand can close it again.
    this.verifyPanel = make(root, synth('Verify', { components: { image: imageComp(col(0.07, 0.09, 0.12, 0.96)) } }), 1);
    this.verifyPanel.anchorMin = [0.55, 0.12];
    this.verifyPanel.anchorMax = [0.98, 0.78];
    setOffsets(this.verifyPanel, [0, 0], [0, 0]);
    this.verifyPanel.el.style.pointerEvents = 'auto';
    this.verifyPanel.setActive(false);
    root.layout();
  }

  private readonly disposers: (() => void)[] = [];

  setStatus(s: string): void {
    this.status.setText(s);
  }

  setAttestation(r: AttestReport): void {
    // A genuine, up-to-date Intel TDX enclave running the pinned image with the pinned key (not that this RPC is it).
    let t = r.ok ? `<color=${GOOD}><b>TEE image attested</b></color>` : `<color=${BAD}><b>TEE not attested</b></color>`;
    const failed = r.checks.find((c) => !c.ok);
    if (!r.ok && failed) t += ` <size=70%>(${escapeTmp(failed.name)})</size>`;
    this.badge.setText(t);
  }

  showStart(on: boolean): void {
    if (this.start.activeSelf !== on) this.start.setActive(on);
  }

  private toggleVerify(): void {
    const show = !this.verifyPanel.activeSelf;
    this.verifyPanel.setActive(show);
    if (!show) return;
    this.verifyText?.el.remove();
    // PerUi.Column(_verifyPanel, …, 6, 20) + PerUi.Text(col, sb, 20).
    const t = make(this.verifyPanel, synth('Text', { components: { image: undefined } }));
    t.anchorMin = [0, 0];
    t.anchorMax = [1, 1];
    setOffsets(t, [20, 20], [-20, -20]);
    const font = getComputedStyle(this.status.el.querySelector('*') ?? this.status.el).fontFamily;
    t.el.style.cssText += `;overflow:auto;white-space:pre-wrap;color:#fff;font-size:20px;line-height:1.3;font-family:${font}`;
    t.el.innerHTML = toRichHtml(this.h.onVerify());
    this.verifyText = t;
    this.verifyPanel.layout();
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.canvas.dispose();
    this.holder.remove();
  }
}

const escapeTmp = (s: string) => s.replace(/</g, '‹');

/** The Verify text with PerTableController's marks: OK green, FAIL orange, the first line bold, the footer small. */
function toRichHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split('\n')
    .map((line, i) => {
      if (i === 0) return `<b>${esc(line)}</b>`;
      if (line.startsWith('OK ')) return `<span style="color:${GOOD}"><b>OK</b></span>${esc(line.slice(2))}`;
      if (line.startsWith('FAIL ') && line.indexOf(' ', 5) > 0 && /^FAIL (deck|button|the|your)/.test(line)) return `<span style="color:${BAD}"><b>FAIL</b></span>${esc(line.slice(4))}`;
      if (line.startsWith('FAIL ')) return `<span style="color:${BAD}">${esc(line)}</span>`;
      if (line.startsWith('Table ')) return `<span style="font-size:80%">${esc(line)}</span>`;
      return esc(line);
    })
    .join('\n');
}
