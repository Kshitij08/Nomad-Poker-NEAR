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

  private readonly foldedBrightness: number;
  private folded = false;
  private timerTween: Tween | null = null;
  private highlightTween: Tween | null = null;
  private strengthActive = false;
  private strengthHole: [Card, Card] | null = null;

  constructor(data: CanvasData, parent: HTMLElement) {
    const sv = HUD_DATA.tableView.seatViews.find((s) => s.canvas === data.name);
    this.mirrored = !!sv?.mirrored;
    this.foldedBrightness = Number((sv?.fields as Record<string, string> | undefined)?.foldedBrightness ?? 0.6);

    this.root = buildNode(data.root, { skip: (n) => SKIP.has(n.name) });
    this.root.el.classList.add('u-seat');
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

    // VFX_Turn_Highlight (particle rings + light, not extractable) sits between Win_Medal and bg_circle.
    this.highlight = this.buildHighlight();
    const bgIndex = this.graphics.children.indexOf(req('Graphics/bg_circle'));
    this.graphics.add(this.highlight, bgIndex);
    this.highlight.setActive(false);

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
    this.stackText.setText(TableMoney.chips(stack));
  }

  /** betText is not wired in Test.unity. */
  setBet(): void {}

  setStatus(text: string): void {
    this.statusText.setText(text ?? '');
  }

  setRole(role: SeatRole): void {
    this.dealerBadge.setActive(role !== SeatRole.None);
    if (role === SeatRole.None) return;
    this.dealerLabel.setText(seatRoleLabel(role));
    this.dealerLabel.setTextColor(ROLE_INK);
  }

  setBot(isBot: boolean): void {
    this.botIndicator.setActive(isBot);
  }

  setFolded(folded: boolean): void {
    if (folded === this.folded) return;
    this.folded = folded;
    this.root.foldBrightness = folded ? this.foldedBrightness : null;
    this.root.layout();
  }

  setWinner(winner: boolean): void {
    this.winner.setActive(winner);
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
    this.highlight.setActive(active);
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
    this.timer.setActive(true);
    this.timerTween = ticker.to(
      left,
      (p) => {
        img.fillAmount = (left * (1 - p)) / total;
        this.timer.render();
      },
      Ease.Linear,
    );
  }

  stopTurnTimer(): void {
    this.timerTween?.kill();
    this.timerTween = null;
    this.timer.setActive(false);
  }

  setVisible(visible: boolean): void {
    this.root.setActive(visible);
  }

  get visible(): boolean {
    return this.root.activeSelf;
  }

  /** River-slam name-tag wobble (MMRotationShaker, channel 1). See Shaker for the formula. */
  shake(durationSeconds: number, amplitudeDegrees: number, frequency: number, axis?: [number, number, number]): void {
    this.canvas.shaker.start(durationSeconds, amplitudeDegrees, frequency, axis);
  }

  // ---------------------------------------------------------------- hand strength (SeatView.ApplyHandStrength)

  private applyHandStrength(community: Card[]): void {
    const hole = this.strengthHole;
    if (!hole) return;
    const board = community && community.length >= 3 ? community : null;
    const strength = HandStrength.estimate(hole, board);
    const percent = Math.min(100, Math.max(0, roundHalfEven(Math.fround(strength * 100))));

    this.hand.scale = [1, 1];
    this.hand.setAsLastSibling();
    // ParkStrengthBesideNameplate: under the name plate / status chip cluster, aligned with the status chip.
    const nameH = this.nameBar.h > 1 ? this.nameBar.h : this.nameBar.sizeDelta[1];
    const barH = this.bottomBar.h > 1 ? this.bottomBar.h : this.bottomBar.sizeDelta[1];
    const handH = this.hand.sizeDelta[1] > 1 ? this.hand.sizeDelta[1] : 148;
    const clusterBottom = Math.min(this.nameBar.anchoredPosition[1] - nameH * 0.5, this.bottomBar.anchoredPosition[1] - barH * 0.5);
    this.hand.anchoredPosition = [this.bottomBar.anchoredPosition[0], clusterBottom - handH * 0.5 - 8];
    this.handPercent.setText(`${percent}%`);
    this.handCategory.setText(strengthCategory(hole, board));

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
