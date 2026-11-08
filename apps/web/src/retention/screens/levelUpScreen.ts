/**
 * Level-up celebration. Port of Game/Retention/LevelUpPanel.cs on the extracted 'LevelUp panel ui' prefab:
 * panel in → card pops with the old level → XP bar charges (card tenses and jitters) → impact (flash, ring, old
 * number flies off, new number slams in, sheet shake) → "LEVEL UP!" drops in letter by letter → reward tiles slide
 * up and count → Continue pops, then the idle loop. Continue plays the next queued level or closes.
 *
 * Router id 'level-up' (overlay). Params: { level?: number } (default: the player's level, at least 2).
 * The service opens it by itself on a real level-up (LevelUpQueue), once per level gained.
 */
import type { AppContext, Screen } from '../../app/app';
import { RewardKind, type RewardGrant } from '../../app/services';
import { LevelRewardCatalog } from '@nomad/engine/retention';
import { roundHalfEven, formatN0 } from '@nomad/engine/util/dotnetMath';
import { whenFontsReady, type UNode } from '../../hud/unityUi';
import {
  CoroutineHost, clamp01, easeOutBack, easeOutCubic, easeOutElastic, lerp, lerpUnclamped, tweenRoutine, waitRoutine,
  type Routine,
} from '../ui/coroutines';
import {
  OverlayCanvas, buildCanvas, dataOf, instantiate, layoutLine, refNode, setAlpha, setAnchored, setImageAlpha, setScale,
  setTextAlpha, setXpBarProgress, wireButton, type BuiltCanvas,
} from '../ui/retentionUi';

export interface LevelUpParams {
  level?: number;
}

const KIND_LABEL: Record<number, string> = {
  [RewardKind.Coins]: 'COINS', [RewardKind.Gems]: 'GEMS', [RewardKind.Xp]: 'XP', [RewardKind.Cosmetic]: 'COSMETIC', [RewardKind.StreakToken]: 'SHIELD',
};

function amountText(kind: RewardKind, amount: number): string {
  switch (kind) {
    case RewardKind.Coins: return formatN0(amount) + ' Coins';
    case RewardKind.Gems: return formatN0(amount) + ' Gems';
    case RewardKind.Xp: return formatN0(amount) + ' XP';
    case RewardKind.Cosmetic: return 'New Frame';
    case RewardKind.StreakToken: return amount + ' Streak Shield';
    default: return 'x' + amount;
  }
}

export class LevelUpScreen implements Screen {
  readonly overlay = true;
  private canvas: OverlayCanvas | null = null;
  private built!: BuiltCanvas;
  private readonly host = new CoroutineHost();
  private idleFrom = -1;
  private showingSelf = false;
  private basesCached = false;
  private sheetBase: [number, number] = [0, 0];
  private cardBase: [number, number] = [0, 0];
  private numberBase: [number, number] = [0, 0];
  private tiles: { node: UNode; reward: RewardGrant }[] = [];
  private offIdle: (() => void) | null = null;

  // Parts (LevelUpPanel serialized fields).
  private root!: UNode;
  private sheet: UNode | null = null;
  private subtitle: UNode | null = null;
  private levelCard: UNode | null = null;
  private oldNumber: UNode | null = null;
  private levelNumber: UNode | null = null;
  private cardFlash: UNode | null = null;
  private cardRing: UNode | null = null;
  private xpFill: UNode | null = null;
  private xpFromLabel: UNode | null = null;
  private xpToLabel: UNode | null = null;
  private levelUpTitle: UNode | null = null;
  private rewardsGroup: UNode | null = null;
  private rewardsRow: UNode | null = null;
  private rewardTileTemplate: UNode | null = null;
  private continueButton: UNode | null = null;

  constructor(private readonly ctx: AppContext) {}

  mount(el: HTMLElement, params?: unknown): void {
    const p = (params ?? {}) as LevelUpParams;
    this.built = buildCanvas('levelUp');
    const root = (this.root = this.built.root);
    const f = this.built.script('LevelUpPanel');
    const ref = (k: string) => refNode(root, f, k);
    this.sheet = ref('sheet');
    this.subtitle = ref('subtitle');
    this.levelCard = ref('levelCard');
    this.oldNumber = ref('oldNumber');
    this.levelNumber = ref('levelNumber');
    this.cardFlash = ref('cardFlash');
    this.cardRing = ref('cardRing');
    this.xpFill = ref('xpFill');
    this.xpFromLabel = ref('xpFromLabel');
    this.xpToLabel = ref('xpToLabel');
    this.levelUpTitle = ref('levelUpTitle');
    this.rewardsGroup = ref('rewardsGroup');
    this.rewardsRow = ref('rewardsRow');
    this.rewardTileTemplate = ref('rewardTileTemplate');
    this.continueButton = ref('continueButton');

    // Awake: template off, Continue wired, FitContinueInViewport.
    this.rewardTileTemplate?.setActive(false);
    wireButton(this.ctx, this.continueButton, () => this.onContinue());
    this.fitContinueInViewport();

    this.canvas = new OverlayCanvas(el, root, this.built.data.scaler);
    root.setActive(true);
    this.canvas.layout();
    whenFontsReady([root]);
    this.offIdle = this.host.onUpdate(() => this.update());

    const svc = this.ctx.services.retention;
    if (svc) svc.levelUps.showing = true;
    this.play(Number(p.level ?? svc?.progression.level ?? 2) || 2);
  }

  unmount(): void {
    const svc = this.ctx.services.retention;
    if (svc) svc.levelUps.showing = false;
    this.offIdle?.();
    this.host.dispose();
    this.canvas?.dispose();
    this.canvas = null;
  }

  get isShowing(): boolean {
    return this.showingSelf;
  }

  /** Pin Continue to the bottom of the overlay and keep the sheet above it (short viewports). */
  private fitContinueInViewport(): void {
    const btn = this.continueButton;
    if (btn) {
      btn.anchorMin = [0.5, 0];
      btn.anchorMax = [0.5, 0];
      btn.pivot = [0.5, 0];
      btn.anchoredPosition = [0, 48];
      if (btn.sizeDelta[1] < 1) btn.sizeDelta = [272, 88];
    }
    const sheet = this.sheet;
    if (!sheet) return;
    if (sheet.sizeDelta[1] > 820) sheet.sizeDelta = [sheet.sizeDelta[0], 820];
    if (sheet.anchoredPosition[1] > 20) sheet.anchoredPosition = [sheet.anchoredPosition[0], 20];
  }

  private play(to: number): void {
    to = Math.max(2, to);
    const from = to - 1;
    this.buildRewards(LevelRewardCatalog.rewardsForLevel(to));
    this.host.stopAll();
    this.showingSelf = true;
    this.host.start(this.sequence(from, to));
  }

  private onContinue(): void {
    const next = this.ctx.services.retention?.levelUps.next() ?? null;
    if (next !== null) {
      this.play(next);
      return;
    }
    this.host.stopAll();
    this.host.start(this.close());
  }

  // ------------------------------------------------------------------ rewards

  private buildRewards(rewards: readonly RewardGrant[]): void {
    for (const t of this.tiles) {
      const parent = t.node.parent;
      if (parent) parent.children.splice(parent.children.indexOf(t.node), 1);
      t.node.el.remove();
    }
    this.tiles = [];
    const any = rewards.length > 0;
    this.rewardsGroup?.setActive(any);
    const tpl = this.rewardTileTemplate;
    const row = this.rewardsRow;
    if (!any || !tpl || !row) return;
    const tplData = dataOf(tpl);
    if (!tplData) return;
    rewards.forEach((r, i) => {
      const go = instantiate({ ...tplData, active: true });
      row.add(go);
      setLabel(go, 'Header', KIND_LABEL[r.kind] ?? String(r.kind));
      setLabel(go, 'Amount', amountText(r.kind, r.amount));
      setLabel(go, 'Note', i === 0 ? 'Level reward' : 'Bonus');
      go.scale = [0, 0];
      this.tiles.push({ node: go, reward: r });
    });
    const lg = dataOf(row)?.components?.layoutGroup;
    layoutLine(row, false, typeof lg?.spacing === 'number' ? lg.spacing : 26, lg?.childAlignment ?? 'MiddleCenter', lg?.padding);
    // HorizontalLayoutGroup lays out by the tile rects, not their (animated) scale.
    for (const t of this.tiles) t.node.scale = [1, 1];
    layoutLine(row, false, typeof lg?.spacing === 'number' ? lg.spacing : 26, lg?.childAlignment ?? 'MiddleCenter', lg?.padding);
    for (const t of this.tiles) t.node.scale = [0, 0];
    if (row.activeInHierarchy) row.layout();
  }

  // ------------------------------------------------------------------ animation

  private cacheBases(): void {
    if (this.basesCached) return;
    if (this.sheet) this.sheetBase = [...this.sheet.anchoredPosition];
    if (this.levelCard) this.cardBase = [...this.levelCard.anchoredPosition];
    if (this.levelNumber) this.numberBase = [...this.levelNumber.anchoredPosition];
    this.basesCached = true;
  }

  private run(r: Routine): void {
    this.host.start(r);
  }

  private tween(duration: number, delay: number, step: (k: number) => void): Routine {
    return tweenRoutine(this.host, duration, delay, step);
  }

  private setXp(p: number): void {
    setXpBarProgress(this.xpFill, p);
  }

  private *sequence(from: number, to: number): Routine {
    this.cacheBases();
    this.idleFrom = -1;
    const h = this.host;
    const root = this.root;
    const sheet = this.sheet;
    const card = this.levelCard;
    const btn = this.continueButton;
    const title = this.levelUpTitle;
    const oldN = this.oldNumber;
    const newN = this.levelNumber;
    const ring = this.cardRing;
    const [sbx, sby] = this.sheetBase;
    const [cbx, cby] = this.cardBase;
    const [nbx, nby] = this.numberBase;

    // ---- reset everything to the "before" pose
    setAlpha(root, 0);
    setScale(sheet, 0.9);
    setAnchored(sheet, sbx, sby - 60);
    setScale(card, 0);
    setAnchored(card, cbx, cby);
    if (oldN) {
      oldN.setText(String(from));
      setTextAlpha(oldN, 1);
      setAnchored(oldN, nbx, nby);
      setScale(oldN, 1);
    }
    if (newN) {
      newN.setText(String(to));
      setTextAlpha(newN, 0);
      setAnchored(newN, nbx, nby);
      setScale(newN, 1);
    }
    setImageAlpha(this.cardFlash, 0);
    setImageAlpha(ring, 0);
    this.setXp(0);
    this.xpFromLabel?.setText('LV ' + from);
    this.xpToLabel?.setText('LV ' + to);
    setTextAlpha(this.subtitle, 0);
    if (title) {
      setTextAlpha(title, 0);
      setScale(title, 1);
      resetLetters(title);
    }
    setScale(btn, 0);
    for (const t of this.tiles) setScale(t.node, 0);

    // ---- 1. panel comes in
    this.run(this.tween(0.2, 0, (k) => setAlpha(root, k)));
    this.run(this.tween(0.4, 0, (k) => {
      const e = easeOutCubic(k);
      setScale(sheet, lerp(0.9, 1, e));
      setAnchored(sheet, sbx, lerp(sby - 60, sby, e));
    }));
    this.run(this.tween(0.3, 0.15, (k) => setTextAlpha(this.subtitle, k)));

    // ---- 2. card pops in showing the OLD level
    this.run(this.tween(0.4, 0.3, (k) => setScale(card, easeOutBack(k))));

    // ---- 3. XP bar charges to full, card tenses up
    const chargeStart = 0.75;
    const chargeTime = 0.85;
    this.run(this.tween(chargeTime, chargeStart, (k) => {
      const e = k * k; // accelerate into the hit
      this.setXp(e);
      const jitter = Math.sin(h.time * 70) * 2.5 * e;
      setScale(card, 1 + 0.06 * e);
      setAnchored(card, cbx + jitter, cby);
    }));

    // ---- 4. IMPACT: old level flies off, new level slams in
    yield waitRoutine(h, chargeStart + chargeTime);
    setAnchored(card, cbx, cby);
    this.run(this.tween(0.45, 0, (k) => setScale(card, lerp(1.22, 1, easeOutElastic(k)))));
    this.run(this.tween(0.4, 0, (k) => setImageAlpha(this.cardFlash, lerp(0.85, 0, easeOutCubic(k)))));
    this.run(this.tween(0.6, 0, (k) => {
      setScale(ring, lerp(1, 1.7, easeOutCubic(k)));
      setImageAlpha(ring, lerp(0.6, 0, k));
    }));
    this.run(this.tween(0.3, 0, (k) => {
      if (!oldN) return;
      setAnchored(oldN, nbx, nby + 140 * easeOutCubic(k));
      setScale(oldN, lerp(1, 0.5, k));
      setTextAlpha(oldN, 1 - k);
    }));
    this.run(this.tween(0.4, 0.04, (k) => {
      if (!newN) return;
      setTextAlpha(newN, clamp01(k * 3));
      setScale(newN, lerpUnclamped(2.6, 1, easeOutBack(k, 2.2)));
    }));
    if (sheet) this.run(this.shake(sheet, sbx, sby, 0.35, 16));
    this.run(this.tween(0.35, 0.3, (k) => this.setXp(1 - easeOutCubic(k))));
    this.run(this.tween(0.01, 0.3, () => {
      this.xpFromLabel?.setText('LV ' + to);
      this.xpToLabel?.setText('LV ' + (to + 1));
    }));

    // ---- 5. LEVEL UP! drops in letter by letter
    if (title) {
      setTextAlpha(title, 1);
      this.run(this.lettersIn(title, 0.2, 0.05, 0.35));
    }

    // ---- 6. rewards slide up + amounts count
    const tilesAt = 0.7;
    this.tiles.forEach((t, i) => {
      const rt = t.node;
      const cardNode = rt.find('Card');
      if (cardNode) setAnchored(cardNode, 0, 0);
      const d = tilesAt + i * 0.14;
      this.run(this.tween(0.4, d, (k) => {
        setScale(rt, easeOutBack(k));
        if (cardNode) setAnchored(cardNode, 0, (1 - easeOutCubic(k)) * -70);
      }));
      const amount = findLabel(rt, 'Amount');
      const r = t.reward;
      if (amount && r.kind !== RewardKind.Cosmetic && r.amount > 1) this.run(this.countUp(amount, r, d + 0.1, 0.6));
    });

    // ---- 7. button, then idle loop
    yield this.tween(0.35, tilesAt + this.tiles.length * 0.14 + 0.35, (k) => setScale(btn, easeOutBack(k)));
    this.idleFrom = h.time;
  }

  private *close(): Routine {
    this.idleFrom = -1;
    const start = this.root.groupAlpha;
    const btn = this.continueButton;
    yield this.tween(0.25, 0, (k) => {
      const e = easeOutCubic(k);
      setAlpha(this.root, lerp(start, 0, e));
      setScale(this.sheet, lerp(1, 0.88, e));
      setScale(btn, lerp(1, 0.6, e));
    });
    this.showingSelf = false;
    // gameObject.SetActive(false): the overlay goes away.
    if (this.ctx.router.current === 'level-up') this.ctx.router.back();
  }

  /** Update(): gentle idle loop once the sequence is done. */
  private update(): void {
    if (!this.showingSelf || this.idleFrom < 0) return;
    const t = this.host.time - this.idleFrom;
    const ramp = clamp01(t / 0.4);
    setScale(this.levelUpTitle, 1 + Math.sin(t * 2.4) * 0.03 * ramp);
    setScale(this.continueButton, 1 + Math.sin(t * 3.2) * 0.04 * ramp);
    if (this.levelCard) setAnchored(this.levelCard, this.cardBase[0], this.cardBase[1] + Math.sin(t * 1.8) * 6 * ramp);
  }

  private *shake(rt: UNode, bx: number, by: number, duration: number, strength: number): Routine {
    let t = 0;
    while (t < duration) {
      t += this.host.dt;
      const k = 1 - clamp01(t / duration);
      setAnchored(rt, bx + Math.sin(t * 95) * strength * k, by + Math.cos(t * 77) * strength * 0.6 * k);
      yield null;
    }
    setAnchored(rt, bx, by);
  }

  private *countUp(label: UNode, r: RewardGrant, delay: number, duration: number): Routine {
    label.setText(amountText(r.kind, 0));
    yield this.tween(duration, delay, (k) => label.setText(amountText(r.kind, roundHalfEven(lerp(0, r.amount, easeOutCubic(k))))));
  }

  /** TMP vertex animation: each character drops in from above with an overshoot and fades in. */
  private *lettersIn(text: UNode, delay: number, perChar: number, charDur: number): Routine {
    const spans = splitLetters(text);
    const count = spans.length;
    let t = -delay;
    const total = perChar * count + charDur;
    for (;;) {
      for (let i = 0; i < count; i++) {
        const p = clamp01((t - i * perChar) / charDur);
        const s = p <= 0 ? 0 : easeOutBack(p, 2.5);
        const off = (1 - easeOutCubic(p)) * 90;
        const a = clamp01(p * 2);
        const sp = spans[i]!;
        sp.style.transform = `translateY(${-off}px) scale(${s})`;
        sp.style.opacity = String(a);
      }
      if (t >= total) break;
      t += this.host.dt;
      yield null;
    }
    resetLetters(text);
  }
}

function findLabel(parent: UNode, name: string): UNode | null {
  for (const n of parent.walk()) if (n.name === name && n.text) return n;
  return null;
}
function setLabel(parent: UNode, name: string, value: string): void {
  findLabel(parent, name)?.setText(value);
}

/** Splits a label's text into per-character inline blocks (TMP characterInfo). */
function splitLetters(node: UNode): HTMLSpanElement[] {
  const span = node.el.querySelector(':scope > .u-text > span') as HTMLSpanElement | null;
  if (!span) return [];
  const text = span.textContent ?? '';
  span.textContent = '';
  const out: HTMLSpanElement[] = [];
  for (const ch of text) {
    const s = document.createElement('span');
    s.textContent = ch;
    s.style.display = 'inline-block';
    s.style.whiteSpace = 'pre';
    s.style.transformOrigin = '50% 50%';
    s.style.transform = 'scale(0)';
    s.style.opacity = '0';
    span.append(s);
    out.push(s);
  }
  return out;
}

function resetLetters(node: UNode): void {
  const span = node.el.querySelector(':scope > .u-text > span') as HTMLSpanElement | null;
  if (span && span.children.length) span.textContent = span.textContent ?? '';
}
