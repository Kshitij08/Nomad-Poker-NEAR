/**
 * The action row + raise (Confirm) panel on the screen-space overlay `Canvas`, port of Game/UI/BettingPanel.cs in its
 * designed two-step layout (root unset → the three buttons stay visible and are only made non-interactable between
 * turns; Bet/Raise opens Confirm_Panel). Rules come from core/orchestration/bettingPanelModel.ts.
 *
 * Canvas: Screen Space Overlay, CanvasScaler Scale With Screen Size 1920×1080, match 0.5 → scale factor
 * sqrt((W/1920)·(H/1080)); every node keeps its authored anchors, so 20:9 widens the canvas and the row stays centred.
 */
import {
  bettingPanelState,
  checkCallAction,
  clampAmount,
  PlayerAction,
  presetAmount,
  TableMoney,
  wagerAction,
  type BettingPanelPort,
  type BettingPanelState,
  type LegalActions,
} from '@nomad/engine';
import { evaluateCurve, type Keyframe } from '../anim/animCurve';
import { Ease, ticker, type Tween } from '../anim/tween';
import { animatorOnEnable, uiClip } from './uiClips';
import { buildNode, HUD_DATA, UNode, type RGBA } from './unityUi';
import { overlayScale } from '../layout/portraitRects';
import { portraitBettingRects } from '../layout/portraitHud';

// ---------------------------------------------------------------- Selectable transitions

type SelState = 'Normal' | 'Highlighted' | 'Pressed' | 'Selected' | 'Disabled';

/** UI_Button.controller: each state's clip sets the plate Image colour; Pressed's clip is empty (write defaults). */
const clipRgb = (name: string): number | null => {
  const c = uiClip(name).curves.find((k) => k.attribute === 'm_Color.r');
  return c ? evaluateCurve(c.keys as Keyframe[], 0) : null;
};
const ANIM_RGB: Record<SelState, number | null> = {
  Normal: clipRgb('UI_Btn_Normal'),
  Highlighted: clipRgb('UI_Btn_Highlighted'),
  Pressed: clipRgb('UI_Btn_Pressed'),
  Selected: clipRgb('UI_Btn_Normal'),
  Disabled: clipRgb('UI_Btn_Disabled'),
};
/** Any-state transition durations (fixed, seconds). */
const ANIM_FADE: Record<SelState, number> = { Normal: 0.08, Highlighted: 0.08, Pressed: 0.03, Selected: 0.08, Disabled: 0.1 };

interface ColorBlock {
  normal: RGBA;
  highlighted: RGBA;
  pressed: RGBA;
  disabled: RGBA;
  fade: number;
}

class UButton {
  interactable = true;
  private hovered = false;
  private down = false;
  private state: SelState = 'Normal';
  private fade: Tween | null = null;
  onClick: (() => void) | null = null;
  onPointerDown: (() => void) | null = null;
  onPointerUp: (() => void) | null = null;

  constructor(
    readonly node: UNode,
    private readonly transition: 'Animation' | 'ColorTint',
    private readonly colors: ColorBlock | null = null,
  ) {
    const el = node.el;
    el.classList.add('u-interactive');
    el.addEventListener('pointerenter', () => {
      this.hovered = true;
      this.refresh();
    });
    el.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.down = false;
      this.onPointerUp?.();
      this.refresh();
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.down = true;
      if (this.interactable) this.onPointerDown?.();
      this.refresh();
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      const wasDown = this.down;
      this.down = false;
      this.onPointerUp?.();
      this.refresh();
      if (wasDown && this.interactable && this.node.activeInHierarchy) this.onClick?.();
    });
    // An Animator restarts at its default state (Normal) on enable, then Selectable snaps to the current state.
    node.onEnable.push(() => {
      this.hovered = false;
      this.down = false;
      this.apply(this.target(), true);
    });
  }

  setInteractable(v: boolean): void {
    if (v === this.interactable) return;
    this.interactable = v;
    this.refresh();
  }

  /** ExecuteEvents.submitHandler (keyboard shortcut): fires when the button is on screen and interactable. */
  submit(): void {
    if (this.interactable && this.node.activeInHierarchy) this.onClick?.();
  }

  private target(): SelState {
    if (!this.interactable) return 'Disabled';
    if (this.down && this.hovered) return 'Pressed';
    if (this.hovered) return 'Highlighted';
    return 'Normal';
  }

  refresh(instant = false): void {
    const s = this.target();
    if (s !== this.state || instant) this.apply(s, instant);
  }

  private apply(s: SelState, instant: boolean): void {
    this.state = s;
    this.fade?.kill();
    const n = this.node;
    if (!n.image) return;
    const from: RGBA = this.transition === 'Animation' ? { ...(n.imageColorOverride ?? n.image.color) } : { ...n.imageTint };
    let to: RGBA;
    let dur: number;
    if (this.transition === 'Animation') {
      const v = ANIM_RGB[s];
      to = v === null ? { ...n.image.color } : { r: v, g: v, b: v, a: n.image.color.a };
      dur = ANIM_FADE[s];
    } else {
      const c = this.colors!;
      to = { ...(s === 'Disabled' ? c.disabled : s === 'Pressed' ? c.pressed : s === 'Highlighted' ? c.highlighted : c.normal) };
      dur = c.fade;
    }
    const set = (col: RGBA) => {
      if (this.transition === 'Animation') n.imageColorOverride = col;
      else n.imageTint = col;
      n.render();
    };
    if (instant || dur <= 0) return set(to);
    this.fade = ticker.to(
      dur,
      (p) => set({ r: from.r + (to.r - from.r) * p, g: from.g + (to.g - from.g) * p, b: from.b + (to.b - from.b) * p, a: from.a + (to.a - from.a) * p }),
      Ease.Linear,
    );
  }
}

// ---------------------------------------------------------------- the panel

const ROW = ['Call', 'Check/fold', 'Callany or raise', 'Confirm_Panel'];
const KEYS = {
  fold: ['KeyF'],
  checkCall: ['KeyC'],
  betRaise: ['KeyR'],
  confirm: ['Enter', 'NumpadEnter'],
  close: ['Escape'],
  increase: ['ArrowUp', 'Equal', 'NumpadAdd'],
  decrease: ['ArrowDown', 'Minus', 'NumpadSubtract'],
  allIn: ['KeyA'],
};
const STEP_REPEAT_DELAY = 0.4;
const STEP_REPEAT_INTERVAL = 0.08;

export class BettingPanelView implements BettingPanelPort {
  readonly root = new UNode('Canvas');
  private readonly fold: UButton;
  private readonly checkCall: UButton;
  private readonly betRaise: UButton;
  private readonly foldLabel: UNode;
  private readonly checkCallLabel: UNode;
  private readonly betRaiseLabel: UNode;
  private readonly panel: UNode;
  private readonly confirm: UButton;
  private readonly close: UButton;
  private readonly plus: UButton;
  private readonly minus: UButton;
  private readonly presets: [UButton, 'MIN' | '1/4' | '1/2' | '3/4' | 'ALL IN'][];
  private readonly amountLabel: UNode;
  private readonly slider: UNode;
  private readonly fillRect: UNode;
  private readonly handleRect: UNode;
  private readonly handleArea: UNode;

  private onChosen: ((a: PlayerAction) => void) | null = null;
  private legal: LegalActions | null = null;
  private myCurrentBet = 0;
  private state: BettingPanelState | null = null;
  private value = 0;
  private sliderMin = 0;
  private sliderMax = 1;
  private step = 1;
  private holdDir = 0;
  private holdKeys: string[] | null = null;
  private nextRepeatAt = 0;
  private holdTimer = 0;
  showing = false;
  scaleFactor = 1;
  private portraitRects: ReturnType<typeof portraitBettingRects> | null = null;

  constructor(parent: HTMLElement) {
    const canvas = HUD_DATA.canvases.find((c) => c.role === 'screen-hud')!;
    this.root.el.classList.add('u-screen-canvas');
    for (const c of canvas.root.children ?? []) if (ROW.includes(c.name)) this.root.add(buildNode(c, { skip: (n) => n.name === 'dot' }));
    parent.append(this.root.el);

    const req = (p: string) => {
      const n = this.root.find(p);
      if (!n) throw new Error(`Canvas/${p} missing`);
      return n;
    };
    const tint = (path: string): ColorBlock => {
      const node = canvas.root.children!.find((c) => c.name === 'Confirm_Panel')!;
      const find = (n: typeof node, parts: string[]): typeof node | undefined =>
        parts.length ? find(n.children!.find((c) => c.name === parts[0])!, parts.slice(1)) : n;
      const b = (find(node, path.split('/'))?.components as { button?: { colors: Record<string, { rgba: number[] }> & { fadeDuration: number } } })?.button;
      const col = (k: string): RGBA => {
        const [r, g, bb, a] = b!.colors[k].rgba;
        return { r, g, b: bb, a };
      };
      return { normal: col('normal'), highlighted: col('highlighted'), pressed: col('pressed'), disabled: col('disabled'), fade: b!.colors.fadeDuration as unknown as number };
    };

    this.checkCall = new UButton(req('Call'), 'Animation');
    this.fold = new UButton(req('Check/fold'), 'Animation');
    this.betRaise = new UButton(req('Callany or raise'), 'Animation');
    this.checkCallLabel = req('Call/Text (TMP)');
    this.foldLabel = req('Check/fold/Text (TMP)');
    this.betRaiseLabel = req('Callany or raise/Text (TMP)');
    this.panel = req('Confirm_Panel');
    this.panel.el.classList.add('u-blocker'); // the panel Image is a raycast target over the action row
    this.confirm = new UButton(req('Confirm_Panel/Confirm'), 'Animation');
    this.close = new UButton(req('Confirm_Panel/close'), 'Animation');
    this.plus = new UButton(req('Confirm_Panel/Value/Plus'), 'ColorTint', tint('Value/Plus'));
    this.minus = new UButton(req('Confirm_Panel/Value/Minus'), 'ColorTint', tint('Value/Minus'));
    this.presets = [
      [new UButton(req('Confirm_Panel/button_min'), 'Animation'), 'MIN'],
      [new UButton(req('Confirm_Panel/button_1/4'), 'Animation'), '1/4'],
      [new UButton(req('Confirm_Panel/button_1/2'), 'Animation'), '1/2'],
      [new UButton(req('Confirm_Panel/button_3/4'), 'Animation'), '3/4'],
      [new UButton(req('Confirm_Panel/button_all-in'), 'Animation'), 'ALL IN'],
    ];
    this.amountLabel = req('Confirm_Panel/Value/Image (4)/Text (TMP)');
    this.slider = req('Confirm_Panel/Slider');
    this.fillRect = req('Confirm_Panel/Slider/Fill Area');
    this.handleArea = req('Confirm_Panel/Slider/Handle Slide Area');
    this.handleRect = req('Confirm_Panel/Slider/Handle Slide Area/Handle');

    animatorOnEnable(this.panel, uiClip('ConfirmPanel_In'));

    this.fold.onClick = () => this.choose(PlayerAction.fold());
    this.checkCall.onClick = () => this.legal && this.choose(checkCallAction(this.legal));
    this.betRaise.onClick = () => this.panel.setActive(true); // pick an amount, then Confirm submits
    this.confirm.onClick = () => this.legal && this.choose(wagerAction(this.legal, this.value));
    this.close.onClick = () => this.panel.setActive(false);
    for (const [b, p] of this.presets) b.onClick = () => this.legal && this.setAmount(presetAmount(p, this.legal, this.myCurrentBet));
    this.wireStep(this.plus, +1);
    this.wireStep(this.minus, -1);
    this.wireSlider();
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));

    this.panel.setActive(false);
    this.layout(parent.clientWidth, parent.clientHeight);
    this.hide();
    for (const b of [this.fold, this.checkCall, this.betRaise, this.plus, this.minus]) b.refresh(true);
  }

  /** CanvasScaler (Scale With Screen Size, 1920×1080, match 0.5) → root size in canvas units + CSS scale. */
  layout(w: number, h: number): void {
    // Portrait (layout/portraitHud.ts): 720-wide reference and a thumb-sized row + stacked raise panel.
    if (!(w > 0 && h > 0)) return; // zero-size viewport (hidden tab / pane): the scale would be 0 and w / s NaN; the next resize lays out
    const s = overlayScale(w, h);
    this.scaleFactor = s;
    this.root.sizeDelta = [w / s, h / s];
    this.root.renderScale = s;
    (this.portraitRects ??= portraitBettingRects(this.root)).apply();
    this.root.layout();
    this.root.el.style.transform = `scale(${s})`;
  }

  // ---------------------------------------------------------------- BettingPanelPort

  show(legal: LegalActions, myCurrentBet: number, onChosen: (a: PlayerAction) => void): void {
    this.legal = legal;
    this.myCurrentBet = myCurrentBet;
    this.onChosen = onChosen;
    this.showing = true;
    this.panel.setActive(false); // opens on Bet/Raise

    const s = bettingPanelState(legal, myCurrentBet);
    this.state = s;
    this.fold.setInteractable(s.foldEnabled);
    this.foldLabel.setText(s.foldLabel);
    this.checkCallLabel.setText(s.checkCallLabel);
    this.checkCall.setInteractable(s.checkCallEnabled);
    this.betRaise.setInteractable(s.betRaiseEnabled);
    this.betRaiseLabel.setText(s.betRaiseLabel);
    this.step = s.step;
    this.endHold();
    if (s.betRaiseEnabled) {
      this.sliderMin = s.sliderMin;
      this.sliderMax = s.sliderMax;
      this.setAmount(s.initialAmount);
    } else {
      this.amountLabel.setText('');
      this.plus.setInteractable(false);
      this.minus.setInteractable(false);
    }
  }

  hide(): void {
    this.showing = false;
    this.onChosen = null;
    this.endHold();
    this.plus.setInteractable(false);
    this.minus.setInteractable(false);
    this.panel.setActive(false);
    this.fold.setInteractable(false);
    this.checkCall.setInteractable(false);
    this.betRaise.setInteractable(false);
  }

  /** True while the Confirm (raise) panel is open. */
  get amountPanelOpen(): boolean {
    return this.panel.activeSelf;
  }

  // ---------------------------------------------------------------- amount

  private setAmount(v: number): void {
    const clamped = this.state ? clampAmount(this.state, v) : v;
    this.value = clamped;
    this.amountLabel.setText(TableMoney.pot(clamped));
    this.plus.setInteractable(clamped < this.sliderMax);
    this.minus.setInteractable(clamped > this.sliderMin);
    this.layoutSlider();
  }

  private nudge(dir: number): void {
    if (!this.state) return;
    this.setAmount(this.value + dir * this.step);
  }

  /** Slider: Fill Area anchorMax.x and Handle anchors.x = normalized value. */
  private layoutSlider(): void {
    const range = this.sliderMax - this.sliderMin;
    const n = range > 0 ? (this.value - this.sliderMin) / range : 0;
    this.fillRect.anchorMax = [n, this.fillRect.anchorMax[1]];
    this.handleRect.anchorMin = [n, this.handleRect.anchorMin[1]];
    this.handleRect.anchorMax = [n, this.handleRect.anchorMax[1]];
    if (this.slider.activeInHierarchy) this.slider.layout();
  }

  private wireSlider(): void {
    const el = this.slider.el;
    el.classList.add('u-interactive');
    let offset = 0;
    let dragging = false;
    const valueAt = (clientX: number) => {
      const r = this.handleArea.el.getBoundingClientRect();
      const n = Math.min(1, Math.max(0, (clientX - offset - r.left) / (r.width || 1)));
      return Math.round(this.sliderMin + n * (this.sliderMax - this.sliderMin));
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.showing || !this.state?.betRaiseEnabled) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      const h = this.handleRect.el.getBoundingClientRect();
      // Grabbing the handle keeps its offset; clicking the track jumps the handle under the pointer.
      offset = e.clientX >= h.left && e.clientX <= h.right ? e.clientX - (h.left + h.width / 2) : 0;
      this.setAmount(valueAt(e.clientX));
    });
    el.addEventListener('pointermove', (e) => dragging && this.setAmount(valueAt(e.clientX)));
    const end = () => (dragging = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** +/-: a tap nudges one step (onClick); holding repeats after 0.4 s every 0.08 s (unscaled time). */
  private wireStep(b: UButton, dir: number): void {
    b.onClick = () => this.nudge(dir);
    b.onPointerDown = () => this.beginHold(dir, null);
    b.onPointerUp = () => this.holdKeys === null && this.endHold();
  }

  private beginHold(dir: number, keys: string[] | null): void {
    this.holdDir = dir;
    this.holdKeys = keys;
    this.nextRepeatAt = performance.now() / 1000 + STEP_REPEAT_DELAY;
    if (!this.holdTimer)
      this.holdTimer = window.setInterval(() => {
        if (this.holdDir === 0) return;
        const now = performance.now() / 1000;
        if (now < this.nextRepeatAt) return;
        this.nudge(this.holdDir);
        this.nextRepeatAt = now + STEP_REPEAT_INTERVAL;
      }, 10);
  }

  private endHold(): void {
    this.holdDir = 0;
    this.holdKeys = null;
    if (this.holdTimer) window.clearInterval(this.holdTimer);
    this.holdTimer = 0;
  }

  // ---------------------------------------------------------------- keyboard (PollKeyboard)

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      this.endHold();
      return;
    }
    if (!down) {
      if (this.holdKeys?.includes(e.code)) this.endHold();
      return;
    }
    if (!this.showing || e.repeat) return;
    const is = (k: string[]) => k.includes(e.code);
    if (is(KEYS.fold)) return this.fold.submit();
    if (is(KEYS.checkCall)) return this.checkCall.submit();
    const picking = this.betRaise.interactable && this.panel.activeInHierarchy;
    if (picking) {
      if (is(KEYS.confirm)) return this.confirm.submit();
      if (is(KEYS.close)) return this.close.submit();
      if (is(KEYS.allIn) && this.legal) this.setAmount(this.legal.maxRaiseTo);
      if (is(KEYS.increase)) {
        this.nudge(+1);
        this.beginHold(+1, KEYS.increase);
      }
      if (is(KEYS.decrease)) {
        this.nudge(-1);
        this.beginHold(-1, KEYS.decrease);
      }
    }
    if (is(KEYS.betRaise) && !picking) this.betRaise.submit();
  }

  private choose(action: PlayerAction): void {
    const cb = this.onChosen;
    this.onChosen = null;
    if (!cb) return; // stale click while it is not our turn
    this.panel.setActive(false);
    cb(action);
  }
}
