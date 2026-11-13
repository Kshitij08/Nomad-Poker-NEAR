/**
 * One seat HUD: the `Name_Canvas` / `Name_Canvas_Right` world-space canvas, port of Game/Views/SeatView.cs.
 * Layout, art, fonts and colours come from data/unity-hud.json (with the default SOLANA theme applied); the
 * on-enable Animators (Name_Graphics_In[_Right], Botton_name_Bar, Bot_Name, WinMedal_PopIn) play from ui-anims.json.
 */
import {
  AvatarCatalog,
  HandCategory,
  HandEvaluator,
  HandStrength,
  roundHalfEven,
  SeatRole,
  seatRoleLabel,
  TableMoney,
  type Card,
} from '@nomad/engine';
import { Ease, ticker, type Tween } from '../anim/tween';
import type { SeatHud } from '../table/tableView';
import { animatorOnEnable, uiClip } from './uiClips';
import { buildNode, cssColor, hexColor, HUD_DATA, UNode, type CanvasData, type RGBA } from './unityUi';
import { WorldCanvas } from './worldCanvas';

/** SeatView.RoleInk (0.12, 0.12, 0.14). */
const ROLE_INK: RGBA = { r: 0.12, g: 0.12, b: 0.14, a: 1 };
const STRENGTH_RED: RGBA = { r: 0.86, g: 0.16, b: 0.16, a: 1 };
const STRENGTH_ORANGE: RGBA = { r: 1, g: 0.58, b: 0.1, a: 1 };
const STRENGTH_GREEN: RGBA = { r: 0.18, g: 0.78, b: 0.28, a: 1 };
const lerpColor = (a: RGBA, b: RGBA, t: number): RGBA => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: a.a + (b.a - a.a) * t,
});

/** Redesign v2 fonts (docs/ui-style-guide.md): Nunito for labels, Fredoka for money. */
const V2_UI = "'Nunito', system-ui, sans-serif";
const V2_DISPLAY = "'Fredoka', 'Arial Rounded MT Bold', system-ui, sans-serif";

/** Status chip kind from SeatView's action text ("Fold", "Call 300", "Raise 1,200", "Busted"…). */
export function statusKind(text: string, stack: number): '' | 'fold' | 'call' | 'raise' | 'allin' | 'info' {
  const t = (text ?? '').trim();
  if (!t) return '';
  if (/^fold/i.test(t)) return 'fold';
  if (/all.?in/i.test(t)) return 'allin';
  if (/^(bet|raise|call|check)/i.test(t) && stack <= 0) return 'allin';
  if (/^(check|call)/i.test(t)) return 'call';
  if (/^(bet|raise)/i.test(t)) return 'raise';
  return 'info';
}

const HAND_SCALE = 1.35;
const sentenceCase = (s: string) => (s ? s[0] + s.slice(1).toLowerCase() : s);

/** Nodes SeatView never shows at the offline table (voice mic, seat number, remove-player overlay). */
const SKIP = new Set(['Mic', 'Circle_Num', 'Remove_Player']);

export class SeatHudView implements SeatHud {
  readonly root: UNode;
  readonly canvas: WorldCanvas;
  readonly mirrored: boolean;

  private readonly graphics: UNode;
  private readonly nameText: UNode;
  private readonly stackText: UNode;
  private readonly statusText: UNode;
  private readonly dealerBadge: UNode;
  private readonly dealerLabel: UNode;
  private readonly botIndicator: UNode;
  private readonly avatar: UNode;
  private readonly winner: UNode;
  private readonly timer: UNode;
  private readonly highlight: UNode;
  private readonly hand: UNode;
  private readonly handCategory: UNode;
  private readonly handPercent: UNode;
  private readonly handTrack: UNode;
  private readonly handFill: UNode;
  private readonly bottomBar: UNode;
  private readonly nameBar: UNode;

  private folded = false;
  private readonly handAnchorX: number;
  private readonly handClusterBottom: number;
  private timerTween: Tween | null = null;
  private highlightTween: Tween | null = null;
  private strengthActive = false;
  private stack = 0;
  private statusRaw = '';
  private prevStack = 0;
  private strengthHole: [Card, Card] | null = null;

  constructor(data: CanvasData, parent: HTMLElement) {
    const sv = HUD_DATA.tableView.seatViews.find((s) => s.canvas === data.name);
    this.mirrored = !!sv?.mirrored;
    // SeatView.foldedBrightness (Unity dims folded seats) is replaced by the v2 .v2-fold greyscale filter (v2hud.css).

    this.root = buildNode(data.root, { skip: (n) => SKIP.has(n.name) });
    this.root.el.classList.add('u-seat', 'v2-seat');
    // Right-hand seats are authored mirrored (avatar on the right, token on the plate's left end).
    this.root.el.classList.toggle('v2-mirror', this.mirrored);
    parent.append(this.root.el);
    const req = (p: string) => {
      const n = this.root.find(p);
      if (!n) throw new Error(`seat HUD node ${p} missing`);
      return n;
    };
    this.graphics = req('Graphics');
    this.nameBar = req('Graphics/Name_bar');
    this.bottomBar = req('Graphics/Bottom_bar');
    this.nameText = req('Graphics/Name_bar/Name_txt');
    this.stackText = req('Graphics/Name_bar/Amount_txt');
    this.statusText = req('Graphics/Bottom_bar/Text (TMP)');
    this.dealerBadge = req('Graphics/Name_bar/D_Token');
    this.dealerLabel = req('Graphics/Name_bar/D_Token/Text (TMP) (1)');
    this.avatar = req('Graphics/bg_circle/U_Icon');
    this.botIndicator = req('Graphics/bg_circle/U_Icon/Bot_indcator');
    this.winner = req('Graphics/Win_Medal');
    this.timer = req('Graphics/bg_circle/Timer');
    this.hand = req('Graphics/Hand');
    this.handCategory = req('Graphics/Hand/Text (TMP)');
    this.handPercent = req('Graphics/Hand/percentage_txt');
    this.handTrack = req('Graphics/Hand/ProgressionBar');
    this.handFill = req('Graphics/Hand/ProgressionBar/Handle');
    // The Hand panel is a live readout, not seat chrome: SeatView leaves it out of the fold tint.
    this.hand.foldBrightness = -1;
    // The strength meter parks under the plate. Measure the plate and status chip from their authored layout once:
    // their on-enable slide-in clips move them, which made the meter drift between hands (it was placed mid-clip).
    const nh = this.nameBar.sizeDelta[1];
    const bh = this.bottomBar.sizeDelta[1];
    this.handAnchorX = this.bottomBar.anchoredPosition[0];
    this.handClusterBottom = Math.min(this.nameBar.anchoredPosition[1] - nh * 0.5, this.bottomBar.anchoredPosition[1] - bh * 0.5);

    // VFX_Turn_Highlight (particle rings + light, not extractable) sits between Win_Medal and bg_circle.
    this.highlight = this.buildHighlight();
    const bgIndex = this.graphics.children.indexOf(req('Graphics/bg_circle'));
    this.graphics.add(this.highlight, bgIndex);
    this.highlight.setActive(false);

    this.applyV2Type();
    this.timer.el.classList.add('v2-timer');

    // Animators that play on enable.
    animatorOnEnable(this.root, uiClip(this.mirrored ? 'Name_Graphics_In_Right' : 'Name_Graphics_In'));
    animatorOnEnable(this.bottomBar, uiClip('Botton_name_Bar'));
    animatorOnEnable(this.botIndicator, uiClip('Bot_Name'), this.avatar);
    animatorOnEnable(this.winner, uiClip('WinMedal_PopIn'));
    // Timer.controller / Hand's Bottom_bar.controller are disabled Animators in the prefab (m_Enabled: 0).

    const w = data.world!;
    this.canvas = new WorldCanvas(this.root, w.position, w.scale[0]);
    // TableView.Initialize → HideAllSeats: nothing shows until a player is bound.
    this.root.setActive(false);
    this.root.layout();
  }

  // ---------------------------------------------------------------- SeatView API

  bind(name: string, avatar: number, avatarName: string): void {
    this.nameText.setText(name);
    const id = AvatarCatalog.idOf(AvatarCatalog.resolve(avatar, avatarName));
    if (id && this.avatar.image) {
      const file = `assets/ui/Test/UI/Common_UI/Pro_Pic/${id}.webp`;
      if (this.avatar.image.sprite?.file !== file) {
        this.avatar.image.sprite = { ...(this.avatar.image.sprite ?? { ppu: 100, rect: [0, 0, 1, 1], border: [0, 0, 0, 0] }), name: id, file };
        this.avatar.render();
      }
    }
  }

  setStack(stack: number): void {
    this.prevStack = this.stack;
    this.stack = stack;
    this.stackText.setText(TableMoney.chips(stack));
    this.paintStatus();
  }

  /** This street's chips in front of the seat (Unity's betText isn't wired; v2 draws a bet chip on the felt). */
  setBet(bet = 0): void {
    this.bet = bet > 0 ? bet : 0;
    this.onBet?.(this.bet, this.bet > 0 && this.stack <= 0);
  }

  /** Bet chip hook (tableHud wires it to BetChips with this seat's slot). */
  onBet: ((bet: number, allIn: boolean) => void) | null = null;
  /** Street over: the bet chip sweeps into the pot (tableHud wires it). */
  onSweep: (() => void) | null = null;
  private bet = 0;

  /**
   * A new street: this street's bet sweeps into the pot and Check / Call / Bet / Raise statuses clear. Fold and All-in
   * stay (they still describe the seat), as does Busted.
   */
  endStreet(): void {
    if (this.bet > 0) this.onSweep?.();
    this.bet = 0;
    const kind = statusKind(this.statusRaw, this.stack);
    if (kind === 'call' || kind === 'raise') this.setStatus('');
  }

  setStatus(text: string): void {
    // The engine keeps Unity's bare-"s" plural ("Sixs") for parity; players read "Sixes".
    this.statusRaw = (text ?? '').replace(/Sixs/g, 'Sixes');
    this.paintStatus();
  }

  /** v2 status chip: hidden when empty; fold grey, check/call blue, bet/raise gold, all-in hot (named "All-in"). */
  private paintStatus(): void {
    const kind = statusKind(this.statusRaw, this.stack);
    this.bottomBar.el.dataset.st = kind;
    const shown = kind === 'allin' && !/all.?in/i.test(this.statusRaw) ? `All-in ${this.statusRaw.replace(/^\D+/, '')}`.trim() : this.statusRaw;
    this.statusText.setText(shown);
  }

  setRole(role: SeatRole): void {
    this.dealerBadge.setActive(role !== SeatRole.None);
    if (role === SeatRole.None) return;
    // v2: a white "D" disc, violet "SB" / "BB" pills (seatRoleLabel's "S" / "B" read as letters, not blinds).
    const label = role === SeatRole.SmallBlind ? 'SB' : role === SeatRole.BigBlind ? 'BB' : seatRoleLabel(role);
    this.dealerBadge.el.dataset.role = label;
    this.dealerLabel.setText(label);
    this.dealerLabel.setTextColor(ROLE_INK);
  }

  setBot(isBot: boolean): void {
    this.botIndicator.setActive(isBot);
  }

  setFolded(folded: boolean): void {
    if (folded === this.folded) return;
    this.folded = folded;
    // v2: one dim (v2hud.css .v2-fold opacity); the Unity fold brightness on top made avatars nearly black.
    this.root.el.classList.toggle('v2-fold', folded);
    this.root.layout();
  }

  setWinner(winner: boolean): void {
    // v2: the gold plate glow and the "+amount" float are the winner feedback (no Unity Win_Medal ring / crown).
    this.winner.setActive(false);
    this.root.el.classList.toggle('v2-win', winner);
    // TableView.showPotAward sets the new stack, then the winner: the difference is what this pot paid.
    if (winner && this.stack > this.prevStack) this.floatWin(this.stack - this.prevStack);
    this.prevStack = this.stack;
  }

  /** "+20,250" rising from the plate (v2 winner feedback). */
  private floatWin(amount: number): void {
    const el = document.createElement('div');
    el.className = 'v2-winfloat';
    el.textContent = `+${TableMoney.chips(amount)}`;
    this.nameBar.el.append(el);
    window.setTimeout(() => el.remove(), 2500); // v2hud.css .v2-winfloat runs 2.4 s
  }

  resetForNewHand(): void {
    this.setBet();
    this.setStatus('');
    this.setActiveTurn(false);
    this.stopTurnTimer();
    this.hideHandStrength(); // HideHoleCards
    this.setRole(SeatRole.None);
    this.setWinner(false);
    this.setFolded(false);
  }

  /** cardsText is not wired; a cleared hand (null cards) is HideHoleCards, which also hides the strength meter. */
  setHoleCards(card0: Card | null, _card1: Card | null, _faceUp: boolean): void {
    if (!card0) this.hideHandStrength();
  }

  showHandStrength(card0: Card, card1: Card, board: Card[]): void {
    this.strengthActive = true;
    this.strengthHole = [card0, card1];
    this.applyHandStrength(board);
  }

  updateHandStrength(board: Card[]): void {
    if (this.strengthActive) this.applyHandStrength(board);
  }

  hideHandStrength(): void {
    this.strengthActive = false;
    this.hand.setActive(false);
  }

  setActiveTurn(active: boolean): void {
    // v2: the plate glows gold instead of the particle-ring stand-in (VFX_Turn_Highlight stays built, unused).
    this.root.el.classList.toggle('v2-turn', active);
  }

  /**
   * SeatView.RunTurnTimer: fill = remaining / seconds every frame, from (seconds − elapsed) down to 0. The Timer's
   * own Animator (Timer.anim, a 12 s colour/blink loop) is disabled in Name_Canvas.prefab (m_Enabled: 0), so in Unity
   * the coroutine is what shows: a 15 s sweep in the authored #90F8B4 @ 59 %, no colour change, no blink.
   */
  startTurnTimer(seconds: number, elapsed: number): void {
    this.stopTurnTimer();
    const remaining = seconds - Math.max(0, elapsed);
    if (remaining <= 0) return;
    const total = Math.max(0.01, seconds);
    const left = Math.max(0.01, remaining);
    const img = this.timer.image!;
    img.fillAmount = left / total;
    // v2: a ring round the avatar (hud/v2hud.css), green → gold → red, pulsing for the last 5 s; the face stays clear.
    const paint = (fill: number, secondsLeft: number) => {
      const el = this.timer.el;
      el.style.setProperty('--p', fill.toFixed(4));
      el.dataset.tone = fill > 0.5 ? 'ok' : fill > 0.2 ? 'warn' : 'late';
      el.classList.toggle('v2-pulse', secondsLeft <= 5);
      // Your own last 5 s also pulse the action row (v2hud.css html[data-turn-late]), so a timeout is hard to miss.
      if (this.isHero()) document.documentElement.toggleAttribute('data-turn-late', secondsLeft <= 5);
    };
    paint(left / total, left);
    this.timer.setActive(true);
    this.timerTween = ticker.to(
      left,
      (p) => {
        img.fillAmount = (left * (1 - p)) / total;
        paint(img.fillAmount, left * (1 - p));
      },
      Ease.Linear,
    );
  }

  private isHero(): boolean {
    return this.root.el.getAttribute('data-name') === 'Name_Canvas_Player';
  }

  stopTurnTimer(): void {
    if (this.isHero()) document.documentElement.removeAttribute('data-turn-late');
    this.timerTween?.kill();
    this.timerTween = null;
    this.timer.setActive(false);
  }

  setVisible(visible: boolean): void {
    this.root.setActive(visible);
    if (!visible) this.setBet(0);
  }

  get visible(): boolean {
    return this.root.activeSelf;
  }

  /** Screen rects of what this seat draws (avatar, name plate, status pill, D/SB/BB token): bet chips keep clear of them. */
  occupiedRects(): DOMRect[] {
    const out: DOMRect[] = [];
    for (const n of [this.nameBar, this.bottomBar, this.avatar, this.dealerBadge]) {
      if (!n.activeInHierarchy) continue;
      let el: HTMLElement = n.el;
      if (n === this.bottomBar) {
        // The status chip: an empty bar is visibility:hidden (it covers nothing), and a long pill overflows its node, so
        // what's drawn is the inner span.
        if (getComputedStyle(el).visibility === 'hidden') continue;
        el = el.querySelector<HTMLElement>('.u-text > span') ?? el;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    }
    return out;
  }

  /** River-slam name-tag wobble (MMRotationShaker, channel 1). See Shaker for the formula. */
  shake(durationSeconds: number, amplitudeDegrees: number, frequency: number, axis?: [number, number, number]): void {
    this.canvas.shaker.start(durationSeconds, amplitudeDegrees, frequency, axis);
  }

  // ---------------------------------------------------------------- v2 type

  /** Fonts and sizes of the v2 seat plate (positions stay Unity's). Colours are in hud/v2hud.css. */
  private applyV2Type(): void {
    const set = (n: UNode, family: string, size: number, bold = true, minRatio = 0.6) => {
      const t = n.text;
      if (!t) return;
      t.family = family;
      t.bold = bold;
      t.fontSize = size;
      t.max = Math.max(t.max, size);
      // Auto-size may shrink a long name, but never below minRatio of the v2 size (≥ 11 px on a phone).
      t.min = size * minRatio;
      n.render();
    };
    // Canvas units: ≈0.136 px/unit at 1280×720, ≈0.123 on a 390 phone → names ≈12.3 px, money ≥17 px there.
    set(this.nameText, V2_UI, 104, true, 0.75);
    set(this.stackText, V2_DISPLAY, 140, false, 0.7);
    set(this.statusText, V2_UI, 96);
    set(this.dealerLabel, V2_DISPLAY, 96, false);
    const bot = this.botIndicator.find('Text (TMP) (1)');
    if (bot) set(bot, V2_UI, 96);
    set(this.handCategory, V2_UI, 76);
    set(this.handPercent, V2_UI, 76);
    if (this.handCategory.text) this.handCategory.text.upper = false;
  }

  // ---------------------------------------------------------------- hand strength (SeatView.ApplyHandStrength)

  private applyHandStrength(community: Card[]): void {
    const hole = this.strengthHole;
    if (!hole) return;
    const board = community && community.length >= 3 ? community : null;
    const strength = HandStrength.estimate(hole, board);
    const percent = Math.min(100, Math.max(0, roundHalfEven(Math.fround(strength * 100))));

    // v2: the meter draws 1.35× so its label stays ≥ 11 px on a phone (its text box can't grow inside the art).
    this.hand.scale = [HAND_SCALE, HAND_SCALE];
    this.hand.setAsLastSibling();
    // ParkStrengthBesideNameplate: under the name plate / status chip cluster, aligned with the status chip — from
    // the authored layout (fixed), not the live one (the slide-in clips move it).
    const handH = (this.hand.sizeDelta[1] > 1 ? this.hand.sizeDelta[1] : 148) * HAND_SCALE;
    this.hand.anchoredPosition = [this.handAnchorX, this.handClusterBottom - handH * 0.5 - 8];
    this.handPercent.setText(`${percent}%`);
    this.handCategory.setText(sentenceCase(strengthCategory(hole, board)));

    // LayoutStrengthFill: width max(12, track·s) grown from the left; colour red → orange → green.
    const trackW = this.handTrack.sizeDelta[0];
    const s = Math.min(1, Math.max(0, strength));
    const fillW = Math.max(12, trackW * s);
    this.handFill.sizeDelta = [fillW, this.handFill.sizeDelta[1]];
    this.handFill.anchoredPosition = [-trackW * 0.5 + fillW * 0.5, this.handFill.anchoredPosition[1]];
    if (this.handFill.image)
      this.handFill.image.color = s < 0.5 ? lerpColor(STRENGTH_RED, STRENGTH_ORANGE, s * 2) : lerpColor(STRENGTH_ORANGE, STRENGTH_GREEN, (s - 0.5) * 2);
    this.hand.setActive(true);
    this.hand.layout();
  }

  // ---------------------------------------------------------------- turn highlight stand-in

  /**
   * VFX_Turn_Highlight is two particle "Ring" emitters (0.4 s loops, ~1 s life, colour over life #5656FF → #FF65E1 →
   * #C344FF, fading in and out) plus a point light. Approximated with three expanding rings on the same timing.
   */
  private buildHighlight(): UNode {
    const n = new UNode('VFX_Turn_Highlight');
    n.sizeDelta = [500, 500];
    n.el.classList.add('u-turn-vfx');
    const rings: HTMLDivElement[] = [];
    for (let i = 0; i < 3; i++) {
      const r = document.createElement('div');
      r.className = 'u-turn-ring';
      n.el.append(r);
      rings.push(r);
    }
    const c0 = hexColor('#5656FF');
    const c1 = hexColor('#FF65E1');
    const c2 = hexColor('#C344FF');
    const draw = (time: number) => {
      rings.forEach((r, i) => {
        const age = (time + i * 0.4) % 1.2;
        if (age > 1) {
          r.style.opacity = '0';
          return;
        }
        const col = age < 0.5 ? lerpColor(c0, c1, age / 0.5) : lerpColor(c1, c2, (age - 0.5) / 0.5);
        const alpha = age < 0.5 ? age / 0.5 : 1 - (age - 0.5) / 0.5;
        r.style.opacity = String(alpha * 0.9);
        r.style.borderColor = cssColor({ ...col, a: 1 });
        r.style.boxShadow = `0 0 40px ${cssColor({ ...col, a: 0.8 })}, inset 0 0 30px ${cssColor({ ...col, a: 0.6 })}`;
        r.style.transform = `scale(${1 + age * 0.28})`;
      });
    };
    n.onEnable.push(() => {
      this.highlightTween?.kill();
      const span = 1e6;
      draw(0);
      this.highlightTween = ticker.to(span, (p) => draw(p * span), Ease.Linear);
    });
    n.onDisable.push(() => {
      this.highlightTween?.kill();
      this.highlightTween = null;
    });
    return n;
  }
}

function strengthCategory(hole: [Card, Card], community: Card[] | null): string {
  if (!community || community.length < 3) return hole[0].rank === hole[1].rank ? 'PAIR' : 'HIGH CARD';
  switch (HandEvaluator.evaluateHand(hole, community).category) {
    case HandCategory.StraightFlush: return 'STRAIGHT FLUSH';
    case HandCategory.FourOfAKind: return 'FOUR OF A KIND';
    case HandCategory.FullHouse: return 'FULL HOUSE';
    case HandCategory.Flush: return 'FLUSH';
    case HandCategory.Straight: return 'STRAIGHT';
    case HandCategory.ThreeOfAKind: return 'THREE OF A KIND';
    case HandCategory.TwoPair: return 'TWO PAIR';
    case HandCategory.Pair: return 'PAIR';
    default: return 'HIGH CARD';
  }
}
