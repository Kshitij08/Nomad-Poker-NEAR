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
import { UnitySpline } from '../anim/unitySpline';
import { worldCanvasSpace } from './canvasSpace';
import { isPortrait, safeArea } from './orientation';
import { PortraitSeats } from './portraitSeats';
import { overlayScale } from './portraitRects';
import { PORTRAIT_ROW, PORTRAIT_TOP_ROW_Y } from './portraitHud';
import { PORTRAIT_LAYOUT as P, portraitCardSpot, SEAT_UNIT, STACKED_SEAT_BOX } from './portraitLayout';
import { dealCrossings } from '../three/tableScene';

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
  pathProgress: number;
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
  /** Exact ring place of each slot's player (seatSpread.ts spreadRing); null / whole = the slot's own place. */
  private ring: (number | null)[] = [];
  /** Landscape: the seat canvases' authored places and the oval's centre (Unity x, z) they sit round. */
  private readonly canvasHome: [number, number, number][];
  private readonly ringCentre: { x: number; z: number };
  /** The shoe (deck opening on the felt) and its landscape pose. */
  private readonly shoe: Object3D | null;
  private readonly shoeHome: { p: Vector3; q: Quaternion } | null;

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
    // Landscape: the chip piles sit left of the v2 pot pill (Unity's spot is under the pill's wider left edge).
    this.tokensHome = stage.potTokens.root.position.clone();
    this.tokensHome.x += LANDSCAPE_TOKENS_DX;
    stage.potTokens.root.position.copy(this.tokensHome);
    this.seats = new PortraitSeats(stage.hud.seats);
    this.shoe = stage.table.world.getObjectByName('DealerSlot') ?? null;
    this.shoeHome = this.shoe ? { p: this.shoe.position.clone(), q: this.shoe.quaternion.clone() } : null;
    this.canvasHome = stage.hud.seats.map((seat) => [...seat.canvas.position] as [number, number, number]);
    const homes = this.canvasHome.length ? this.canvasHome : [[0, 0, 0] as [number, number, number]];
    this.ringCentre = { x: homes.reduce((a, p) => a + p[0], 0) / homes.length, z: homes.reduce((a, p) => a + p[2], 0) / homes.length };

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
   * Slot i's portrait splines. Unity's deal is one stream: every card leaves the deck, swirls once round the table with
   * the others and peels off to its seat. The world's quarter turn already turns that swirl with the table, so slot i
   * keeps landscape slot (i+SHIFT)'s own path, only
   *  - squeezed about the table centre to fit a phone's width (`SWIRL`), the same for every path, so the cards still
   *    travel together, and
   *  - with its last stretch bent smoothly onto the card's portrait spot (portraitLayout.ts), knots weighted by how far
   *    along the path they are.
   * The paths are rebuilt in Unity world space (identity container) from the landscape knots.
   */
  private buildPortraitSplines(slot: number): SplineFields[] {
    const n = this.stage.table.seatSplines.length;
    const src = this.stage.table.seatSplines[(slot + PORTRAIT_SLOT_SHIFT) % n];
    // Card 1 (right) lands a little higher than card 0, so it draws on top and both corner indices show.
    const low = Math.min(LANDED_MAX_Y, ...src.map((s) => s.evaluatePosition(1).y));
    return src.map((s, card) => {
      const spot = portraitCardSpot(slot, card);
      return { ...(portraitPath(s, spot, low + card * 0.03, [P.shoe.x, P.shoe.y]) as unknown as SplineFields) };
    });
  }

  // ---------------------------------------------------------------- switching

  private switchTo(p: boolean): void {
    this.portrait = p;
    const { stage } = this;

    worldCanvasSpace.positions.clear();
    worldCanvasSpace.scales.clear();
    this.placeSeats();
    this.placeShoe();
    if (p) {
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

  /**
   * Where each slot's player sits on the ring (seatSpread.ts spreadRing). Between hands, when the seats are planned:
   * a slot whose player sits between two slots slides there — plate, deal paths and pot-fly target — so every gap
   * round the table is the same (7 players no longer leave a hole at the top).
   *
   * Landscape only: the portrait grid keeps whole slots, because between the side and top rows a sliding seat would
   * run into the board and pot band in the middle of the phone table (portraitLayout.ts); its 8 places are already
   * spread evenly by seatSpread.
   */
  setRing(ring: readonly (number | null)[]): void {
    if (ring.length === this.ring.length && ring.every((f, i) => f === this.ring[i])) return;
    this.ring = [...ring];
    this.placeSeats();
    for (const cv of this.spawned()) {
      const spline = (cv as unknown as { spline: UnitySpline | null }).spline;
      if (cv.alive && spline) cv.retargetSpline(spline);
    }
  }

  /**
   * The shoe sits where the deal paths rise through the felt: Unity's spot in landscape; in portrait the paths start
   * at P.shoe (top of the table), and the opening turns with the table so it still reads as a wide slot on screen.
   */
  private placeShoe(): void {
    const shoe = this.shoe;
    const home = this.shoeHome;
    if (!shoe || !home) return;
    if (!this.portrait) {
      shoe.position.copy(home.p);
      shoe.quaternion.copy(home.q);
      shoe.scale.setScalar(1);
      return;
    }
    const feltY = (shoe.userData as { feltY?: number }).feltY ?? home.p.y;
    const box = dealCrossings(this.portraitSplines.map((pair) => pair.map(splineOf)), feltY);
    const [x, , z] = box ? [(box.minX + box.maxX) / 2, 0, (box.minZ + box.maxZ) / 2] : unityOf(P.shoe.x, P.shoe.y, 0);
    shoe.position.set(x, home.p.y, z);
    shoe.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    shoe.scale.setScalar(P.shoe.scale);
  }

  /** Seat canvases, deal paths and pot-fly targets for the current orientation and ring. */
  private placeSeats(): void {
    const p = this.portrait;
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
    stage.hud.seats.forEach((seat, i) => {
      if (p) {
        const a = P.seats[i % n]?.avatar ?? [0, 0];
        worldCanvasSpace.positions.set(seat.canvas, unityOf(a[0], a[1], seat.canvas.position[1]));
      } else worldCanvasSpace.positions.delete(seat.canvas);
    });
    if (!p) {
      const c = this.ringCentre;
      stage.hud.seats.forEach((seat, i) => {
        const f = this.ring[i];
        if (f == null || Math.abs(f - i) < 1e-6 || n < 2) return;
        const a = ((Math.floor(f) % n) + n) % n;
        const b = (a + 1) % n;
        const t = f - Math.floor(f);
        const home = this.canvasHome;
        if (home[a] && home[b]) worldCanvasSpace.positions.set(seat.canvas, ringLerp(home[a], home[b], t, c));
        const pos = stage.seatWorld[i];
        if (pos && this.seatWorldSnap[a] && this.seatWorldSnap[b]) pos.splice(0, pos.length, ...ringLerp(this.seatWorldSnap[a], this.seatWorldSnap[b], t, c));
        stage.table.seatSplines[i]?.forEach((live, k) => {
          const endA = splineOf(this.splineSnap[a][k]).evaluatePosition(1);
          const endB = splineOf(this.splineSnap[b][k]).evaluatePosition(1);
          const [x, y, z] = ringLerp([endA.x, endA.y, endA.z], [endB.x, endB.y, endB.z], t, c);
          const bent = bendSplineEnd(splineOf(this.splineSnap[i][k]), new Vector3(x, y, z));
          Object.assign(live as unknown as SplineFields, { ...(bent as unknown as SplineFields) });
        });
      });
    }
    stage.hud.refreshCardClear();
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
    const progress = new Map<Object3D, number>();
    if (this.portrait) {
      const index = new Map<unknown, { seat: number; card: number }>();
      this.stage.table.seatSplines.forEach((pair, seat) => pair.forEach((s, card) => index.set(s, { seat, card })));
      for (const cv of this.spawned()) {
        const at = index.get((cv as unknown as { spline: unknown }).spline);
        if (at) which.set(cv.transform, at);
        progress.set(cv.transform, cv.pathProgress);
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
        const at = which.get(card);
        // By progress along the path, not distance from the deck: the swirl passes back near the deck, and a card
        // must not twist mid-air. The card flies like Unity's (aligned with the path) and turns upright as it comes
        // in to its seat; on the way back it unwinds as it leaves.
        const t = progress.get(card) ?? 1;
        const wgt = MathUtils.smoothstep(t, TURN_FROM, 0.97);
        const own = at?.seat === 0;
        const lean = MathUtils.degToRad(own ? P.ownLean : P.lean) * (at?.card === 1 ? -1 : 1);
        const solved = this.uprightYaw(card, home, Math.PI / 2 + lean);
        // Same orientation, nearest turn to last frame's: no full spins when the solution crosses ±180°.
        if (solved !== null) home.angle += wrapAngle(solved - home.angle);
        angle = home.angle * wgt;
        if (own) grow = 1 + (P.ownCardScale - 1) * wgt;
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

/**
 * The deal swirl's squeeze in portrait (screen x and y, about the table centre). Unturned it spans x −5.8…4.5 and
 * y −5.2…8.0; the fitted portrait table is ±4.8 wide with the top seat at 7.
 */
const SWIRL = { x: 0.75, y: 0.75 };
/** Path progress from which a card turns upright (and yours grows), reaching it just before the seat. */
const TURN_FROM = 0.72;
/** Landed hole cards stay under the seat canvases' plane (y 0.92), as Unity's do, so the HUD sorts over them. */
const LANDED_MAX_Y = 0.85;
/** Fraction of the path (by length) after which it starts bending onto the portrait card spot. */
const TAIL_FROM = 0.55;
/** Landscape pot chip piles: this far (Unity x, screen left) from Unity's spot, clear of the v2 pot pill. */
const LANDSCAPE_TOKENS_DX = -0.65;
/** Fraction of the path (by length) over which the portrait deck shift fades out. */
const HEAD_TO = 0.3;

/**
 * A landscape deal path re-drawn for the portrait table: squeezed by `SWIRL` and bent over its tail so it ends on
 * `spot` (portrait coords). Built in Unity world space; knot rotations (the banking up-vectors) are kept.
 */
export function portraitPath(s: UnitySpline, spot: [number, number], endY?: number, deck?: [number, number]): UnitySpline {
  // Portrait x = −Unity z, portrait y = Unity x.
  const { knots, frac } = worldKnots(s, new Matrix4().makeScale(SWIRL.y, 1, SWIRL.x));
  if (deck && !s.closed) {
    // The deck moves to the portrait shoe (top of the table): the rise through the felt and the start of the swirl
    // shift there together, fading out before the tail.
    const [dx, , dz] = unityOf(deck[0], deck[1], 0);
    const shift = new Vector3(dx - knots[0].position.x, 0, dz - knots[0].position.z);
    knots.forEach((k, i) => k.position.addScaledVector(shift, 1 - MathUtils.smoothstep(frac[i], 0, HEAD_TO)));
  }
  const end = knots[knots.length - 1].position;
  const [tx, , tz] = unityOf(spot[0], spot[1], end.y);
  return bentPath(s, knots, frac, new Vector3(tx, endY ?? end.y, tz));
}

/**
 * A deal path with its tail bent smoothly onto `target` (Unity world space) — how a seat slid round the oval
 * (setRing) still gets its cards: same deck, same swirl, a different last stretch.
 */
export function bendSplineEnd(s: UnitySpline, target: Vector3): UnitySpline {
  const { knots, frac } = worldKnots(s, new Matrix4());
  return bentPath(s, knots, frac, target);
}

type WorldKnot = { position: Vector3; tangentIn: Vector3; tangentOut: Vector3; rotation: Quaternion };

/** The path's knots in Unity world space (scaled by `S` about the origin), and each knot's fraction of its length. */
function worldKnots(s: UnitySpline, S: Matrix4): { knots: WorldKnot[]; frac: number[] } {
  const W = s.world;
  const W3 = new Matrix3().setFromMatrix4(W);
  const S3 = new Matrix3().setFromMatrix4(S);
  const wRot = new Quaternion();
  W.decompose(new Vector3(), wRot, new Vector3());
  const knots = s.knots.map((k) => {
    const rotation = wRot.clone().multiply(k.rotation);
    const inv = rotation.clone().invert();
    const tangent = (t: Vector3) => t.clone().applyQuaternion(k.rotation).applyMatrix3(W3).applyMatrix3(S3).applyQuaternion(inv);
    return { position: k.position.clone().applyMatrix4(W).applyMatrix4(S), tangentIn: tangent(k.tangentIn), tangentOut: tangent(k.tangentOut), rotation };
  });
  // Each knot's fraction of the squeezed path's length.
  const squeezed = new UnitySpline({ name: s.name, closed: s.closed, knots, worldMatrix: IDENTITY });
  const lengths = squeezed.curves.map(bezierLength);
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let run = 0;
  const frac = knots.map((_, i) => {
    if (i > 0) run += lengths[i - 1] ?? 0;
    return run / total;
  });
  return { knots, frac };
}

/** Moves the knots past TAIL_FROM (smoothly weighted) so the path ends on `target`. */
function bentPath(s: UnitySpline, knots: WorldKnot[], frac: number[], target: Vector3): UnitySpline {
  const end = knots[knots.length - 1].position;
  const d = target.clone().sub(end);
  knots.forEach((k, i) => {
    const w = s.closed ? 0 : MathUtils.smoothstep(frac[i], TAIL_FROM, 1);
    k.position.addScaledVector(d, w);
  });
  return new UnitySpline({ name: s.name, closed: s.closed, knots, worldMatrix: IDENTITY });
}

/** A UnitySpline over a snapshot of another's fields (to evaluate a saved path without touching the live one). */
const splineOf = (f: SplineFields): UnitySpline => Object.assign(Object.create(UnitySpline.prototype) as UnitySpline, f);

/**
 * Point between `a` and `b` (Unity world) a fraction `t` of the way round the oval: angle and radius about `c` (x, z)
 * are interpolated, height linearly — a seat slid between two slots stays on the ring instead of cutting inside it.
 */
export function ringLerp(a: readonly number[], b: readonly number[], t: number, c: { x: number; z: number }): [number, number, number] {
  const a0 = Math.atan2(a[2] - c.z, a[0] - c.x);
  const a1 = Math.atan2(b[2] - c.z, b[0] - c.x);
  const r0 = Math.hypot(a[0] - c.x, a[2] - c.z);
  const r1 = Math.hypot(b[0] - c.x, b[2] - c.z);
  const ang = a0 + wrapAngle(a1 - a0) * t;
  const r = r0 + (r1 - r0) * t;
  return [c.x + Math.cos(ang) * r, a[1] + (b[1] - a[1]) * t, c.z + Math.sin(ang) * r];
}

const IDENTITY = new Matrix4().toArray();

function bezierLength(c: { p0: Vector3; p1: Vector3; p2: Vector3; p3: Vector3 }): number {
  let len = 0;
  let prev = c.p0.clone();
  const p = new Vector3();
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    p.set(0, 0, 0)
      .addScaledVector(c.p0, u * u * u)
      .addScaledVector(c.p1, 3 * u * u * t)
      .addScaledVector(c.p2, 3 * u * t * t)
      .addScaledVector(c.p3, t * t * t);
    len += p.distanceTo(prev);
    prev.copy(p);
  }
  return len;
}
