/**
 * The portrait table (docs/portrait-design.md §Table). Unity's table is landscape-only; on a tall screen the web port
 * turns the whole Unity-space root a quarter turn so the oval's long axis runs down the screen, then:
 *
 *  - Seats: slot i takes the place of landscape slot i+2, so the local player (slot 0) sits at the bottom end with the
 *    same clockwise order. Each seat HUD is re-placed on a portrait grid (3 rows of side seats + top + bottom), drawn
 *    upright and larger than the 3D zoom, and stacked (portraitSeats.ts).
 *  - Deal splines: each slot's two splines are the landscape splines of slot i+2 with a similarity about their start
 *    (the deck) that lands the cards next to the re-placed seat. The spline *contents* are swapped in place, so every
 *    view holding them (offline, network, tournament, PER) follows; the paths, timing and easing are Unity's.
 *  - Dealt cards turn upright in their own plane as they leave the deck; your own two grow as they arrive.
 *  - Community slots: anchors re-place them in a left-to-right row (a bit larger) and undo the quarter turn, so the
 *    board and its Animator clips (reveal, withdrawal, river slam) look exactly as in landscape.
 *  - The pot pill and its 3D chip piles move above the board; the theme backdrop stays upright.
 *  - The whole table is scaled/offset to fit between the top chrome and the betting panel (safe areas included).
 *
 * Landscape restores every original value (identity anchors, original splines/positions) — nothing changes there.
 */
import { Group, MathUtils, Matrix3, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { TableStage } from '../table/tableStage';
import type { UnitySpline } from '../anim/unitySpline';
import { worldCanvasSpace } from './canvasSpace';
import { isPortrait, safeArea } from './orientation';
import { PortraitSeats, STACKED_SEAT_BOX } from './portraitSeats';
import { overlayScale } from './portraitRects';
import { PORTRAIT_ROW, PORTRAIT_TOP_ROW_Y } from './portraitHud';

/** Slot i is drawn in place of landscape slot (i + SHIFT) mod 8: a quarter of the oval, so slot 0 (you) is at the bottom. */
export const PORTRAIT_SLOT_SHIFT = 2;

/** Portrait screen coords (world units, x right / y up on screen) → Unity world: sx = −z, sy = x. */
const unityOf = (sx: number, sy: number, y: number): [number, number, number] => [sy, y, -sx];

type XY = [number, number];

/**
 * Layout of the turned table in portrait screen coords (world units before the fit zoom). Seat = avatar centre;
 * cards = where card 0 of the seat's hole cards lands.
 */
const P = {
  seats: [
    { avatar: [0, -5.5], cards: [0.05, -3.3] }, // 0 you (bottom)
    { avatar: [-3.25, -5.2], cards: [-2.45, -3.75] }, // 1 bottom-left
    { avatar: [-3.25, -0.7], cards: [-1.45, -0.15] }, // 2 left
    { avatar: [-3.25, 5.7], cards: [-1.6, 3.75] }, // 3 top-left
    { avatar: [0, 6.85], cards: [0.05, 3.7] }, // 4 top
    { avatar: [3.25, 5.7], cards: [1.7, 3.75] }, // 5 top-right
    { avatar: [3.25, -0.7], cards: [1.55, -0.15] }, // 6 right
    { avatar: [3.25, -5.2], cards: [2.55, -3.75] }, // 7 bottom-right
  ] as { avatar: XY; cards: XY }[],
  /** Community row: centre, spacing and size (landscape spacing is ~1.0). */
  board: { x: 0, y: 1.5, spacing: 1.2, scale: 1.2 },
  /** Pot pill (Pot_UI canvas, drawn at `scale` × the 3D zoom) and the chip piles (Token Parents) beside it. */
  pot: { x: 0.45, y: 2.8, scale: 0.95 },
  tokens: { x: -1.75, y: 2.8 },
  /** Seat HUD canvases are drawn this much larger than the 3D projection. */
  hudScale: 1.55,
  /** Your hole cards grow to this size as they land. */
  ownCardScale: 1.7,
};

/** Canvas units (portrait overlay reference) kept clear above and below the table: the top row and the action row. */
/** Canvas units the tournament banner adds under the top row (portrait.css). */
const TOURNAMENT_BANNER = 116;
const CLEAR = { top: PORTRAIT_TOP_ROW_Y + 40, bottom: PORTRAIT_ROW.y + PORTRAIT_ROW.h / 2 + 14 };

interface CardViewLike {
  alive: boolean;
  transform: Object3D;
  retargetSpline(s: UnitySpline | null): void;
}
type SplineFields = Record<string, unknown>;

const SEAT_UNIT = 0.0022457757; // Name_Canvas lossy scale (world units per canvas unit)

export class PortraitTable {
  private portrait = false;
  private readonly world: Object3D;
  private readonly splineSnap: SplineFields[][];
  private readonly portraitSplines: SplineFields[][];
  private readonly seatWorldSnap: number[][];
  private readonly anchors: Group[] = [];
  private readonly slotHome: Vector3[] = [];
  private readonly tokensHome: Vector3;
  private readonly landscapeWorld: Matrix4;
  private readonly seats: PortraitSeats;
  private worldVersion = 0;
  private bannerShown = false;
  /** Unity-space rotation that undoes the world's quarter turn (for the community slots). */
  private readonly counter = new Quaternion();
  private readonly cardHome = new Map<Object3D, { p: Vector3; q: Quaternion; s: Vector3 }>();
  /** Fit region (portrait coords), from the seat grid and the stacked seat box. */
  private readonly extent: { x0: number; x1: number; y0: number; y1: number };

  constructor(private readonly stage: TableStage) {
    this.world = stage.table.world;
    this.world.updateMatrix();
    this.landscapeWorld = this.world.matrix.clone();
    const splines = stage.table.seatSplines;
    // Own-property snapshots (UnitySpline keeps only data fields), so contents can be swapped in place.
    this.splineSnap = splines.map((pair) => pair.map((s) => ({ ...(s as unknown as SplineFields) })));
    this.portraitSplines = splines.map((_, i) => this.buildPortraitSplines(i));
    this.seatWorldSnap = stage.seatWorld.map((p) => [...p]);
    for (const slot of stage.table.slots) {
      const root = slot.root;
      const anchor = new Group();
      anchor.name = `PortraitAnchor_${root.name}`;
      root.parent!.add(anchor);
      anchor.add(root);
      this.anchors.push(anchor);
      this.slotHome.push(root.position.clone());
    }
    this.tokensHome = stage.potTokens.root.position.clone();
    this.seats = new PortraitSeats(stage.hud.seats);

    const u = SEAT_UNIT * P.hudScale;
    const b = STACKED_SEAT_BOX;
    const xs = P.seats.flatMap((s) => [s.avatar[0] + b.left * u, s.avatar[0] + b.right * u]);
    const ys = P.seats.flatMap((s, i) => [s.avatar[1] + b.top * u, s.avatar[1] + (i === 0 ? b.handBottom : b.bottom) * u]);
    this.extent = { x0: Math.min(...xs, -4.6) - 0.1, x1: Math.max(...xs, 4.6) + 0.1, y0: Math.min(...ys) - 0.05, y1: Math.max(...ys) + 0.05 };
  }

  get isPortrait(): boolean {
    return this.portrait;
  }

  /** On every resize: switch layouts when the orientation flipped, then refit. */
  apply(w: number, h: number): void {
    const p = isPortrait();
    if (p !== this.portrait) this.switchTo(p);
    if (p) this.fit(w, h);
  }

  /** Per rendered frame (before the HUD re-projects). */
  frame(): void {
    // The tournament banner (portrait.css drops it under the top row) or the PER status strip (portraitMenu.ts)
    // takes room from the table while it shows.
    const banner = this.portrait && document.querySelector('.trn-overlay:not(.trn-hidden), .per-table-hud') !== null;
    if (banner !== this.bannerShown) {
      this.bannerShown = banner;
      if (this.portrait) this.fit(window.innerWidth, window.innerHeight);
    }
    this.syncBackdrop();
    this.seats.frame();
    if (this.portrait || this.cardHome.size) this.adjustCards();
  }

  // ---------------------------------------------------------------- splines

  /**
   * Slot i's portrait splines: landscape slot (i+SHIFT)'s pair, with a similarity about card 0's start (the deck) —
   * a turn about Y and a uniform scale — that lands card 0 on the slot's portrait card spot.
   */
  private buildPortraitSplines(slot: number): SplineFields[] {
    const n = this.stage.table.seatSplines.length;
    const src = this.stage.table.seatSplines[(slot + PORTRAIT_SLOT_SHIFT) % n];
    const start = src[0].evaluatePosition(0);
    const end = src[0].evaluatePosition(1);
    const target = unityOf(P.seats[slot].cards[0], P.seats[slot].cards[1], end.y);
    const v0x = end.x - start.x;
    const v0z = end.z - start.z;
    const v1x = target[0] - start.x;
    const v1z = target[2] - start.z;
    // three's makeRotationY(θ) maps (x, z) → (x cosθ + z sinθ, −x sinθ + z cosθ): a turn of −θ in atan2(z, x) terms.
    const theta = -(Math.atan2(v1z, v1x) - Math.atan2(v0z, v0x));
    const k = Math.hypot(v1x, v1z) / Math.max(1e-6, Math.hypot(v0x, v0z));
    const sim = new Matrix4()
      .makeTranslation(start.x, start.y, start.z)
      .multiply(new Matrix4().makeRotationY(theta))
      .multiply(new Matrix4().makeScale(k, k, k))
      .multiply(new Matrix4().makeTranslation(-start.x, -start.y, -start.z));
    return src.map((s) => {
      const fields = { ...(s as unknown as SplineFields) };
      const world = sim.clone().multiply(s.world);
      const rot = new Quaternion();
      world.decompose(new Vector3(), rot, new Vector3());
      fields.world = world;
      fields.world3 = new Matrix3().setFromMatrix4(world);
      fields.worldRotation = rot;
      return fields;
    });
  }

  // ---------------------------------------------------------------- switching

  private switchTo(p: boolean): void {
    this.portrait = p;
    const { stage } = this;
    const n = stage.table.seatSplines.length;

    stage.table.seatSplines.forEach((pair, i) => {
      pair.forEach((s, k) => Object.assign(s as unknown as SplineFields, (p ? this.portraitSplines : this.splineSnap)[i][k]));
    });
    // Pot-fly targets: the re-placed avatars.
    stage.seatWorld.forEach((pos, i) => {
      const v = p ? unityOf(P.seats[i].avatar[0], P.seats[i].avatar[1], this.seatWorldSnap[i][1]) : this.seatWorldSnap[i];
      pos.splice(0, pos.length, ...v);
    });

    worldCanvasSpace.positions.clear();
    worldCanvasSpace.scales.clear();
    if (p) {
      stage.hud.seats.forEach((seat, i) => {
        const a = P.seats[i % n]?.avatar ?? [0, 0];
        worldCanvasSpace.positions.set(seat.canvas, unityOf(a[0], a[1], seat.canvas.position[1]));
      });
      const pot = stage.hud.pot.canvas;
      worldCanvasSpace.positions.set(pot, unityOf(P.pot.x, P.pot.y, pot.position[1]));
      worldCanvasSpace.scales.set(pot, P.pot.scale);
    }
    worldCanvasSpace.upright = p;
    worldCanvasSpace.hudScale = p ? P.hudScale : 1;
    this.seats.set(p);

    // Quarter turn about Y (three space); `counter` is its inverse expressed in Unity space (M·R⁻¹·M).
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), p ? Math.PI / 2 : 0);
    const mirror = new Matrix4().makeScale(1, 1, -1);
    const inv = new Matrix4().makeRotationFromQuaternion(turn.clone().invert());
    this.counter.setFromRotationMatrix(mirror.clone().multiply(inv).multiply(mirror));

    this.anchors.forEach((anchor, i) => {
      if (!p) {
        anchor.position.set(0, 0, 0);
        anchor.quaternion.identity();
        anchor.scale.set(1, 1, 1);
        return;
      }
      const home = this.slotHome[i];
      const t = new Vector3(...unityOf(P.board.x + (i - 2) * P.board.spacing, P.board.y, home.y));
      const sc = P.board.scale;
      new Matrix4()
        .makeTranslation(t.x, t.y, t.z)
        .multiply(new Matrix4().makeRotationFromQuaternion(this.counter))
        .multiply(new Matrix4().makeScale(sc, sc, sc))
        .multiply(new Matrix4().makeTranslation(-home.x, -home.y, -home.z))
        .decompose(anchor.position, anchor.quaternion, anchor.scale);
    });

    const tokens = stage.potTokens.root;
    if (p) tokens.position.set(...unityOf(P.tokens.x, P.tokens.y, this.tokensHome.y));
    else tokens.position.copy(this.tokensHome);

    this.world.quaternion.copy(turn);
    if (!p) {
      this.world.position.set(0, 0, 0);
      this.world.scale.set(1, 1, -1);
      this.commitWorld();
    }

    // Cards already on the felt jump to their seat's new spot (rotation mid-hand).
    for (const cv of this.spawned()) {
      const spline = (cv as unknown as { spline: UnitySpline | null }).spline;
      if (cv.alive && spline) cv.retargetSpline(spline);
    }
  }

  private spawned(): CardViewLike[] {
    return (this.stage.dealer as unknown as { spawned?: CardViewLike[] }).spawned ?? [];
  }

  // ---------------------------------------------------------------- fit

  /** Scales and offsets the turned table into the space between the top chrome and the betting panel. */
  private fit(w: number, h: number): void {
    const cam = this.stage.table.camera;
    const safe = safeArea();
    const os = overlayScale(w, h);
    const top = safe.top + (CLEAR.top + (this.bannerShown ? TOURNAMENT_BANNER : 0)) * os;
    const bottom = h - safe.bottom - CLEAR.bottom * os;
    const left = safe.left + 2;
    const right = w - safe.right - 2;
    const rectW = Math.max(50, right - left);
    const rectH = Math.max(50, bottom - top);
    const e = this.extent;
    const ex = e.x1 - e.x0;
    const ey = e.y1 - e.y0;
    const cx = (e.x0 + e.x1) / 2;
    const cy = (e.y0 + e.y1) / 2;
    // Pixels per world unit at depth D: F / D, F = (H/2) / tan(fov/2). Depth taken at the seat height.
    const F = h / 2 / Math.tan(MathUtils.degToRad(cam.fov) / 2);
    const camY = cam.position.y;
    const k = Math.min(rectW / ex, rectH / ey);
    const yRef = 0.9;
    const s = (camY * k) / (F + yRef * k);
    const D = camY - yRef * s;
    const tx = (((left + right) / 2 - w / 2) * D) / F - s * cx;
    const tz = (((top + bottom) / 2 - h / 2) * D) / F + s * cy + cam.position.z;
    this.world.position.set(tx, 0, tz);
    this.world.scale.set(s, s, -s);
    this.commitWorld();
  }

  private commitWorld(): void {
    this.world.updateMatrix();
    this.world.updateMatrixWorld(true);
    worldCanvasSpace.matrix.copy(this.world.matrixWorld);
    this.worldVersion++;
  }

  // ---------------------------------------------------------------- per frame

  /** The theme backdrop (created lazily inside the world) keeps its landscape three-space pose: upright, unscaled. */
  private syncBackdrop(): void {
    const bd = this.world.getObjectByName('Background/Background_Image');
    if (!bd) return;
    const ud = bd.userData as { portraitHome?: Matrix4; portraitVersion?: number };
    if (!ud.portraitHome) ud.portraitHome = bd.matrix.clone();
    if (ud.portraitVersion === this.worldVersion) return;
    ud.portraitVersion = this.worldVersion;
    const inv = this.world.matrix.clone().invert();
    bd.matrix.copy(inv.multiply(this.landscapeWorld).multiply(ud.portraitHome));
    bd.matrixWorldNeedsUpdate = true;
  }

  /**
   * Dealt cards turn upright in their own plane as they leave the deck (and back as they return): the deck group
   * inside each CardView gets a yaw about the card's normal (sign follows the face — the normal flips with the card).
   * Your own two cards also grow to `ownCardScale` as they land.
   */
  private adjustCards(): void {
    const own = new Set<Object3D>();
    const ownSplines = this.stage.table.seatSplines[0] as readonly UnitySpline[];
    for (const cv of this.spawned()) {
      if ((ownSplines as unknown[]).includes((cv as unknown as { spline: unknown }).spline)) own.add(cv.transform);
    }
    const live = new Set<Object3D>();
    for (const card of this.stage.dealer.dealtRoot.children) {
      const deck = card.children[0];
      if (!deck) continue;
      live.add(deck);
      let home = this.cardHome.get(deck);
      if (!home) this.cardHome.set(deck, (home = { p: deck.position.clone(), q: deck.quaternion.clone(), s: deck.scale.clone() }));
      let angle = 0;
      let grow = 1;
      if (this.portrait) {
        // 0 at the deck, 1 once the card is ~2 units out (every seat's spline end is 3–7 units away).
        const wgt = MathUtils.smoothstep(Math.hypot(card.position.x - DECK.x, card.position.z - DECK.z), 0.4, 2.2);
        _up.set(0, 1, 0).applyQuaternion(card.quaternion);
        angle = (_up.y >= 0 ? 1 : -1) * CARD_TURN * wgt;
        if (own.has(card)) grow = 1 + (P.ownCardScale - 1) * MathUtils.smoothstep(Math.hypot(card.position.x - DECK.x, card.position.z - DECK.z), 2, 5);
      }
      _yaw.setFromAxisAngle(Y_AXIS, angle);
      deck.quaternion.copy(_yaw).multiply(home.q);
      deck.position.copy(home.p).multiplyScalar(grow).applyQuaternion(_yaw);
      deck.scale.copy(home.s).multiplyScalar(grow);
    }
    for (const k of [...this.cardHome.keys()]) if (!live.has(k)) this.cardHome.delete(k);
  }
}

const Y_AXIS = new Vector3(0, 1, 0);
const _up = new Vector3();
const _yaw = new Quaternion();
/** Spline start (the deck), Unity world x/z — every seat's splines start within ~0.1 of it. */
const DECK = { x: -0.33, z: 2.46 };
/** Quarter turn for a face-down card (Unity space, about the card's own normal). */
const CARD_TURN = Math.PI / 2;
