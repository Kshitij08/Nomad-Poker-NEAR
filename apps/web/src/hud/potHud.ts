/**
 * The pot pill (`Pot_UI.prefab`, world space), port of Game/Views/PotView.cs's readout. `messageText` is not wired in
 * Test.unity, so messages are kept (for debugging: `lastMessage`) but never drawn; the hover panel is switched off
 * every second by NomadTableHud, so it is not built. The 3D token piles and their win fly belong to the 3D scene:
 * `awardTokensTo` forwards to `onAwardTokens` for whoever owns them.
 */
import { TableMoney } from '@nomad/engine';
import type { PotHud } from '../table/tableView';
import { buildNode, type CanvasData, type UNode } from './unityUi';
import { WorldCanvas } from './worldCanvas';

export class PotHudView implements PotHud {
  readonly root: UNode;
  readonly canvas: WorldCanvas;
  private readonly text: UNode;
  lastMessage = '';
  pot = 0;
  /** Hook for the 3D pot tokens: fly every visible token to `seat` (PotView.AwardTokensTo, 0.6 s InQuad, 0.05 s stagger). */
  onAwardTokens: ((seat: number) => void) | null = null;

  constructor(data: CanvasData, parent: HTMLElement) {
    this.root = buildNode(data.root, { skip: (n) => n.name === 'HoverPanel' });
    this.root.el.classList.add('u-pot', 'v2-pot');
    parent.append(this.root.el);
    const t = this.root.find('Graphics/bar/Text (TMP)');
    if (!t) throw new Error('Pot_UI text missing');
    this.text = t;
    // v2 pot pill (hud/v2hud.css): Lilita gold amount under a small "Pot" caption.
    if (t.text) {
      t.text.family = "'Fredoka', 'Arial Rounded MT Bold', system-ui, sans-serif";
      t.text.bold = false;
    }
    const w = data.world!;
    this.canvas = new WorldCanvas(this.root, w.position, w.scale[0]);
    this.root.layout();
    this.setPot(0); // PotView.Awake → SetPot(0): the authored "$0" placeholder never shows
  }

  setPot(pot: number): void {
    this.pot = pot;
    this.text.setText(TableMoney.pot(pot));
    // v2: no "0" pill before the blinds or after the award.
    this.root.el.classList.toggle('v2-empty', !(pot > 0));
  }

  setMessage(message: string): void {
    this.lastMessage = message ?? '';
  }

  awardTokensTo(seat: number): void {
    this.onAwardTokens?.(seat);
  }
}
