import { Box3, SRGBColorSpace, Vector3, WebGLRenderer, type Mesh, type Object3D } from 'three';
import { ticker } from '../anim/tween';
import { buildTableScene, type TableScene } from '../three/tableScene';
import { CardModelVisual, preloadCardTextures } from '../three/cardModel';
import { createRiverSlam, type RiverSlamPlayer } from './riverSlam';
import { LensDistortionRenderer } from '../three/lensDistortion';
import { HudDepthCompositor } from '../three/hudDepth';
import { watchActivationSmoke } from '../three/impactSmoke';
import { PotTokens } from '../three/potTokens';
import { SplineCardDealer } from './splineCardDealer';
import { TableView, type PotHud } from './tableView';
import { createTableHud, type DomTableHud } from '../hud/tableHud';
import sceneData from '../data/unity-scene.json';
import { PortraitTable } from '../layout/portraitTable';
import { onOrientation } from '../layout/orientation';

/**
 * The persistent 3D table (Test.unity): renderer, scene, card dealer, pot tokens, river slam and the HUD.
 * Built once and kept for the app's lifetime — Unity keeps the table scene loaded the same way — so
 * returning to the table is instant. A session (offline engine, network client, tournament) gets a fresh
 * TableView over it via newView().
 */
export class TableStage {
  readonly renderer: WebGLRenderer;
  readonly table: TableScene;
  readonly lens: LensDistortionRenderer;
  /** Unity-style depth sorting of the world-space HUD against the 3D cards / tokens (three/hudDepth.ts). */
  readonly hudDepth: HudDepthCompositor;
  readonly hud: DomTableHud;
  readonly slam: RiverSlamPlayer;
  readonly dealer: SplineCardDealer;
  readonly potTokens: PotTokens;
  readonly seatWorld: number[][];
  /** Portrait layout of the table (src/layout/portraitTable.ts); identity in landscape. */
  readonly portrait: PortraitTable;
  private paused: boolean;
  private visible = false;

  constructor(
    readonly stageEl: HTMLElement,
    canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
    opts: { paused?: boolean; speed?: number } = {},
  ) {
    // alpha: the HUD depth overlay (hudDepth.ts) is copied out of this context with a transparent clear; the base
    // pass still clears to the opaque scene background.
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Phones (small viewports, 3× screens) render at up to 3× so card faces stay as crisp as the HUD; bigger screens cap
    // at 2× for performance.
    const small = Math.min(window.innerWidth, window.innerHeight) <= 500;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 3 : 2));
    this.table = buildTableScene();
    preloadCardTextures();
    this.lens = new LensDistortionRenderer(this.renderer);
    this.hud = createTableHud(hudRoot, this.table.camera);
    // Where each slot's hole cards land on screen: the midpoint of its two deal splines' ends (landscape seats are
    // nudged so every seat shows its cards by the same margin, hud/tableHud.ts).
    const anchorTmp = new Vector3();
    this.hud.cardAnchor = (slot, w, h) => {
      const pair = this.table.seatSplines[slot];
      if (!pair) return null;
      const a = pair[0].evaluatePosition(1);
      const b = pair[1].evaluatePosition(1);
      anchorTmp.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      this.table.world.localToWorld(anchorTmp);
      this.table.camera.updateMatrixWorld();
      anchorTmp.project(this.table.camera);
      return [((anchorTmp.x + 1) / 2) * w, ((1 - anchorTmp.y) / 2) * h];
    };
    // The pot pill lies under every card: its depth goes down to just above the felt, so a card rising out of the
    // shoe or flying past is never cut by it (seat HUDs keep their own height, Unity's sorting).
    const felt = this.table.world.getObjectByName('Table_Canvas/Image');
    const feltPos = new Vector3();
    this.hudDepth = new HudDepthCompositor(this.renderer, () => [
      ...this.hud.seats.map((s) => ({ canvas: s.canvas, visible: s.visible })),
    ]);
    this.hudDepth.floor = () => {
      if (!felt) return null;
      const rects: DOMRect[] = [];
      const pill = this.hud.pot.root.el.querySelector<HTMLElement>('[data-name="bar"]');
      if (pill && getComputedStyle(this.hud.pot.root.el).visibility !== 'hidden') rects.push(pill.getBoundingClientRect());
      for (const el of (this.hud.screenLayer.parentElement ?? document).querySelectorAll<HTMLElement>('.v2-betchip:not([hidden]), .v2-potchips:not([hidden])')) rects.push(el.getBoundingClientRect());
      return { rects, y: felt.getWorldPosition(feltPos).y + 0.02 };
    };
    this.hud.screenLayer.before(this.hudDepth.overlay);

    let dealtRoot: { children: readonly Object3D[] } | null = null;
    this.slam = createRiverSlam({
      camera: this.table.camera,
      slotRoots: this.table.slots.map((s) => s.root),
      getHoleCards: () => dealtRoot?.children ?? [],
      world: this.table.world,
      lens: this.lens,
      onNameTagShake: (shake) => {
        if (shake.kind !== 'rotation') return;
        this.hud.seats.forEach((seat, i) => {
          if (!seat.visible) return;
          shake.play(`seat${i}`, (off) => {
            seat.canvas.eulerOffset = off.x || off.y || off.z ? { x: off.x, y: off.y, z: off.z } : null;
          });
        });
      },
    });
    this.dealer = new SplineCardDealer(this.table.world, () => new CardModelVisual(), this.table.slots, this.slam, {
      dealSpeed: this.table.dealer.dealSpeed,
      holeStagger: this.table.dealer.holeStagger,
      cardOptions: this.table.cardOptions,
    });
    dealtRoot = this.dealer.dealtRoot;
    const smokeNode = this.table.slots[3]?.root.getObjectByName('VFX_Impact_Smoke');
    if (smokeNode) watchActivationSmoke(smokeNode);

    this.potTokens = new PotTokens(this.table.world);
    // Hidden: the pot is drawn as a chip stack in the HUD (hud/betChips.ts); the piles stay built for the portrait code.
    this.potTokens.root.visible = false;
    this.seatWorld = sceneData.splines.map((s) => s.seatRootWorldPosition);
    this.portrait = new PortraitTable(this);
    // Landscape side seats' hole cards land beside their plates (hud/tableHud.ts placeCards).
    this.hud.onCardSpot = (slot, at) => this.portrait.setCardSpot(slot, at);

    // Bet chips keep clear of the dealt cards and the shoe (besides the seats and the pot pill): their screen boxes.
    const box = new Box3();
    const corner = new Vector3();
    const screenRect = (obj: Object3D, origin: DOMRect): DOMRect | null => {
      box.setFromObject(obj);
      if (box.isEmpty()) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        corner.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).project(this.table.camera);
        const px = ((corner.x + 1) / 2) * origin.width;
        const py = ((1 - corner.y) / 2) * origin.height;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      return new DOMRect(origin.left + x0, origin.top + y0, x1 - x0, y1 - y0);
    };
    // A landed card's own four corners on screen (its world box is far bigger: the cards lean toward the camera).
    const cardRect = (card: Object3D, origin: DOMRect): DOMRect | null => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      card.updateWorldMatrix(true, true);
      card.traverse((o) => {
        const g = (o as Mesh).isMesh ? (o as Mesh).geometry : null;
        if (!g || !o.visible) return;
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox!;
        for (let k = 0; k < 8; k++) {
          corner.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld).project(this.table.camera);
          const px = ((corner.x + 1) / 2) * origin.width;
          const py = ((1 - corner.y) / 2) * origin.height;
          x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        }
      });
      return x1 > x0 ? new DOMRect(origin.left + x0, origin.top + y0, x1 - x0, y1 - y0) : null;
    };
    this.hud.cardRects = (slot) => {
      const origin = canvas.getBoundingClientRect();
      return this.portrait.landedCards(slot).flatMap((c) => cardRect(c, origin) ?? []);
    };
    const shoe = this.table.world.getObjectByName('DealerSlot') ?? null;
    this.hud.chipObstacles = (cards) => {
      const origin = canvas.getBoundingClientRect();
      const out: DOMRect[] = [];
      for (const card of cards ? this.dealer.dealtRoot.children : []) {
        if (!card.visible) continue;
        const r = screenRect(card, origin);
        if (r) out.push(r);
      }
      if (shoe?.visible) {
        const r = screenRect(shoe, origin);
        if (r) out.push(r);
      }
      return out;
    };

    ticker.timeScale = opts.speed ?? 1;
    this.paused = !!opts.paused;
    window.addEventListener('resize', () => this.resize());
    // iOS reports the new size late after a rotation (layout/orientation.ts re-checks at 120 / 400 ms), and the visual
    // viewport can change without a window resize: refit on both so the table never stays sized for the old way up.
    onOrientation(() => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    this.resize();

    // One clock for both drivers: animation frames while the tab is visible, and a timer fallback when the
    // browser stops sending frames (background tab / hidden pane), so game time — engine waits, turn timers,
    // the network client's pacing — keeps running like Unity's runInBackground. Frames are clamped to 0.1 s;
    // long gaps are replayed in 0.1 s steps so tween and event order stay intact.
    let last = performance.now();
    const tick = (render: boolean) => {
      const now = performance.now();
      let gap = (now - last) / 1000;
      last = now;
      if (!this.paused) {
        gap = Math.min(gap, 5);
        while (gap > 0) {
          const dt = Math.min(gap, 0.1);
          this.advance(dt);
          gap -= dt;
        }
      }
      if (render && this.visible) this.render();
    };
    this.renderer.setAnimationLoop(() => tick(true));
    setInterval(() => {
      if (performance.now() - last > 250) tick(false);
    }, 250);
    this.setVisible(false);
  }

  /** A fresh TableView for a new session; clears whatever the previous session left on the felt. */
  newView(): TableView {
    this.slam.stop();
    this.dealer.clear();
    const chips = this.hud.chips;
    const hudPot = this.hud.pot;
    // The pot's chips are a grouped stack beside the pot pill (betChips.ts), not the 3D token piles.
    const pot: PotHud = {
      setPot(value) {
        hudPot.setPot(value);
        chips.setPot(value);
      },
      setMessage(message) {
        hudPot.setMessage(message);
      },
      awardTokensTo(seat) {
        hudPot.awardTokensTo(seat);
        chips.awardTo(seat);
      },
    };
    // Single player: seats spread evenly round the table, you (seat 0) at the bottom.
    this.portrait.setRing([]);
    return new TableView({ seats: this.hud.seats, betting: this.hud.betting, pot }, this.dealer, this.table.seatSplines, {
      spread: true,
      anchorSeat: 0,
      onRing: (ring) => this.portrait.setRing(ring),
    });
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.stageEl.style.display = v ? '' : 'none';
    if (v) this.resize();
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  /** Advances everything by `dt` seconds of real time (ticker scales it). */
  advance(dt: number): void {
    ticker.update(dt);
    this.table.update(dt * ticker.timeScale);
  }

  /** Fixed 1/60 s steps (with ?paused=1, for frame inspection). */
  step(seconds: number): void {
    const frames = Math.round(seconds * 60);
    for (let i = 0; i < frames; i++) this.advance(1 / 60);
    this.render();
  }

  render(): void {
    this.portrait.frame();
    this.hud.update();
    this.hudDepth.render(this.table.scene, this.table.camera, this.lens);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.table.camera.aspect = w / h;
    this.table.camera.updateProjectionMatrix();
    this.portrait?.apply(w, h);
    this.hud.layout();
  }
}
