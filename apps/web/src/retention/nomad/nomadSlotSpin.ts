/**
 * Lucky Slot reels. Port of Game/NomadUI/NomadSlotSpin.cs: Spin scrolls each reel through the slot icons (symbol +
 * next symbol leap-frogging inside a masked viewport), stops them one after another with an overshoot and a settle,
 * bursts sparkles on each reel as it lands, then reports a win or a loss.
 *
 * Unity rolls its own outcome (winChance). The web port lets the caller force the outcome (`spin({ win })`) so the
 * reels agree with the real Daily Spin result; without it the C# roll is used.
 */
import type { SpriteData, UNode } from '../../hud/unityUi';
import { clamp01, type CoroutineHost, type Routine } from '../ui/coroutines';
import { setAnchored, setImageEnabled, setImageSprite } from '../ui/retentionUi';
import type { NomadSparkles, Rect } from './nomadSparkles';

export interface SlotSpinConfig {
  reels: UNode[];
  symbols: UNode[];
  nextSymbols: (UNode | null)[];
  icons: SpriteData[];
  winSprite: SpriteData | null;
  winChance: number;
  spinTime: number;
  stagger: number;
  speed: number;
  isWinScreen: boolean;
  sparkles: NomadSparkles | null;
}

/** Symbols of the last losing spin, so the "lost" screen can show them when it opens (C# static). */
let lastLose: SpriteData[] | null = null;

const randInt = (n: number) => Math.floor(Math.random() * n);

export class NomadSlotSpin {
  private spinning = false;
  private readonly home: [number, number][];

  constructor(private readonly host: CoroutineHost, private readonly cfg: SlotSpinConfig) {
    this.home = cfg.symbols.map((s) => [...s.anchoredPosition] as [number, number]);
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  /** OnEnable: hide the scrolling copies, show the last losing symbols on the lost screen, celebrate on the win one. */
  onEnable(): void {
    for (const n of this.cfg.nextSymbols) if (n) setImageEnabled(n, false);
    if (!this.cfg.isWinScreen && lastLose) this.cfg.symbols.forEach((s, i) => lastLose![i] && setImageSprite(s, lastLose![i]!));
    this.spinning = false;
    if (this.cfg.isWinScreen && this.cfg.sparkles) this.host.start(this.celebrate());
  }

  /** The win screen opens with a shower of sparkles that settles into a short twinkle. */
  private *celebrate(): Routine {
    yield null;
    const { reels, sparkles } = this.cfg;
    if (!reels.length || !sparkles) return;
    const mid = sparkles.centerOf(reels[Math.floor(reels.length / 2)]!);
    sparkles.burst(mid, 40, 90, 620, 48);
    sparkles.setAmbient(true, this.windowRect(1.6), 26);
    yield 2.2;
    sparkles.setAmbient(false, null, 0);
  }

  private windowRect(grow: number): Rect {
    const { reels, sparkles } = this.cfg;
    const a = sparkles!.centerOf(reels[0]!);
    const b = sparkles!.centerOf(reels[reels.length - 1]!);
    const w = reels[0]!.w * 0.5 * grow;
    const h = reels[0]!.h * 0.5 * grow;
    return { xMin: Math.min(a.x, b.x) - w, yMin: Math.min(a.y, b.y) - h, xMax: Math.max(a.x, b.x) + w, yMax: Math.max(a.y, b.y) + h };
  }

  /** Resolves with the outcome when the reels have stopped (after the jackpot burst on a win). */
  spin(opts: { win?: boolean } = {}): Promise<boolean> | null {
    if (this.spinning || !this.cfg.icons.length) return null;
    return new Promise((resolve) => this.host.start(this.run(opts.win, resolve)));
  }

  private *run(forceWin: boolean | undefined, done: (win: boolean) => void): Routine {
    const { symbols, icons, winSprite, sparkles, reels } = this.cfg;
    this.spinning = true;
    const win = (forceWin ?? Math.random() < this.cfg.winChance) && !!winSprite;
    const final: SpriteData[] = [];
    if (win) for (let i = 0; i < symbols.length; i++) final.push(winSprite!);
    else {
      for (let i = 0; i < symbols.length; i++) final.push(icons[randInt(icons.length)]!);
      if (final.length > 2 && final[0] === final[1] && final[1] === final[2]) final[2] = icons[(icons.indexOf(final[2]!) + 1) % icons.length]!; // never three of a kind on a loss
    }
    if (sparkles && reels.length) sparkles.setAmbient(true, this.windowRect(1), 20);
    let running = symbols.length;
    for (let i = 0; i < symbols.length; i++) this.host.start(this.spinReel(i, final[i]!, this.cfg.spinTime + i * this.cfg.stagger, () => running--));
    while (running > 0) yield null;
    if (sparkles) sparkles.setAmbient(false, null, 0);
    if (win && sparkles) {
      // jackpot: a big golden burst before switching to the win screen
      reels.forEach((r, i) => sparkles.burst(sparkles.centerOf(r), i === Math.floor(reels.length / 2) ? 34 : 18, 50, 560, 46));
      yield 0.75;
    } else yield 0.35;
    this.spinning = false;
    if (!win) lastLose = final;
    done(win);
  }

  private *spinReel(i: number, final: SpriteData, duration: number, done: () => void): Routine {
    const a = this.cfg.symbols[i]!;
    const b = this.cfg.nextSymbols[i] ?? null;
    const home = this.home[i]!;
    const reel = this.cfg.reels[i];
    const h = reel ? reel.h : a.h * 1.4;
    if (!b) {
      setImageSprite(a, final);
      done();
      return;
    }
    let aSprite = a.image?.sprite ?? null;
    let bSprite = this.randomIcon(aSprite);
    setImageEnabled(b, true);
    setImageSprite(b, bSprite);
    let frac = 0;
    let t = 0;
    const dt = () => this.host.dt;
    // spin up and run
    while (t < duration) {
      const ramp = clamp01(t / 0.18);
      frac += this.cfg.speed * ramp * dt();
      while (frac >= h) {
        frac -= h;
        aSprite = bSprite;
        setImageSprite(a, aSprite);
        bSprite = this.randomIcon(aSprite);
        setImageSprite(b, bSprite);
      }
      this.place(a, b, home, frac, h);
      t += dt();
      yield null;
    }
    // land: the next symbol coming in is the result; ease it into place
    setImageSprite(b, final);
    const start = frac;
    const dist = h - start + h * 0.06; // slight overshoot
    const land = Math.min(0.32, Math.max(0.14, (dist / this.cfg.speed) * 2.2));
    let k = 0;
    while (k < 1) {
      k = Math.min(1, k + dt() / land);
      const e = 1 - Math.pow(1 - k, 3);
      this.place(a, b, home, start + dist * e, h);
      yield null;
    }
    // settle back from the overshoot
    setImageSprite(a, final);
    setImageEnabled(b, false);
    const over = h * 0.06;
    k = 0;
    while (k < 1) {
      k = Math.min(1, k + dt() / 0.12);
      setAnchored(a, home[0], home[1] - over * (1 - k));
      yield null;
    }
    setAnchored(a, home[0], home[1]);
    const sp = this.cfg.sparkles;
    if (sp && reel) sp.burst(sp.centerOf(reel), 10, reel.w * 0.3, 260, 32);
    done();
  }

  private place(a: UNode, b: UNode, home: [number, number], frac: number, h: number): void {
    setAnchored(a, home[0], home[1] - frac);
    setAnchored(b, home[0], home[1] + h - frac);
  }

  private randomIcon(avoid: SpriteData | null): SpriteData {
    const icons = this.cfg.icons;
    if (icons.length === 1) return icons[0]!;
    let s: SpriteData;
    do s = icons[randInt(icons.length)]!;
    while (s === avoid);
    return s;
  }
}

