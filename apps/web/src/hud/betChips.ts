/**
 * Per-seat bet chips: each seat's current-street bet as a v2 pill on the felt, between the seat and the pot. Placed
 * every frame from the projected seat and pot canvas pivots (so it follows the portrait re-homing, camera shake and
 * zoom like the seat and pot HUDs). When a street closes the chips sweep into the pot and fade.
 */
import type { PerspectiveCamera } from 'three';
import { TableMoney } from '@nomad/engine';
import { ticker, Ease, type Tween } from '../anim/tween';
import type { WorldCanvas } from './worldCanvas';
import { assetUrl } from './unityUi';
import './betChips.css';

/** Where the chip sits on the seat → pot line (0 = seat, 1 = pot). */
export const BET_CHIP_T = 0.52;
/** How far (CSS px) the search for a chip's spot starts from its seat's box centre, before nudging clear of obstacles. */
export const PORTRAIT_CHIP_PX = 64;
const SWEEP_SECONDS = 0.35;

/** Chip art (public/assets/ui2/chips, soft-2D, seen from slightly above): violet, blue, green, red, gold, black. */
const CHIP_ART = [1, 2, 3, 4, 5, 6].map((i) => assetUrl(`assets/ui2/chips/chip_${i}.webp`));

/** Grouped chip columns for an amount: one column per colour, biggest first (shared by the bets and the pot). */
function chipColumns(amount: number, extra = 0): string {
  const counts = new Map<number, number>();
  for (const k of chipStack(amount)) counts.set(k, (counts.get(k) ?? 0) + 1);
  // `extra`: a few more chips on the top colour (the pot reads as a bigger pile than one bet).
  if (extra > 0 && counts.size) {
    const top = Math.max(...counts.keys());
    counts.set(top, counts.get(top)! + extra);
  }
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([k, n]) => `<span class="v2-chipcol" style="--n:${n}">${Array.from({ length: n }, (_, i) => `<i style="background-image:url('${CHIP_ART[k]}');--i:${i}"></i>`).join('')}</span>`)
    .join('');
}

/**
 * A small physical stack for an amount: more chips for bigger bets (1 → 6), colours stepping up with the amount so
 * a 25 and a 2,500 bet look different at a glance.
 */
export function chipStack(amount: number): number[] {
  if (amount <= 0) return [];
  const digits = Math.max(1, Math.floor(Math.log10(amount)) + 1);
  const count = Math.min(6, 1 + Math.floor(digits * 1.2));
  const top = Math.min(CHIP_ART.length - 1, Math.max(0, digits - 1));
  return Array.from({ length: count }, (_, i) => Math.max(0, top - (i % 3)));
}

interface Chip {
  el: HTMLDivElement;
  stack: HTMLDivElement;
  amount: HTMLSpanElement;
  shown: string;
  bet: number;
  t: number;
  alpha: number;
  sweep: Tween | null;
  /** The spot last used (distance along the seat→pot line, side nudge), kept while it stays clear: no hopping. */
  /** Offset (CSS px) from the seat's projected pivot, which doesn't move when the status chip or cards change the seat's box. */
  spot: { dx: number; dy: number } | null;
}

export class BetChips {
  readonly el: HTMLDivElement;
  private readonly chips: Chip[];
  /** The pot's chips: a grouped stack beside the pot pill (replaces the 3D token piles). */
  private readonly potEl: HTMLDivElement;
  /** The pot as the game reports it (it includes this street's bets, still in front of the players). */
  private potTotal = 0;
  /** What the stack currently draws ('' = hidden). */
  private potKey = '';
  /** The pot went to a winner this hand: keep the stack hidden until the next hand's pot starts from 0. */
  private awarded = false;
  /** While the pot slides to a winner: the seat slot and the tween's progress (0..1). */
  private award: { slot: number; p: number; tween: Tween } | null = null;

  constructor(parent: HTMLElement, seatCount: number) {
    this.el = document.createElement('div');
    this.el.className = 'v2-betchips';
    parent.append(this.el);
    this.chips = Array.from({ length: seatCount }, () => {
      const el = document.createElement('div');
      el.className = 'v2-betchip';
      el.hidden = true;
      const stack = document.createElement('div');
      stack.className = 'v2-chipstack';
      const amount = document.createElement('span');
      amount.className = 'v2-chipamt';
      el.append(stack, amount);
      this.el.append(el);
      return { el, stack, amount, shown: '', bet: 0, t: BET_CHIP_T, alpha: 1, sweep: null, spot: null };
    });
    this.potEl = document.createElement('div');
    this.potEl.className = 'v2-potchips';
    this.potEl.hidden = true;
    this.el.append(this.potEl);
  }

  /**
   * The pot's total. The stack draws only the chips already in the middle: the total less every bet still in front of
   * a player (or sliding in), so it grows the moment each bet's sweep lands, never before (see drawPot()).
   */
  setPot(amount: number): void {
    this.potTotal = Math.max(0, amount);
    if (this.potTotal === 0) this.awarded = false; // a new hand
  }

  private drawPot(v: number): void {
    const key = v > 0 ? chipStack(v).join(',') : '';
    if (key === this.potKey) return;
    this.potKey = key;
    this.potEl.hidden = v <= 0;
    if (v > 0) this.potEl.innerHTML = chipColumns(v, 2);
  }

  /** The pot slides to the winner's seat (HUD slot) and fades. */
  awardTo(slot: number): void {
    if (this.award || this.awarded) return;
    this.awarded = true;
    this.drawPot(this.potTotal); // the whole pot goes, including any last bets still sliding in
    if (this.potEl.hidden) return;
    this.award = {
      slot,
      p: 0,
      tween: ticker.to(
        0.6,
        (p) => {
          if (!this.award) return;
          this.award.p = p;
          if (p >= 1) {
            this.award = null;
            this.drawPot(0);
            this.potEl.style.opacity = '';
          }
        },
        Ease.InQuad,
      ),
    };
  }

  /** The seat's chips in this street (0 hides the pill). */
  setBet(seat: number, bet: number, allIn = false): void {
    const c = this.chips[seat];
    if (!c) return;
    c.sweep?.kill();
    c.sweep = null;
    c.t = BET_CHIP_T;
    c.alpha = 1;
    if (c.el.hidden) c.spot = null; // newly shown: find a spot fresh
    c.bet = bet > 0 ? bet : 0;
    c.el.style.opacity = '';
    c.el.classList.toggle('v2-allin', allIn && c.bet > 0);
    if (c.bet > 0) {
      c.amount.textContent = TableMoney.chips(c.bet);
      const key = chipStack(c.bet).join(',');
      if (key !== c.shown) {
        c.shown = key;
        // Bottom chip first; each one sits a little higher (a physical stack seen at the table's angle).
        // Grouped by colour: one neat column per denomination, biggest first (not one mixed stack).
        c.stack.innerHTML = chipColumns(c.bet);
      }
    }
    // Newly shown: invisible until the next update() places it (otherwise it flashes at the layer's corner).
    if (c.el.hidden && c.bet > 0) c.el.style.visibility = 'hidden';
    c.el.hidden = c.bet <= 0;
  }

  /** Street over: every visible chip slides into the pot and fades, then the bets are 0. */
  sweepToPot(): void {
    for (let i = 0; i < this.chips.length; i++) this.sweep(i);
  }

  /** One seat's chip slides into the pot and fades. */
  sweep(seat: number): void {
    const c = this.chips[seat];
    if (!c || c.bet <= 0 || c.sweep) return;
    const from = c.t;
    c.sweep = ticker.to(
      SWEEP_SECONDS,
      (p) => {
        c.t = from + (1 - from) * p;
        c.alpha = 1 - p;
        if (p >= 1) {
          c.sweep = null;
          c.bet = 0;
          c.el.hidden = true;
          c.t = BET_CHIP_T;
          c.alpha = 1;
        }
      },
      Ease.InQuad,
    );
  }

  /** The seats or their cards were laid out again: every bet finds its spot afresh. */
  resetSpots(): void {
    for (const c of this.chips) c.spot = null;
  }

  /** Bets cleared without the sweep (new hand, seat hidden). */
  clearAll(): void {
    for (let i = 0; i < this.chips.length; i++) this.setBet(i, 0);
  }

  /**
   * Per frame: place each visible chip on its own seat's line to the pot. Every layout starts at the seat's drawn box
   * (plate, status pill, avatar) and walks toward the pot to the first spot clear of every seat, the pot pill and
   * whatever `extra` adds (dealt cards, the shoe) — so a stack always sits just in front of the seat that bet it.
   */
  update(camera: PerspectiveCamera, w: number, h: number, seats: SeatLike[], pot: WorldCanvas, extra?: () => DOMRect[]): void {
    let potXY: [number, number] | null = null;
    const layerBox = this.el.getBoundingClientRect();
    if (!this.award) this.drawPot(this.awarded ? 0 : this.potTotal - this.chips.reduce((sum, c) => sum + (c.el.hidden ? 0 : c.bet), 0));
    if (!this.potEl.hidden) {
      const pill = extra?.()[0];
      const pw = this.potEl.offsetWidth;
      const ph = this.potEl.offsetHeight;
      // Home: just left of the pot pill, bottoms aligned with the pill's middle.
      let px = pill && pill.width ? pill.left - layerBox.left - pw - 8 : pot.screenPivot(camera, w, h)[0] - pw - 60;
      let py = pill && pill.width ? pill.top - layerBox.top + pill.height / 2 - ph * 0.75 : pot.screenPivot(camera, w, h)[1] - ph / 2;
      if (this.award) {
        const seat = seats[this.award.slot];
        if (seat?.visible) {
          const [sx, sy] = seat.canvas.screenPivot(camera, w, h);
          const p = this.award.p;
          px += (sx - pw / 2 - px) * p;
          py += (sy - ph / 2 - py) * p;
          this.potEl.style.opacity = String(1 - p * 0.85);
        }
      }
      this.potEl.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
    }
    // Everything to keep clear of, read once per frame (only when a chip is showing).
    let obstacles: DOMRect[] | null = null;
    this.chips.forEach((c, i) => {
      const seat = seats[i];
      if (c.el.hidden || !seat?.visible) {
        if (!c.el.hidden && !seat?.visible) c.el.hidden = true;
        return;
      }
      potXY ??= pot.screenPivot(camera, w, h);
      // The seat as drawn: its pivot plus the HUD's screen nudge (card clearance, symmetry), so a kept spot moves with it.
      const piv = seat.canvas.screenPivot(camera, w, h);
      const sx = piv[0] + seat.canvas.screenOffset[0];
      const sy = piv[1] + seat.canvas.screenOffset[1];
      const dx = potXY[0] - sx;
      const dy = potXY[1] - sy;
      const d = Math.hypot(dx, dy) || 1;
      let x = sx + dx * c.t;
      let y = sy + dy * c.t;
      const own = c.sweep ? [] : seat.occupiedRects?.() ?? [];
      if (own.length) {
        obstacles ??= [...seats.flatMap((s) => (s.visible ? s.occupiedRects?.() ?? [] : [])), ...(extra?.() ?? [])];
        const ox = (Math.min(...own.map((r) => r.left)) + Math.max(...own.map((r) => r.right))) / 2 - layerBox.left;
        const oy = (Math.min(...own.map((r) => r.top)) + Math.max(...own.map((r) => r.bottom))) / 2 - layerBox.top;
        const vx = potXY[0] - ox;
        const vy = potXY[1] - oy;
        const len = Math.hypot(vx, vy) || 1;
        const cw = c.el.offsetWidth || 44;
        const ch = c.el.offsetHeight || 20;
        const clear = (px: number, py: number): boolean => {
          const l = layerBox.left + px - cw / 2 - 3;
          const r = layerBox.left + px + cw / 2 + 3;
          const t = layerBox.top + py - ch / 2 - 3;
          const b = layerBox.top + py + ch / 2 + 3;
          return !obstacles!.some((o) => o.width > 0 && l < o.right && r > o.left && t < o.bottom && b > o.top);
        };
        const ux = vx / len;
        const uy = vy / len;
        const start = Math.min(PORTRAIT_CHIP_PX * 0.5, len * 0.3);
        // How far the seat's own box reaches along the line to the pot: a sideways spot starts past it, in front of
        // the seat (not above or below its plate, which on the top row is off the felt).
        let reach = 0;
        for (const r of own) {
          for (const [cx, cy] of [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]] as const) {
            reach = Math.max(reach, (cx - layerBox.left - ox) * ux + (cy - layerBox.top - oy) * uy);
          }
        }
        let at: [number, number] | null = null;
        const spotAt = (dist: number, side: number): [number, number] => [ox + ux * dist - uy * side * (ch + 6), oy + uy * dist + ux * side * (ch + 6)];
        // A bet keeps the spot it was first placed at for the whole street: the search already keeps clear of where
        // every seat's cards will land, so the deal, a status tag or a raise never push it around. Only a new layout
        // (resetSpots: seats re-placed) or a new street finds a spot afresh.
        if (c.spot) at = [sx + c.spot.dx, sy + c.spot.dy];
        // Otherwise search again: on the straight line toward the pot first (past the seat's cards if they're in the
        // way), and only if the whole line is blocked, nudged to either side, a chip's height further each time (a
        // pair landing beside its plate can cover the whole line); nearest the seat wins.
        for (const sides of [[0], [1, -1], [2, -2], [3, -3], [4, -4]]) {
          for (let dist = start; dist < len * 0.85 && !at; dist += 4) {
            // Of the two sides, the one nearer the pot first (the felt, not off the table's edge).
            const order = sides.length < 2 ? sides : [...sides].sort((a, b) => {
              const pa = spotAt(dist, a);
              const pb = spotAt(dist, b);
              return Math.hypot(pa[0] - potXY![0], pa[1] - potXY![1]) - Math.hypot(pb[0] - potXY![0], pb[1] - potXY![1]);
            });
            for (const side of order) {
              const p = spotAt(dist, side);
              // A sideways spot must still be well on the way to the pot (not round the seat's back, off the felt).
              if (side && (dist < reach || Math.hypot(p[0] - potXY![0], p[1] - potXY![1]) > len * 0.85)) continue;
              if (clear(p[0], p[1])) {
                at = p;
                c.spot = { dx: p[0] - sx, dy: p[1] - sy };
                break;
              }
            }
          }
          if (at) break;
        }
        if (!at) {
          // Nowhere clear: the spot just past the seat's own box.
          let dist = start;
          while (dist < len * 0.6 && own.some((o) => insideRect(o, layerBox.left + ox + ux * dist, layerBox.top + oy + uy * dist, cw, ch))) dist += 4;
          at = [ox + ux * dist, oy + uy * dist];
        }
        [x, y] = at;
        c.t = Math.min(0.95, Math.max(0, ((x - sx) * dx + (y - sy) * dy) / (d * d))); // a sweep starts near here
      }
      // Whole pixels (centre minus the rounded half-size): sub-pixel offsets made the amount text soft.
      const cw2 = c.el.offsetWidth || 44;
      const ch2 = c.el.offsetHeight || 20;
      c.el.style.transform = `translate(${Math.round(x - cw2 / 2)}px, ${Math.round(y - ch2 / 2)}px)`;
      if (c.sweep) c.el.style.opacity = String(c.alpha);
      // A chip shown since the last frame is placed now: only then is it made visible (no flash at 0,0).
      if (c.el.style.visibility) c.el.style.visibility = '';
    });
  }
}

/** Whether a w × h box centred on (x, y) overlaps `o` (client px). */
function insideRect(o: DOMRect, x: number, y: number, w: number, h: number): boolean {
  return x - w / 2 < o.right && x + w / 2 > o.left && y - h / 2 < o.bottom && y + h / 2 > o.top;
}

/** What the chip layer reads from a seat HUD. */
export interface SeatLike {
  canvas: WorldCanvas;
  visible: boolean;
  occupiedRects?(): DOMRect[];
}
