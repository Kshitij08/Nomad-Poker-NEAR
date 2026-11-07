import { Clock, SRGBColorSpace, WebGLRenderer, type Object3D } from 'three';
import { ticker } from '../anim/tween';
import { buildTableScene, type TableScene } from '../three/tableScene';
import { CardModelVisual, preloadCardTextures } from '../three/cardModel';
import { createRiverSlam, type RiverSlamPlayer } from './riverSlam';
import { LensDistortionRenderer } from '../three/lensDistortion';
import { watchActivationSmoke } from '../three/impactSmoke';
import { PotTokens } from '../three/potTokens';
import { SplineCardDealer } from './splineCardDealer';
import { TableView, type PotHud } from './tableView';
import { createTableHud, type DomTableHud } from '../hud/tableHud';
import sceneData from '../data/unity-scene.json';

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
  readonly hud: DomTableHud;
  readonly slam: RiverSlamPlayer;
  readonly dealer: SplineCardDealer;
  readonly potTokens: PotTokens;
  readonly seatWorld: number[][];
  private paused: boolean;
  private visible = false;

  constructor(
    readonly stageEl: HTMLElement,
    canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
    opts: { paused?: boolean; speed?: number } = {},
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.table = buildTableScene();
    preloadCardTextures();
    this.lens = new LensDistortionRenderer(this.renderer);
    this.hud = createTableHud(hudRoot, this.table.camera);

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
    this.seatWorld = sceneData.splines.map((s) => s.seatRootWorldPosition);

    ticker.timeScale = opts.speed ?? 1;
    this.paused = !!opts.paused;
    window.addEventListener('resize', () => this.resize());
    this.resize();

    const clock = new Clock();
    this.renderer.setAnimationLoop(() => {
      const raw = Math.min(clock.getDelta(), 0.1);
      if (!this.paused) this.advance(raw);
      if (this.visible) this.render();
    });
    this.setVisible(false);
  }

  /** A fresh TableView for a new session; clears whatever the previous session left on the felt. */
  newView(): TableView {
    this.slam.stop();
    this.dealer.clear();
    const potTokens = this.potTokens;
    const hudPot = this.hud.pot;
    const seatWorld = this.seatWorld;
    const pot: PotHud = {
      setPot(value) {
        hudPot.setPot(value);
        potTokens.setPot(value);
      },
      setMessage(message) {
        hudPot.setMessage(message);
      },
      awardTokensTo(seat) {
        hudPot.awardTokensTo(seat);
        if (seatWorld[seat]) potTokens.awardTokensTo(seatWorld[seat]);
      },
    };
    return new TableView({ seats: this.hud.seats, betting: this.hud.betting, pot }, this.dealer, this.table.seatSplines);
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
    this.hud.update();
    this.lens.render(this.table.scene, this.table.camera);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.table.camera.aspect = w / h;
    this.table.camera.updateProjectionMatrix();
    this.hud.layout();
  }
}
