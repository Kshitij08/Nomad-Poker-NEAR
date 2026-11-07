/**
 * The Lucky Slot daily spin on the LuckySlot_Win / LuckySlot_Lost art screens: NomadUiHost's OpenDailySpin /
 * BindRewards (slot part) / PaintSlot / Spin, with the screens' NomadSlotSpin reels and NomadSparkles.
 *
 * Works on any pair of trees built from those prefabs: the Nomad menu's own screens (retention's Nomad partial) or the
 * retention module's copies (the 'lucky-slot' router screen). Script fields come from data/retention-ui.json, which
 * extracts the same prefabs (paths match).
 *
 * Unity wires Btn_Spin twice (NomadUiHost.Spin and NomadSlotSpin's own listener, which rolls its own 35% outcome and,
 * on a "loss", deactivates the win screen). The port runs one spin: the prize is drawn first (DailyEngagement), the
 * reels land on it, then the "You Won!" banner shows the Coins.
 */
import type { AppContext } from '../../app/app';
import { formatN0 } from '../../core/util/dotnetMath';
import { UNode, type RGBA, type SpriteData } from '../../hud/unityUi';
import type { CoroutineHost } from '../ui/coroutines';
import { RETENTION_DATA, instantiate, refNode, spriteByKey, type RetNodeData } from '../ui/retentionUi';
import { NomadSlotSpin } from './nomadSlotSpin';
import { NomadSparkles } from './nomadSparkles';

export type SlotScreen = 'win' | 'lost';

export interface LuckySlotSurface {
  readonly roots: Record<SlotScreen, UNode>;
  /** Show(name): switch to that screen (it fires `onShown` through the caller's own screen hook). */
  show(which: SlotScreen): void;
  isShowing(which: SlotScreen): boolean;
  /** NomadUiHost.Message. */
  message(title: string, body: string): void;
  /** Bind(root, "Content/Machine/Btn_Spin", Spin, replaceNavigation: true) → something with setInteractable. */
  bindSpin(root: UNode, onClick: () => void): { setInteractable(v: boolean): void } | null;
  /** NewText(content, "SpinNote", text, 30, Bold, (0,-420), (1200,50)), coloured (1, .86, .45), no raycast. */
  newNote(content: UNode, text: string): UNode | null;
  readonly signedIn: boolean;
  showLogin?(): void;
}

interface View {
  slot: NomadSlotSpin;
  sparkles: NomadSparkles;
  spin: { setInteractable(v: boolean): void } | null;
}

function scriptFields(key: 'luckyWin' | 'luckyLost', script: string): Record<string, unknown> {
  return RETENTION_DATA.canvases[key]?.root.components?.scripts?.find((s) => s.script === script)?.fields ?? {};
}

function dataAt(root: RetNodeData, path: string): RetNodeData | null {
  const parts = path.split('/');
  if (parts[0] !== root.name) return null;
  let n: RetNodeData | undefined = root;
  for (const p of parts.slice(1)) {
    n = n?.children?.find((c) => c.name === p);
    if (!n) return null;
  }
  return n ?? null;
}

export class LuckySlotController {
  private readonly views: Record<SlotScreen, View>;
  private slotWon = false;
  private slotPrize = 0;
  private spinning = false;

  constructor(private readonly ctx: AppContext, host: CoroutineHost, private readonly surface: LuckySlotSurface) {
    const build = (which: SlotScreen): View => {
      const key = which === 'win' ? 'luckyWin' : 'luckyLost';
      const root = surface.roots[which];
      const data = RETENTION_DATA.canvases[key]!.root;
      const sf = scriptFields(key, 'NomadSparkles');
      const palette = ((sf.palette as { rgba: [number, number, number, number] }[] | undefined) ?? []).map((c): RGBA => ({ r: c.rgba[0], g: c.rgba[1], b: c.rgba[2], a: c.rgba[3] }));
      const sparkles = new NomadSparkles(refNode(root, sf, 'area') ?? root, spriteByKey((sf.sprite as { sprite?: string } | null)?.sprite), host, (sf.poolSize as number) ?? 80, palette.length ? palette : undefined);
      const f = scriptFields(key, 'NomadSlotSpin');
      const refs = (k: string) => ((f[k] as { path: string }[] | undefined) ?? []).map((r) => {
        const n = refNode(root, { r }, 'r');
        // A disabled Image (the scrolling next symbols) is not built by the tree builders: give it one, hidden.
        if (n && !n.image) {
          const d = dataAt(data, r.path);
          if (d?.components?.image) {
            n.image = instantiate({ ...d, children: [] }).image;
            n.el.classList.add('rt-img-off');
          }
        }
        return n;
      });
      const icons = ((f.icons as ({ sprite?: string } | null)[] | undefined) ?? []).map((s) => spriteByKey(s?.sprite)).filter((s): s is SpriteData => !!s);
      const slot = new NomadSlotSpin(host, {
        reels: refs('reels').filter((n): n is UNode => !!n),
        symbols: refs('symbols').filter((n): n is UNode => !!n),
        nextSymbols: refs('nextSymbols'),
        icons,
        winSprite: spriteByKey((f.winSprite as { sprite?: string } | null)?.sprite),
        winChance: (f.winChance as number) ?? 0.35,
        spinTime: (f.spinTime as number) ?? 1.4,
        stagger: (f.stagger as number) ?? 0.35,
        speed: (f.speed as number) ?? 2600,
        isWinScreen: !!f.isWinScreen,
        sparkles,
      });
      const btn = refNode(root, f, 'spinButton') ?? root.find('Content/Machine/Btn_Spin');
      const spin = btn ? surface.bindSpin(btn, () => this.spin()) : null;
      return { slot, sparkles, spin };
    };
    this.views = { win: build('win'), lost: build('lost') };
  }

  /** OpenDailySpin. */
  open(): void {
    if (!this.surface.signedIn) {
      this.surface.showLogin?.();
      return;
    }
    this.slotWon = false;
    this.surface.show('win');
  }

  /** OnScreenShown → the screen's OnEnable (NomadSlotSpin / NomadSparkles) + PaintSlot. */
  onShown(which: SlotScreen): void {
    const other: SlotScreen = which === 'win' ? 'lost' : 'win';
    this.views[other].sparkles.clear();
    this.views[which].slot.onEnable();
    this.paint(which);
  }

  /** NomadUiHost.PaintSlot. */
  paint(which: SlotScreen): void {
    const root = this.surface.roots[which];
    if (which === 'win') {
      // The win banner only after a spin that paid; before that the machine stands ready.
      for (const c of (root.find('Content') ?? root).children)
        if (c.name === 'WinBanner' || c.name === 'CoinPile' || c.name === 'Burst' || c.name.startsWith('Sparkle_')) c.setActive(this.slotWon);
      // The art keeps Burst under Machine.
      for (const c of root.find('Content/Machine')?.children ?? []) if (c.name === 'Burst') c.setActive(this.slotWon);
      if (this.slotWon) root.find('Content/WinBanner/Amount')?.setText(`${formatN0(this.slotPrize)} Coins`);
    }
    // What a spin is: the machine said nothing about it (UI pass 20 Oct).
    const content = root.find('Content');
    if (content && !content.find('SpinNote')) this.surface.newNote(content, this.ctx.services.retention?.spinNote() ?? '');
    const canSpin = this.ctx.services.retention?.engagement.canSpin() ?? false;
    this.views[which].spin?.setInteractable(!this.spinning && canSpin);
  }

  private spin(): void {
    const svc = this.ctx.services.retention;
    if (this.spinning || !svc) return;
    if (!svc.engagement.canSpin()) {
      this.surface.message('Lucky slot', "You've had today's spin. Come back tomorrow for another.");
      return;
    }
    const which: SlotScreen = this.surface.isShowing('lost') ? 'lost' : 'win';
    this.spinning = true;
    this.slotWon = false;
    const result = svc.engagement.trySpin();
    this.paint(which);
    const done = this.views[which].slot.spin({ win: result.awarded }) ?? Promise.resolve(result.awarded);
    void done.then(() => {
      this.spinning = false;
      if (result.awarded) {
        this.slotWon = true;
        this.slotPrize = result.prize.coins;
        if (!this.surface.isShowing('win')) this.surface.show('win');
        this.paint('win');
      } else {
        this.surface.show('lost');
        this.paint('lost');
        this.surface.message('Lucky slot', result.error || 'No spin left today. Come back tomorrow.');
      }
    });
  }

  dispose(): void {
    for (const v of Object.values(this.views)) v.sparkles.dispose();
  }
}

/** NomadUiHost.NewText for the spin note, as a plain UNode (used where the menu's own node factory is absent). */
export function plainNote(content: UNode, text: string): UNode {
  const like = content.find('Machine/GoodLuck');
  const n = new UNode('SpinNote');
  n.anchorMin = [0.5, 0.5];
  n.anchorMax = [0.5, 0.5];
  n.anchoredPosition = [0, -420];
  n.sizeDelta = [1200, 50];
  n.text = {
    text, family: like?.text?.family ?? "'UnityNotoSansBold'", lineRatio: like?.text?.lineRatio ?? 1.362, fontSize: 30, autoSize: false, min: 10, max: 30,
    bold: true, upper: false, color: { r: 1, g: 0.86, b: 0.45, a: 1 }, alignH: 'center', alignV: 'middle', wrap: true, margin: [0, 0, 0, 0], underlay: null,
  };
  content.add(n);
  if (content.activeInHierarchy) n.layout();
  return n;
}
