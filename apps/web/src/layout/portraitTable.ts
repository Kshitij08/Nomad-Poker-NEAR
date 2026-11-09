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
import { PortraitSeats } from './portraitSeats';
import { overlayScale } from './portraitRects';
import { PORTRAIT_ROW, PORTRAIT_TOP_ROW_Y } from './portraitHud';
import { PORTRAIT_LAYOUT as P, portraitCardSpot, SEAT_UNIT, STACKED_SEAT_BOX } from './portraitLayout';

/** Slot i is drawn in place of landscape slot (i + SHIFT) mod 8: a quarter of the oval, so slot 0 (you) is at the bottom. */
export const PORTRAIT_SLOT_SHIFT = 2;

/** Portrait screen coords (world units, x right / y up on screen) → Unity world: sx = −z, sy = x. */
const unityOf = (sx: number, sy: number, y: number): [number, number, number] => [sy, y, -sx];

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
  private readonly cardHome = new Map<Object3D, CardHome>();
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
   * Slot i's portrait splines: landscape slot (i+SHIFT)'s pair, each with a similarity about its start (the deck) —
   * a turn about Y and a uniform scale — that lands that card on its portrait spot (portraitLayout.ts: the pair side
   * by side, card 0 on the left).
   */
  private buildPortraitSplines(slot: number): SplineFields[] {
    const n = this.stage.table.seatSplines.length;
    const src = this.stage.table.seatSplines[(slot + PORTRAIT_SLOT_SHIFT) % n];
    return src.map((s, card) => {
      const start = s.evaluatePosition(0);
      const end = s.evaluatePosition(1);
      const spot = portraitCardSpot(slot, card);
      const target = unityOf(spot[0], spot[1], end.y);
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
   * inside each CardView gets a yaw about the card's normal that stands the card's long side up the screen, leaning
   * `lean` degrees out from the pair's middle. The yaw is solved each frame from the card's live pose, so it holds
   * for every seat's path, through the showdown flip and through the river-slam camera moves. Your own two cards
   * also grow to `ownCardScale` as they land.
   */
  private adjustCards(): void {
    const which = new Map<Object3D, { seat: number; card: number }>();
    if (this.portrait) {
      const index = new Map<unknown, { seat: number; card: number }>();
      this.stage.table.seatSplines.forEach((pair, seat) => pair.forEach((s, card) => index.set(s, { seat, card })));
      for (const cv of this.spawned()) {
        const at = index.get((cv as unknown as { spline: unknown }).spline);
        if (at) which.set(cv.transform, at);
      }
    }
    const live = new Set<Object3D>();
    for (const card of this.stage.dealer.dealtRoot.children) {
      const deck = card.children[0];
      if (!deck) continue;
      live.add(deck);
      let home = this.cardHome.get(deck);
      if (!home) {
        home = { p: deck.position.clone(), q: deck.quaternion.clone(), s: deck.scale.clone(), long: longAxisOf(deck), angle: 0 };
        this.cardHome.set(deck, home);
      }
      let angle = 0;
      let grow = 1;
      if (this.portrait) {
        const out = Math.hypot(card.position.x - DECK.x, card.position.z - DECK.z);
        const at = which.get(card);
        // 0 at the deck, 1 from about half way to the card's spot. Measured against that seat's own distance: the
        // side seats' spots are only ~1 unit from the deck, the top seat's ~7.
        const spot = at ? portraitCardSpot(at.seat, at.card) : null;
        const far = spot ? Math.max(0.5, Math.hypot(spot[1] - DECK.x, -spot[0] - DECK.z)) : 3.6;
        const wgt = MathUtils.smoothstep(out / far, 0.1, 0.6);
        const own = at?.seat === 0;
        const lean = MathUtils.degToRad(own ? P.ownLean : P.lean) * (at?.card === 1 ? -1 : 1);
        const solved = this.uprightYaw(card, home, Math.PI / 2 + lean);
        // Same orientation, nearest turn to last frame's: no full spins when the solution crosses ±180°.
        if (solved !== null) home.angle += wrapAngle(solved - home.angle);
        angle = home.angle * wgt;
        if (own) grow = 1 + (P.ownCardScale - 1) * MathUtils.smoothstep(out, 1, 3.2);
      }
      _yaw.setFromAxisAngle(Y_AXIS, angle);
      deck.quaternion.copy(_yaw).multiply(home.q);
      deck.position.copy(home.p).multiplyScalar(grow).applyQuaternion(_yaw);
      deck.scale.copy(home.s).multiplyScalar(grow);
    }
    for (const k of [...this.cardHome.keys()]) if (!live.has(k)) this.cardHome.delete(k);
  }

  /**
   * The yaw (about the card's own normal) that turns the card's long axis to screen angle `target` (radians, 0 = right,
   * π/2 = up). Null while the card is edge-on to the camera (mid-flip), where the angle is undefined: keep the last one.
   * Screen axes are the resting top-down camera's (three +x right, −z up), so a river-slam camera roll still rolls
   * the cards with the table.
   */
  private uprightYaw(card: Object3D, home: CardHome, target: number): number | null {
    card.updateWorldMatrix(true, false);
    const at = (yaw: number): number | null => {
      _yaw.setFromAxisAngle(Y_AXIS, yaw);
      _dir.copy(home.long).applyQuaternion(home.q).applyQuaternion(_yaw).transformDirection(card.matrixWorld);
      const x = _dir.dot(_right);
      const y = _dir.dot(_screenUp);
      return Math.hypot(x, y) < 0.35 ? null : Math.atan2(y, x);
    };
    const a0 = at(0);
    const a1 = at(0.1);
    if (a0 === null || a1 === null) return null;
    // Turning about the normal moves the projected axis with a sign that depends on which face is up (and the mirror).
    const sign = Math.sign(wrapAngle(a1 - a0)) || 1;
    return sign * wrapAngle(target - a0);
  }
}

interface CardHome {
  p: Vector3;
  q: Quaternion;
  s: Vector3;
  /** The card face's long axis in the deck group's own space. */
  long: Vector3;
  /** Last solved upright yaw (kept while the card is edge-on). */
  angle: number;
}

/** The card mesh's long side (its local y) expressed in the deck group's space. */
function longAxisOf(deck: Object3D): Vector3 {
  const mesh = deck.getObjectByName('CardMesh');
  const v = new Vector3(0, 1, 0);
  if (!mesh) return v;
  const m = new Matrix4();
  for (let o: Object3D | null = mesh; o && o !== deck; o = o.parent) {
    o.updateMatrix();
    m.premultiply(o.matrix);
  }
  // Include the deck's own scale (not its rotation, which `home.q` carries).
  return v.transformDirection(new Matrix4().makeScale(deck.scale.x, deck.scale.y, deck.scale.z).multiply(m));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const Y_AXIS = new Vector3(0, 1, 0);
const _yaw = new Quaternion();
const _dir = new Vector3();
const _right = new Vector3(1, 0, 0);
const _screenUp = new Vector3(0, 0, -1);
/** Spline start (the deck), Unity world x/z — every seat's splines start within ~0.1 of it. */
const DECK = { x: -0.33, z: 2.46 };
