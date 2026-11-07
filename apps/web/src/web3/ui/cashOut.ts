/**
 * 'cash-out': Net/CashOutPanel.cs on the CashOut_Panel object of the table HUD canvas (Assets/Test/Test.unity, a
 * CashOut_Panel.prefab instance). One panel, three states of the same act:
 *   Confirm — "Cash out 1,567 chips for 0.1567 SOL", Yes / No. Nothing is signed until Yes.
 *   Working — "Cashing out … SOL…", only Close (which hides the panel; the result re-opens it).
 *   Result  — "Successfully cashed out …" with the signature on a chip (copies it and opens the explorer), or
 *             "Failed to cash out …" with "Error:\n<message>".
 * The panel is built from unity-hud.json (extract-unity-hud.mjs already exports it with the overlay canvas, sprites
 * in assets/ui) and opened/closed the way its Animator does it: the SettingsPanel controller's Open / Close
 * triggers cross-fade (0.28 s / 0.2 s) between the Closed pose (alpha 0, window ×0.85, no raycasts) and Open
 * (alpha 1, window ×1). Buttons play UI_Button.controller's colour states.
 *
 * Params: { chips: number; sol: string; onConfirm: () => Promise<CashOutResult> } — `sol` is the SOL figure already
 * formatted ("0.1567"); onConfirm runs after Yes (a throw is reported as the failure).
 */
import type { AppContext, Screen } from '../../app/app';
import { evaluateCurve, type Keyframe } from '../../anim/animCurve';
import { Ease, ticker, type Tween } from '../../anim/tween';
import { uiClip } from '../../hud/uiClips';
import { buildNode, HUD_DATA, UNode, type NodeData } from '../../hud/unityUi';
import anims from '../../data/ui-anims.json';
import { formatN0 } from '../per/format';
import { copyText } from './perUi';
import { closeScreen } from './lazy';
import { applyLayoutGroups, pairNodes, UButton, UCanvas, uiButtonAnimator, type SelState } from './ugui';
import { w3 } from '../services';

export interface CashOutResult {
  success: boolean;
  signature: string | null;
  error?: string | null;
}
export interface CashOutParams {
  chips: number;
  sol: string;
  onConfirm: () => Promise<CashOutResult>;
}

/** CashOutPanel's serialized wording (the scene instance's values; they match the C# defaults). */
interface Wording {
  confirmFormat: string;
  workingFormat: string;
  successFormat: string;
  failureFormat: string;
  txnFormat: string;
  errorFormat: string;
  openTrigger: string;
  closeTrigger: string;
}
const DEFAULT_WORDING: Wording = {
  confirmFormat: 'Cash out {0} chips for {1} SOL',
  workingFormat: 'Cashing out {0} chips for {1} SOL…',
  successFormat: 'Successfully cashed out {0} chips for {1} SOL',
  failureFormat: 'Failed to cash out {0} chips for {1} SOL',
  txnFormat: 'txn id:\n{0}',
  errorFormat: 'Error:\n{0}',
  openTrigger: 'Open',
  closeTrigger: 'Close',
};

/** string.Format with positional {0} {1}. */
export const format = (f: string, ...args: string[]): string => f.replace(/\{(\d+)\}/g, (m, i: string) => args[Number(i)] ?? m);

function findPanel(): NodeData | null {
  const find = (n: NodeData): NodeData | null => {
    if (n.name === 'CashOut_Panel') return n;
    for (const c of n.children ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  for (const c of HUD_DATA.canvases) {
    const r = find(c.root);
    if (r) return r;
  }
  return null;
}

/** The CashOutPanel component's fields on the panel ("other" scripts in unity-hud.json). */
function wordingOf(d: NodeData): Wording {
  const other = (d.components as { other?: { script?: string; fields?: Partial<Wording> }[] } | undefined)?.other ?? [];
  const f = other.find((o) => o.script === 'CashOutPanel')?.fields ?? {};
  const w = { ...DEFAULT_WORDING };
  for (const k of Object.keys(w) as (keyof Wording)[]) if (typeof f[k] === 'string' && f[k]) w[k] = f[k] as string;
  return w;
}

// ---- the Animator (SettingsPanel.controller)

interface CtlTransition { to: string; conditions: { parameter: string }[]; duration: number }
interface CtlState { name: string; clip: string; transitions: CtlTransition[] }
interface Ctl { layers: { defaultState: string; states: CtlState[] }[]; anyStateTransitions?: CtlTransition[] }
const CONTROLLERS = (anims as unknown as { controllers: Record<string, Ctl> }).controllers;

interface Pose { alpha: number; scale: [number, number] }
/** A static state clip's pose: CanvasGroup alpha on the root, localScale of "window". */
function poseOf(clipPath: string): Pose {
  const clip = uiClip(clipPath.split('/').pop()!.replace(/\.anim$/, ''));
  const at = (path: string, attr: string, d: number) => {
    const c = clip.curves.find((k) => k.path === path && k.attribute === attr);
    return c ? evaluateCurve(c.keys as Keyframe[], 0) : d;
  };
  return { alpha: at('', 'm_Alpha', 1), scale: [at('window', 'm_LocalScale.x', 1), at('window', 'm_LocalScale.y', 1)] };
}

/** UI_Button.controller: each state's clip RGB on the plate (null = the clip leaves it authored), any-state fades. */
function uiButtonStates(): { rgb: Record<SelState, number | null>; fade: Record<SelState, number> } {
  const ctl = CONTROLLERS['Assets/Test/Animations/UI_Button.controller'];
  const rgb = {} as Record<SelState, number | null>;
  const fade = { Normal: 0.08, Highlighted: 0.08, Pressed: 0.08, Selected: 0.08, Disabled: 0.08 } as Record<SelState, number>;
  for (const s of ctl?.layers[0]?.states ?? []) {
    let v: number | null = null;
    try {
      const c = uiClip(s.clip.split('/').pop()!.replace(/\.anim$/, '')).curves.find((k) => k.attribute === 'm_Color.r');
      v = c ? evaluateCurve(c.keys as Keyframe[], 0) : null;
    } catch {
      v = null;
    }
    rgb[s.name as SelState] = v;
  }
  for (const t of ctl?.anyStateTransitions ?? []) fade[t.to as SelState] = t.duration;
  return { rgb, fade };
}

type Phase = 'confirm' | 'working' | 'result';

export class CashOutScreen implements Screen {
  readonly overlay = true;
  private root!: HTMLElement;
  private canvas: UCanvas | null = null;
  private panel!: UNode;
  private window!: UNode;
  private message: UNode | null = null;
  private error: UNode | null = null;
  private txnRoot: UNode | null = null;
  private txnLabel: UNode | null = null;
  private buttons = new Map<string, UButton>();
  private wording = DEFAULT_WORDING;
  private params!: CashOutParams;
  private phase: Phase = 'confirm';
  private signature: string | null = null;
  private open = false;
  private gone = false;
  private fade: Tween | null = null;
  private poses: Record<string, Pose> = {};
  private durations = { open: 0.28, close: 0.2 };
  private pairs = new Map<UNode, NodeData>();

  constructor(private readonly ctx: AppContext) {}

  mount(root: HTMLElement, params?: unknown): void {
    this.root = root;
    this.params = params as CashOutParams;
    const data = findPanel();
    if (!data) throw new Error('[CashOutPanel] CashOut_Panel is not in unity-hud.json');
    this.wording = wordingOf(data);
    this.readAnimator(data);

    const canvasRoot = new UNode('Canvas');
    this.panel = buildNode(data, {});
    canvasRoot.add(this.panel);
    const pairs = (this.pairs = pairNodes(this.panel, data));
    this.canvas = new UCanvas(root, canvasRoot);
    this.canvas.afterLayout = () => applyLayoutGroups(this.panel, pairs);
    this.window = this.panel.find('window')!;

    // CashOutPanel.Resolve: every part by name.
    const named = (n: string, ...m: string[]) => {
      const t = n.replace(/[ _]/g, '').toLowerCase();
      return m.some((x) => t.includes(x));
    };
    let confirm: UNode | null = null, cancel: UNode | null = null, close: UNode | null = null, txnButton: UNode | null = null;
    for (const n of this.panel.walk()) {
      if (n.text) {
        if (!this.message && named(n.name, 'subheading', 'message')) this.message = n;
        else if (!this.error && named(n.name, 'error')) this.error = n;
      }
    }
    const buttonNodes = [...pairs].filter(([, d]) => (d.components as { button?: unknown } | undefined)?.button).map(([n]) => n);
    for (const b of buttonNodes) {
      if (!confirm && named(b.name, 'yes', 'confirm')) confirm = b;
      else if (!cancel && named(b.name, 'no', 'cancel')) cancel = b;
      else if (!close && named(b.name, 'close')) close = b;
      else if (!txnButton && named(b.name, 'id', 'txn', 'signature')) txnButton = b;
    }
    if (txnButton) {
      this.txnLabel = [...txnButton.walk()].find((n) => n.text) ?? null;
      const parent = txnButton.parent;
      this.txnRoot = parent && parent !== this.panel && named(parent.name, 'id', 'txn', 'signature') ? parent : txnButton;
    }
    const states = uiButtonStates();
    const bind = (key: string, n: UNode | null, fn: () => void) => {
      if (!n) return;
      const b = new UButton(n, uiButtonAnimator(n, states.rgb, states.fade));
      b.onClick = () => {
        b.deselect();
        fn();
      };
      this.buttons.set(key, b);
    };
    bind('confirm', confirm, () => void this.onConfirm());
    bind('cancel', cancel, () => this.close());
    bind('close', close, () => this.close());
    bind('txn', txnButton, () => this.onTxn());

    // The Animator's default state is Closed; activating the panel shows nothing until the Open trigger.
    this.panel.setActive(true);
    this.applyPose(this.poses.Closed ?? { alpha: 0, scale: [0.85, 0.85] });
    this.canvas.layout();

    if (!confirm) {
      // A missing Yes button = no dialog authored: cash out without asking (CashOutPanel.AskConfirm).
      console.warn('[CashOutPanel] No confirm button — cashing out without asking.');
      void this.onConfirm();
      return;
    }
    this.setMessage(this.wording.confirmFormat);
    this.showParts(true, false, false, false);
    this.playOpen();
  }

  private readAnimator(d: NodeData): void {
    const ctlPath = (d.components as { animator?: { controller?: string } } | undefined)?.animator?.controller ?? '';
    const ctl = CONTROLLERS[ctlPath];
    if (!ctl) return;
    for (const s of ctl.layers[0]?.states ?? []) {
      try {
        this.poses[s.name] = poseOf(s.clip);
      } catch {
        /* a clip that isn't exported: fall back to the defaults */
      }
      for (const t of s.transitions) {
        const trig = t.conditions[0]?.parameter;
        if (trig === this.wording.openTrigger) this.durations.open = t.duration;
        if (trig === this.wording.closeTrigger) this.durations.close = t.duration;
      }
    }
  }

  private applyPose(p: Pose): void {
    this.panel.groupAlpha = p.alpha;
    this.window.scale = [p.scale[0], p.scale[1]];
    this.panel.layout();
    applyLayoutGroups(this.panel, this.pairs);
  }

  /** Cross-fades from the current pose to a state's pose (Animator transition, fixed duration). */
  private crossFade(to: Pose, duration: number, done?: () => void): void {
    this.fade?.kill();
    const from: Pose = { alpha: this.panel.groupAlpha, scale: [this.window.scale[0], this.window.scale[1]] };
    this.fade = ticker.to(duration, (t) => {
      this.panel.groupAlpha = from.alpha + (to.alpha - from.alpha) * t;
      this.window.scale = [from.scale[0] + (to.scale[0] - from.scale[0]) * t, from.scale[1] + (to.scale[1] - from.scale[1]) * t];
      this.panel.el.style.opacity = String(this.panel.groupAlpha);
      this.window.layout();
    }, Ease.Linear);
    if (done) this.fade.onComplete(done);
  }

  private playOpen(): void {
    this.open = true;
    this.root.style.visibility = '';
    this.root.style.pointerEvents = 'auto'; // CanvasGroup interactable / blocksRaycasts (Open clip)
    this.crossFade(this.poses.Open ?? { alpha: 1, scale: [1, 1] }, this.durations.open);
  }

  /** CashOutPanel.Close: the Closed state hides it (alpha, raycasts, scale). */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.style.pointerEvents = 'none';
    this.crossFade(this.poses.Closed ?? { alpha: 0, scale: [0.85, 0.85] }, this.durations.close, () => {
      // Hidden while the cash-out is still in flight: the result re-opens the panel. Otherwise the dialog is done.
      if (this.phase === 'working') this.root.style.visibility = 'hidden';
      else closeScreen(this.ctx, this.root);
    });
  }

  private async onConfirm(): Promise<void> {
    if (this.phase !== 'confirm') return;
    this.phase = 'working';
    this.setMessage(this.wording.workingFormat);
    this.showParts(false, true, false, false);
    if (!this.open) this.playOpen();
    let r: CashOutResult;
    try {
      r = await this.params.onConfirm();
    } catch (e) {
      r = { success: false, signature: null, error: e instanceof Error ? e.message : String(e) };
    }
    if (this.gone) return;
    this.phase = 'result';
    if (r.success) {
      this.signature = r.signature || null;
      this.setMessage(this.wording.successFormat);
      if (this.signature) this.txnLabel?.setText(format(this.wording.txnFormat, this.signature));
      this.showParts(false, true, !!this.signature, false);
    } else {
      this.signature = null;
      this.setMessage(this.wording.failureFormat);
      this.error?.setText(format(this.wording.errorFormat, r.error || 'Unknown error'));
      this.showParts(false, true, false, true);
    }
    if (!this.open) this.playOpen();
  }

  /** The signature chip: copy it (a blocked tab still leaves it in hand), then open the explorer. */
  private onTxn(): void {
    const sig = this.signature;
    if (!sig) return;
    copyText(sig);
    window.open(w3(this.ctx).web3Config.explorerTx(sig), '_blank', 'noopener');
  }

  private setMessage(f: string): void {
    const chips = Math.max(0, Math.trunc(this.params.chips || 0));
    this.message?.setText(format(f, formatN0(chips), this.params.sol));
  }

  private showParts(confirm: boolean, close: boolean, txn: boolean, error: boolean): void {
    const set = (n: UNode | null | undefined, v: boolean) => n && n.activeSelf !== v && n.setActive(v);
    set(this.buttons.get('confirm')?.node, confirm);
    set(this.buttons.get('cancel')?.node, confirm);
    set(this.buttons.get('close')?.node, close);
    set(this.txnRoot, txn);
    set(this.error, error);
    this.canvas?.layout();
  }

  unmount(): void {
    this.gone = true;
    this.fade?.kill();
    for (const b of this.buttons.values()) b.dispose();
    this.buttons.clear();
    this.canvas?.dispose();
    this.canvas = null;
  }
}

