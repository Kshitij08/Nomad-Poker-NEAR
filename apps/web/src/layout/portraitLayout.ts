/**
 * Where everything sits on the portrait table (docs/portrait-design.md §Table), in portrait screen coords: world units
 * before the fit zoom, x right / y up, table centre = (0, 0). Kept free of three.js so the no-overlap check
 * (__tests__/portraitLayout.test.ts) runs under node.
 *
 *            [3]   [ 4 ]   [5]          seats 3/5 sit level with 4's bar, side by side with its stack
 *                  ▯▯                   4's cards under its stack
 *           ▯▯  ●● [ 75 ]  ▯▯           3/5's cards under their own status pill, a card height above the board
 *              B B B B B                the board across the middle, never in line with anyone's cards
 *      [2] ▯▯             ▯▯ [6]        side seats' cards on the inner side of the avatar
 *                 ┌──┬──┐
 *      [1] ▯▯     │you│  │    ▯▯ [7]   your two cards, large and fanned, above your seat
 *                 [ 0 ]
 */

export type XY = [number, number];

export interface PortraitSeatSpot {
  /** Avatar centre. */
  avatar: XY;
  /** Centre of the seat's two hole cards (card 0 left, card 1 right). */
  cards: XY;
}

export const PORTRAIT_LAYOUT = {
  // Every seat: the avatar, its name plate under it, and its two cards just up and to the right of the avatar (the
  // left column's cards face into the table, the right column's sit by the edge); the table's mobile mockup, 14 Nov.
  seats: [
    { avatar: [-0.95, -6.9], cards: [1.1, -6.55] }, // 0 you (bottom): your large pair beside your avatar
    { avatar: [-3.9, -3.0], cards: [-2.3, -2.65] }, // 1 bottom-left
    { avatar: [-3.9, 0.5], cards: [-2.3, 0.85] }, // 2 left
    { avatar: [-3.9, 4.0], cards: [-2.3, 4.35] }, // 3 top-left
    { avatar: [-0.1, 6.0], cards: [1.5, 6.35] }, // 4 top
    { avatar: [2.5, 4.0], cards: [4.1, 4.35] }, // 5 top-right
    { avatar: [2.5, 0.5], cards: [4.1, 0.85] }, // 6 right
    { avatar: [2.5, -3.0], cards: [4.1, -2.65] }, // 7 bottom-right
  ] as PortraitSeatSpot[],
  /** Community cards: the flop in one row and the turn and river centred under it (`rows`); centre, spacing, size. */
  board: { x: 0, y: -0.175, spacing: 1.05, scale: 1.05, rows: true, rowGap: 1.55 },
  /** Pot pill (Pot_UI canvas, drawn at `scale` × the 3D zoom) and the chip piles (Token Parents) beside it. */
  pot: { x: -0.65, y: 2.4, scale: 0.7 },
  tokens: { x: 0.3, y: 1.65 },
  /**
   * The deck spot the portrait deal paths start from; the shoe (three/tableScene.ts) covers where they rise through the
   * felt (SHOE below): beside the pot.
   */
  shoe: { x: -0.3, y: 3.3, scale: 0.6 },
  /** Seat HUD canvases are drawn this much larger than the 3D projection. */
  hudScale: 1.45,
  /** Card 1's centre minus card 0's, along x (the fan); your cards are larger, so they spread further. */
  fan: 0.5,
  ownFan: 0.85,
  /** Each card leans this many degrees away from the fan's middle (card 0 left, card 1 right). */
  lean: 4,
  ownLean: 6,
  /** Your hole cards grow to this size as they land. */
  ownCardScale: 1.6,
};

/** One card lying upright at scale 1 (measured from the card mesh on the fitted table). */
export const PORTRAIT_CARD = { w: 0.862, h: 1.24 };

/** World units per seat-canvas unit (Name_Canvas lossy scale). */
export const SEAT_UNIT = 0.0022457757;

/** Stacked seat HUD extent in canvas units from the avatar centre (portraitSeats.ts lays it out). */
export const STACKED_SEAT_BOX = { left: -420, right: 420, top: 250, bottom: -740, handBottom: -894 };
/** The avatar circle and the bar + status pill under it, in canvas units (same origin). */
export const STACKED_SEAT_PARTS = {
  avatar: { left: -250, right: 250, top: 250, bottom: -250 },
  bars: { left: -420, right: 420, top: -253, bottom: -740 },
};

/** Measured on the fitted table: the pot pill per unit of `pot.scale`, and the chip piles, which draw 0.23 right of
 * their root. */
const POT_PILL = { w: 5.02, h: 1.1 };
const TOKENS = { w: 0.68, h: 0.68, dx: 0.23 };
/** The shoe at `shoe.scale` 1 (measured), and where it lands relative to the deck spot (the paths rise just past it). */
const SHOE = { w: 1.15, h: 0.57, dx: 0.19, dy: -0.2 };

export interface Box {
  name: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const box = (name: string, cx: number, cy: number, w: number, h: number): Box => ({ name, x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 });

/** Community card i's centre: the flop (0–2) in a row, the turn and river (3, 4) centred under it. */
export function portraitBoardSpot(i: number): XY {
  const B = PORTRAIT_LAYOUT.board;
  if (!B.rows) return [B.x + (i - 2) * B.spacing, B.y];
  return i < 3 ? [B.x + (i - 1) * B.spacing, B.y + B.rowGap / 2] : [B.x + (i - 3.5) * B.spacing, B.y - B.rowGap / 2];
}

/** Card k's centre for a seat (card 0 left of the pair's centre, card 1 right). */
export function portraitCardSpot(seat: number, k: number): XY {
  const L = PORTRAIT_LAYOUT;
  const [cx, cy] = L.seats[seat].cards;
  const fan = seat === 0 ? L.ownFan : L.fan;
  return [cx + (k === 0 ? -fan / 2 : fan / 2), cy];
}

/**
 * Every element's footprint on the portrait table (portrait coords). Leaning cards get the bounding box of the turned
 * rectangle. Used by the no-overlap test and the fit.
 */
export function portraitBoxes(): Box[] {
  const L = PORTRAIT_LAYOUT;
  const u = SEAT_UNIT * L.hudScale;
  const out: Box[] = [];
  L.seats.forEach((s, i) => {
    const [ax, ay] = s.avatar;
    const a = STACKED_SEAT_PARTS.avatar;
    const b = STACKED_SEAT_PARTS.bars;
    out.push({ name: `seat${i}.avatar`, x0: ax + a.left * u, x1: ax + a.right * u, y0: ay + a.bottom * u, y1: ay + a.top * u });
    out.push({ name: `seat${i}.bars`, x0: ax + b.left * u, x1: ax + b.right * u, y0: ay + (i === 0 ? STACKED_SEAT_BOX.handBottom : b.bottom) * u, y1: ay + b.top * u });
    const grow = i === 0 ? L.ownCardScale : 1;
    const lean = MathRad(i === 0 ? L.ownLean : L.lean);
    const w = PORTRAIT_CARD.w * grow;
    const h = PORTRAIT_CARD.h * grow;
    const bw = w * Math.cos(lean) + h * Math.sin(lean);
    const bh = h * Math.cos(lean) + w * Math.sin(lean);
    const c0 = portraitCardSpot(i, 0);
    const c1 = portraitCardSpot(i, 1);
    out.push({ name: `seat${i}.cards`, x0: c0[0] - bw / 2, x1: c1[0] + bw / 2, y0: c0[1] - bh / 2, y1: c0[1] + bh / 2 });
  });
  const bw = PORTRAIT_CARD.w * L.board.scale;
  const bh = PORTRAIT_CARD.h * L.board.scale;
  for (let i = 0; i < 5; i++) {
    const [x, y] = portraitBoardSpot(i);
    out.push({ name: i < 3 ? 'board' : `board${i}`, x0: x - bw / 2, x1: x + bw / 2, y0: y - bh / 2, y1: y + bh / 2 });
  }
  out.push(box('pot', L.pot.x, L.pot.y, POT_PILL.w * L.pot.scale, POT_PILL.h * L.pot.scale));
  out.push(box('tokens', L.tokens.x + TOKENS.dx, L.tokens.y, TOKENS.w, TOKENS.h));
  out.push(box('shoe', L.shoe.x + SHOE.dx, L.shoe.y + SHOE.dy, SHOE.w * L.shoe.scale, SHOE.h * L.shoe.scale));
  return out;
}

/** Pairs of boxes that overlap by more than `slack` in both directions (a seat's own parts are allowed to touch). */
export function portraitOverlaps(boxes = portraitBoxes(), slack = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const sa = a.name.split('.')[0];
      const sb = b.name.split('.')[0];
      if (sa === sb && sa.startsWith('seat') && !(a.name.endsWith('cards') || b.name.endsWith('cards'))) continue;
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox > slack && oy > slack) out.push(`${a.name} × ${b.name} (${ox.toFixed(2)} × ${oy.toFixed(2)})`);
    }
  }
  return out;
}

function MathRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
