/**
 * The table HUD (seat panels, pot readout, betting + raise panel) as HTML over the three.js canvas, built from the
 * Unity scene data (data/unity-hud.json, data/ui-anims.json). Replaces the temporary debug HUD.
 *
 *   const hud = createTableHud(document.getElementById('hud')!, table.camera);
 *   new TableView(hud, dealer, table.seatSplines);
 *   window resize → hud.layout();  every rendered frame → hud.update() (re-projects the world-space canvases, so
 *   camera shake / zoom move the seat and pot HUDs with the table).
 *
 * River slam hook: `hud.shakeSeats(2, 20, 6)` (or `hud.seats[i].shake(...)`) wobbles every seat name tag like the
 * MMRotationShaker on channel 1 — see worldCanvas.ts Shaker.
 */
import type { PerspectiveCamera } from 'three';
import type { TableHud } from '../table/tableView';
import { BettingPanelView } from './bettingPanel';
import { PotHudView } from './potHud';
import { SeatHudView } from './seatHud';
import { HUD_DATA, whenFontsReady } from './unityUi';
import './hud.css';

export interface DomTableHud extends TableHud {
  readonly seats: SeatHudView[];
  readonly pot: PotHudView;
  readonly betting: BettingPanelView;
  /** Viewport changed: re-run the overlay CanvasScaler and re-project the world canvases. */
  layout(): void;
  /** Per frame: re-project the world-space canvases from the live camera (cheap: 3 projections per canvas). */
  update(): void;
  /**
   * River-slam name-tag rotation shake on every visible seat. amplitudeDegrees = MMRotationShaker range (the river
   * feedback uses 20), frequency in Hz, axis in canvas space ([0,0,1] = spin in the table plane, default).
   */
  shakeSeats(durationSeconds: number, amplitudeDegrees: number, frequency: number, axis?: [number, number, number]): void;
  /** The screen-space overlay layer (betting / confirm panels); hudDepth.ts inserts its 3D overlay just below it. */
  readonly screenLayer: HTMLElement;
}

export function createTableHud(root: HTMLElement, camera: PerspectiveCamera): DomTableHud {
  root.classList.add('u-hud');
  // Draw order: the pot canvas lies lower (y 0.41) than the seat canvases (y 0.92), then the screen overlay on top.
  const worldLayer = document.createElement('div');
  worldLayer.className = 'u-layer';
  const screenLayer = document.createElement('div');
  screenLayer.className = 'u-layer';
  root.append(worldLayer, screenLayer);

  const potData = HUD_DATA.canvases.find((c) => c.role === 'pot')!;
  const pot = new PotHudView(potData, worldLayer);
  const seats = HUD_DATA.canvases
    .filter((c) => c.role === 'seat')
    .sort((a, b) => (a.seatSlot ?? 0) - (b.seatSlot ?? 0))
    .map((c) => new SeatHudView(c, worldLayer));
  const betting = new BettingPanelView(screenLayer);
  whenFontsReady([pot.root, ...seats.map((s) => s.root), betting.root]);

  const update = () => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    camera.updateMatrixWorld();
    pot.canvas.update(camera, w, h);
    for (const s of seats) if (s.visible) s.canvas.update(camera, w, h);
  };

  return {
    screenLayer,
    seats,
    pot,
    betting,
    layout() {
      betting.layout(root.clientWidth, root.clientHeight);
      for (const s of seats) s.canvas.update(camera, root.clientWidth, root.clientHeight);
      update();
    },
    update,
    shakeSeats(durationSeconds, amplitudeDegrees, frequency, axis) {
      for (const s of seats) if (s.visible) s.shake(durationSeconds, amplitudeDegrees, frequency, axis);
    },
  };
}
