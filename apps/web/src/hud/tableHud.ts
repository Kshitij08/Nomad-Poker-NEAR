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
import { BetChips } from './betChips';
import { ShowCardsButton } from './showCards';
import { HUD_DATA, whenFontsReady } from './unityUi';
import './hud.css';
import './v2hud.css'; // Redesign v2 skin (seats, pot, action row, raise sheet)

export interface DomTableHud extends TableHud {
  readonly seats: SeatHudView[];
  readonly pot: PotHudView;
  readonly betting: BettingPanelView;
  /** Bet chips and the pot's chip stack (betChips.ts). */
  readonly chips: BetChips;
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
  /** "Show cards" after a hand (offered by the session; hidden at the next hand). */
  readonly showCards: ShowCardsButton;
  /**
   * Where each slot's hole cards land on screen (TableStage sets it from the seat splines). Landscape seats are
   * nudged down just enough that every seat's cards show the same amount above its plate (the Unity layout hid some
   * seats' cards behind their plates far more than others).
   */
  cardAnchor: ((slot: number, w: number, h: number) => [number, number] | null) | null;
  /** The seats or their deal paths moved (seats slid round the ring): measure the card clearance again. */
  refreshCardClear(): void;
  /** Screen rects (client px) the bet chips keep clear of besides the seats: the pot pill, dealt cards, the shoe. */
  chipObstacles: ((cards: boolean) => DOMRect[]) | null;
  /**
   * Landscape: where a side seat's hole cards should land (CSS px), or null for Unity's spot. TableStage bends the
   * seat's deal paths there (layout/portraitTable.ts setCardSpot).
   */
  onCardSpot: ((slot: number, at: [number, number] | null) => void) | null;
  /** Landscape: the screen rects (client px) of a slot's hole cards that have landed (empty while they fly). */
  cardRects: ((slot: number) => DOMRect[]) | null;
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
  const showCards = new ShowCardsButton(screenLayer);
  // Per-seat bet chips on the felt, above the seat and pot canvases (world layer, drawn after them).
  const chips = new BetChips(worldLayer, seats.length);
  seats.forEach((s, i) => {
    s.onBet = (bet, allIn) => chips.setBet(i, bet, allIn);
    s.onSweep = () => chips.sweep(i);
  });
  whenFontsReady([pot.root, ...seats.map((s) => s.root), betting.root]);

  // Per slot: the seat offset that keeps its hole cards visible above the plate (landscape; null = not measured yet).
  const cardClear: (number | null)[] = seats.map(() => null);
  const hud = { cardAnchor: null as DomTableHud['cardAnchor'], chipObstacles: null as DomTableHud['chipObstacles'], onCardSpot: null as DomTableHud['onCardSpot'], cardRects: null as DomTableHud['cardRects'] };
  /** Every seat but yours (landscape): its cards are placed explicitly (placeCards), so it needs no push-down. */
  const SIDE = (i: number) => i !== 0;
  const clearCards = (i: number, w: number, h: number): number => {
    if (document.documentElement.dataset.orient === 'portrait') return 0; // the portrait layout places cards itself
    const known = cardClear[i];
    if (known !== null) return known;
    const s = seats[i]!;
    const at = hud.cardAnchor?.(i, w, h);
    const plate = s.root.el.querySelector<HTMLElement>('[data-name="Name_bar"]');
    if (!at || !plate || i === 0) return (cardClear[i] = 0); // your own cards are drawn large above your plate
    if (SIDE(i) && hud.onCardSpot) return (cardClear[i] = 0); // cards beside the plate (placeCards below)
    s.canvas.screenOffset = [0, 0];
    s.canvas.update(camera, w, h);
    const r = plate.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (r.height <= 0) return 0; // not laid out yet: measure on a later frame
    // The seat's pop-in clip (Name_Graphics_In) scales the plate from 0: measuring part-way caches a wrong offset and
    // the seat jumps later. Wait (uncached) until every node between the plate and the seat root is at full scale.
    // (UiNode writes `scale(x,y)` into style.transform only when the scale isn't 1.)
    for (let n: HTMLElement | null = plate; n && n !== s.root.el; n = n.parentElement) if (n.style.transform.includes('scale(')) return 0;
    // Card centre at least this far above the plate's top edge (scales with the viewport like the cards do): enough for
    // the whole card to clear the plate, so revealed cards are never half hidden behind it.
    const want = Math.round(h * 0.058);
    const gap = r.top - box.top - at[1];
    return (cardClear[i] = Math.max(0, Math.round(want - gap)));
  };

  // Symmetry (landscape): Unity's seat canvases aren't exact mirror images (positions and the mirrored seats' inner
  // layout), so left / right pairs sat a few to ~35 px off. Once both seats of a pair are on screen, their plates are
  // measured and nudged to mirror positions about the pot's centre line (equal distance out, same height); you (bottom)
  // and the top seat are centred on it. A seat is measured as its avatar and plate together (what reads as "the
  // seat"), not the plate alone. Cached until the next resize.
  const sym: ([number, number] | null)[] = seats.map(() => null);
  const PAIRS: [number, number][] = [[1, 7], [2, 6], [3, 5]];
  const plateOf = (i: number): DOMRect | null => {
    const s = seats[i];
    const plate = s?.root.el.querySelector<HTMLElement>('[data-name="Name_bar"]');
    if (!s?.visible || !plate) return null;
    for (let n: HTMLElement | null = plate; n && n !== s.root.el; n = n.parentElement) if (n.style.transform.includes('scale(')) return null; // mid pop-in
    const r = plate.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const avEl = s.root.el.querySelector<HTMLElement>('[data-name="bg_circle"]');
    // The avatar pops in on its own clip: measuring it part-way skews the seat's centre (seats 0 / 4 ended up ~60 px
    // off the pot's line).
    for (let n: HTMLElement | null = avEl; n && n !== s.root.el; n = n.parentElement) if (n.style.transform.includes('scale(')) return null;
    const av = avEl?.getBoundingClientRect();
    if (!av || !av.width) return r;
    const l = Math.min(r.left, av.left);
    const tp = Math.min(r.top, av.top);
    return new DOMRect(l, tp, Math.max(r.right, av.right) - l, Math.max(r.bottom, av.bottom) - tp);
  };
  // Other seats' hole cards stand just above their plate, on the avatar's side: the pair's bottom edge rests on the
  // plate's top edge and its near side sits next to the avatar (as if the player holds them). placeCards makes the
  // first guess; once the pair has landed, checkCards measures it on screen and nudges it to that exact spot.
  const spots: ([number, number] | null)[] = seats.map(() => null);
  /** Per slot: how many nudges its landed pair has had (capped), or -1 once it sits where it should. */
  const checked: number[] = seats.map(() => 0);
  const seatParts = (i: number) => {
    const s = seats[i];
    const plate = s?.root.el.querySelector<HTMLElement>('[data-name="Name_bar"]')?.getBoundingClientRect();
    const av = s?.root.el.querySelector<HTMLElement>('[data-name="bg_circle"]')?.getBoundingClientRect();
    if (!plate || !plate.width || !av || !av.width) return null;
    // The plate runs from the avatar outward: cards go on the plate, right beside the avatar.
    const dir = av.left + av.width / 2 < plate.left + plate.width / 2 ? 1 : -1;
    return { plate, av, dir, edge: dir > 0 ? av.right : av.left };
  };
  const placeCards = (i: number) => {
    if (!SIDE(i) || !hud.onCardSpot) return;
    const parts = seatParts(i);
    if (!parts || !plateOf(i)) return;
    const box = root.getBoundingClientRect();
    const h = root.clientHeight;
    const pairW = h * 0.115; // first guess at the pair's size on screen; checkCards corrects it once they land
    const pairH = h * 0.125;
    const [ox, oy0] = sym[i] ?? [0, 0];
    let oy = oy0;
    // A seat too near the top of the screen slides down until its cards fit above it.
    const need = Math.ceil(h * 0.015 + pairH - (parts.plate.top - box.top));
    if (need > 0) {
      oy += need;
      sym[i] = [ox, oy];
    }
    const x = parts.edge + parts.dir * (pairW / 2 + h * 0.01) - box.left;
    const y = parts.plate.top + (oy - oy0) - pairH / 2 - box.top;
    spots[i] = [x, y];
    checked[i] = 0;
    hud.onCardSpot(i, [Math.round(x), Math.round(y)]);
    chips.resetSpots();
  };
  const checkCards = () => {
    if (!hud.cardRects || !hud.onCardSpot) return;
    const h = root.clientHeight;
    for (let i = 1; i < seats.length; i++) {
      const at = spots[i];
      if (!at || !seats[i]!.visible) continue;
      const rects = hud.cardRects(i);
      if (rects.length < 2) {
        if (checked[i]! < 0) checked[i] = 0; // between hands: check the next pair too
        continue;
      }
      if (checked[i]! < 0 || checked[i]! >= 6) continue;
      const parts = seatParts(i);
      if (!parts) continue;
      const l = Math.min(...rects.map((r) => r.left));
      const r = Math.max(...rects.map((q) => q.right));
      const bottom = Math.max(...rects.map((q) => q.bottom));
      const want = parts.edge + parts.dir * ((r - l) / 2 + h * 0.008);
      const dx = want - (l + r) / 2;
      const dy = parts.plate.top - h * 0.004 - bottom;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
        checked[i] = -1;
        continue;
      }
      checked[i]!++;
      at[0] += dx;
      at[1] += dy;
      hud.onCardSpot(i, [Math.round(at[0]), Math.round(at[1])]);
      chips.resetSpots();
    }
  };
  let visibleMask = '';
  const measureSymmetry = () => {
    // Someone sat down or left: lay the seats (and their cards) out again.
    const mask = seats.map((s) => (s.visible ? 1 : 0)).join('');
    if (mask !== visibleMask) {
      visibleMask = mask;
      sym.fill(null);
    }
    if (document.documentElement.dataset.orient === 'portrait') return;
    const pill = pot.root.el.querySelector<HTMLElement>('[data-name="bar"]')?.getBoundingClientRect();
    if (!pill || !pill.width) return;
    const mid = pill.left + pill.width / 2;
    for (const [a, b] of PAIRS) {
      if (sym[a] && sym[b]) continue;
      // A seat whose mirror partner is empty keeps its own place.
      for (const [x, y] of [[a, b], [b, a]] as const) {
        if (!sym[x] && !seats[y]?.visible && cardClear[x] !== null && plateOf(x)) {
          sym[x] = [0, 0];
          placeCards(x);
        }
      }
      if (sym[a] && sym[b]) continue;
      if (cardClear[a] === null || cardClear[b] === null) continue;
      const ra = plateOf(a);
      const rb = plateOf(b);
      if (!ra || !rb) continue;
      const L = ra.left + ra.width / 2 - mid;
      const R = rb.left + rb.width / 2 - mid;
      const out = (Math.abs(L) + Math.abs(R)) / 2;
      // Heights by the plate's line (the avatar can sit lower on one side's art).
      const ya = ra.bottom;
      const yb = rb.bottom;
      const y = (ya + yb) / 2;
      sym[a] = [Math.round(-out - L), Math.round(y - ya)];
      sym[b] = [Math.round(out - R), Math.round(y - yb)];
      placeCards(a);
      placeCards(b);
    }
    for (const i of [0, 4]) {
      if (sym[i] || cardClear[i] === null) continue;
      const r = plateOf(i);
      if (r) {
        sym[i] = [Math.round(mid - (r.left + r.width / 2)), 0];
        placeCards(i);
      }
    }
  };

  const update = () => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    camera.updateMatrixWorld();
    // The pot pill sits a little lower than Unity's spot (landscape), clear of the deal slot the cards rise through.
    pot.canvas.screenOffset = [0, document.documentElement.dataset.orient === 'portrait' ? 0 : Math.round(h * 0.022)];
    pot.canvas.update(camera, w, h);
    seats.forEach((s, i) => {
      if (!s.visible) return;
      const dy = clearCards(i, w, h);
      const [sx, sy] = sym[i] ?? [0, 0];
      s.canvas.screenOffset = [sx, dy + sy];
      s.canvas.update(camera, w, h);
    });
    measureSymmetry();
    if (document.documentElement.dataset.orient !== 'portrait') checkCards();
    if (!showCards.el.hidden) {
      const me = seats[0];
      const own = me?.visible ? me.occupiedRects() : []; // plate, status chip ("Fold"), D/SB/BB token, avatar
      const row = [...betting.root.el.querySelectorAll<HTMLElement>('[data-v2b]')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
      showCards.place(own, row, screenLayer.getBoundingClientRect());
    }
    chips.update(camera, w, h, seats, pot.canvas, () => {
      const pill = pot.root.el.querySelector<HTMLElement>('[data-name="bar"]') ?? pot.root.el;
      // Where each seat's hole cards land, cards dealt or not: a bet placed before the deal (the blinds) never ends up
      // under the cards that fly in later.
      const box = root.getBoundingClientRect();
      const landing: DOMRect[] = [];
      // Landscape sizes the pair by the viewport height; portrait by its width (the phone table is fitted across).
      const portrait = document.documentElement.dataset.orient === 'portrait';
      const [pw, ph] = portrait ? [w * 0.17, w * 0.15] : [h * 0.13, h * 0.14];
      seats.forEach((s, i) => {
        if (!s.visible) return;
        const at = hud.cardAnchor?.(i, w, h);
        const k = i === 0 ? (portrait ? 1.7 : 1.25) : 1; // your own pair is drawn bigger
        if (at) landing.push(new DOMRect(box.left + at[0] - (pw * k) / 2, box.top + at[1] - (ph * k) / 2, pw * k, ph * k));
      });
      return [pill.getBoundingClientRect(), ...landing, ...(hud.chipObstacles?.(!landing.length) ?? [])];
    });
  };

  return {
    screenLayer,
    showCards,
    chips,
    get cardAnchor() {
      return hud.cardAnchor;
    },
    set cardAnchor(fn) {
      hud.cardAnchor = fn;
      cardClear.fill(null);
      sym.fill(null);
    },
    get chipObstacles() {
      return hud.chipObstacles;
    },
    set chipObstacles(fn) {
      hud.chipObstacles = fn;
    },
    get onCardSpot() {
      return hud.onCardSpot;
    },
    set onCardSpot(fn) {
      hud.onCardSpot = fn;
      cardClear.fill(null);
      sym.fill(null);
    },
    get cardRects() {
      return hud.cardRects;
    },
    set cardRects(fn) {
      hud.cardRects = fn;
    },
    seats,
    pot,
    betting,
    refreshCardClear() {
      cardClear.fill(null);
      sym.fill(null);
    },
    layout() {
      cardClear.fill(null); // re-measure after a resize / rotation
      sym.fill(null);
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
