/**
 * Once-per-day Coin slot machine (RetentionHud's Spin_Panel_UI). Port of Game/Retention/DailySpinPanel.cs: the prize
 * is chosen first, then the three reel labels flicker through the catalog and stop at 1.05 / 1.55 / 2.15 s on it.
 * Spin credits the Coins at once; there is never a separate CLAIM on this panel.
 *
 * Router id 'daily-spin' (overlay). In the shipped Nomad flow the menu shows the Lucky Slot ('lucky-slot') instead;
 * this panel is what the table's Coins chip opens when the Nomad menu is not running.
 */
import { DailySpinCatalog, type DailySpinResult } from '@nomad/engine/retention';
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import type { UNode } from '../../hud/unityUi';
import type { Routine } from '../ui/coroutines';
import {
  RetentionColors, setImageColor, setImageSprite, spriteByKey, wireButton, type ButtonHandle,
} from '../ui/retentionUi';
import { PanelScreen } from './panelScreen';

const mixColor = (a: { r: number; g: number; b: number; a: number }, b: typeof a, t: number) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });

/** DailySpinPanel.FormatCoins: "2.5K" / "750". */
export function formatSpinCoins(coins: number): string {
  if (coins >= 1000) {
    const v = Math.fround(coins / 1000);
    const r = Math.round(v * 10) / 10;
    return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}K`;
  }
  return formatN0(coins);
}

export class DailySpinScreen extends PanelScreen {
  private spinButton: ButtonHandle | null = null;
  private spinNode: UNode | null = null;
  private closeNode: UNode | null = null;
  private spinLabel: UNode | null = null;
  private statusLabel: UNode | null = null;
  private resultLabel: UNode | null = null;
  private reels: UNode[] = [];
  private busy = false;
  private routine: Routine | null = null;
  private hasAvailableSprite = false;
  private spentSprite: ReturnType<typeof spriteByKey> = null;
  private availableSprite: ReturnType<typeof spriteByKey> = null;
  private colors = { available: RetentionColors.SpinLabelDark, reelIdle: RetentionColors.Gold, reelSpin: RetentionColors.Muted };

  constructor(ctx: ConstructorParameters<typeof PanelScreen>[0]) {
    super(ctx, 'spin');
  }

  protected build(): void {
    const f = this.built.script('DailySpinPanel') ?? {};
    this.spinNode = this.ref(f, 'spinButton');
    this.closeNode = this.ref(f, 'closeButton');
    this.spinLabel = this.ref(f, 'spinLabel');
    this.statusLabel = this.ref(f, 'statusLabel');
    this.resultLabel = this.ref(f, 'resultLabel');
    this.reels = ((f.reelLabels as { path: string }[] | undefined) ?? []).map((r) => this.ref({ r }, 'r')).filter((n): n is UNode => !!n);
    this.availableSprite = spriteByKey((f.spinAvailableSprite as { sprite?: string } | null)?.sprite);
    this.spentSprite = spriteByKey((f.spinSpentSprite as { sprite?: string } | null)?.sprite);
    this.hasAvailableSprite = !!this.availableSprite;
    const col = (k: string, fb: typeof RetentionColors.Gold) => {
      const c = f[k] as { rgba?: [number, number, number, number] } | undefined;
      return c?.rgba ? { r: c.rgba[0], g: c.rgba[1], b: c.rgba[2], a: c.rgba[3] } : fb;
    };
    this.colors = { available: col('availableLabelColor', RetentionColors.SpinLabelDark), reelIdle: col('reelIdleColor', RetentionColors.Gold), reelSpin: col('reelSpinColor', RetentionColors.Muted) };
    wireButton(this.ctx, this.ref(f, 'dimmerButton'), () => this.hideSpin());
    wireButton(this.ctx, this.closeNode, () => this.hideSpin());
    this.spinButton = wireButton(this.ctx, this.spinNode, () => this.onSpinClicked(), { sound: PokerSound.ButtonStart });
    this.applyChromeLayout();
    this.listen('engagement:changed', () => !this.busy && this.refreshIdle());
  }

  protected afterMount(): void {
    this.refreshIdle();
  }

  private hideSpin(): void {
    this.host.stop(this.routine);
    this.busy = false;
    this.hide();
  }

  /** Prize + status above the reels; Spin and Close centred under the machine; no CLAIM control. */
  private applyChromeLayout(): void {
    this.placeTopReadout(this.resultLabel, 0);
    this.placeTopReadout(this.statusLabel, 1);
    this.placeUnderMachine(this.closeNode, -360);
    this.placeUnderMachine(this.spinNode, -300);
    this.hideClaimChrome();
  }

  private reparentToRoot(n: UNode): void {
    if (n.parent === this.root || !n.parent) return;
    n.parent.children.splice(n.parent.children.indexOf(n), 1);
    this.root.add(n);
  }

  private placeTopReadout(label: UNode | null, stackIndex: number): void {
    if (!label) return;
    this.reparentToRoot(label);
    label.anchorMin = [0.2, 1];
    label.anchorMax = [0.8, 1];
    label.pivot = [0.5, 1];
    label.anchoredPosition = [0, -36 - stackIndex * 32];
    label.sizeDelta = [0, 34];
    if (label.text) {
      label.text.alignH = 'center';
      label.text.alignV = 'middle';
      label.text.wrap = true;
    }
  }

  private placeUnderMachine(n: UNode | null, y: number): void {
    if (!n) return;
    this.reparentToRoot(n);
    n.anchorMin = [0.5, 0.5];
    n.anchorMax = [0.5, 0.5];
    n.pivot = [0.5, 0.5];
    n.anchoredPosition = [0, y];
    if (n.sizeDelta[0] < 80 || n.sizeDelta[1] < 40) n.sizeDelta = [200, 64];
    n.scale = [1, 1];
  }

  private hideClaimChrome(): void {
    for (const child of this.root.children) {
      if (child === this.closeNode || child === this.spinNode) continue;
      let claim = /claim/i.test(child.name) || child.name === 'CloseButton (1)';
      if (!claim) {
        const label = [...child.walk()].find((x) => x.text);
        if (label?.text && label.text.text.trim().toUpperCase() === 'CLAIM') claim = true;
      }
      if (claim) child.setActive(false);
    }
  }

  private onSpinClicked(): void {
    const svc = this.svc;
    if (this.busy || !svc) return;
    if (!svc.engagement.canSpin()) {
      this.refreshIdle();
      return;
    }
    this.busy = true;
    this.spinButton?.setInteractable(false);
    this.resultLabel?.setText('');
    this.statusLabel?.setText('Spinning…');
    // The result first (the server's roll when one is configured), then the reels play it out.
    void svc.engagement.spin().then((outcome) => {
      this.routine = this.host.start(this.spinRoutine(outcome));
    });
  }

  private *spinRoutine(outcome: DailySpinResult): Routine {
    if (!outcome.awarded) {
      this.busy = false;
      this.refreshIdle();
      return;
    }
    const stopAt = [1.05, 1.55, 2.15];
    const stopped = [false, false, false];
    let elapsed = 0;
    const prizes = DailySpinCatalog.Prizes;
    const reelCount = Math.min(3, this.reels.length);
    while (elapsed < stopAt[2]!) {
      elapsed += this.host.dt;
      for (let i = 0; i < reelCount; i++) {
        const reel = this.reels[i]!;
        if (stopped[i]) continue;
        if (elapsed >= stopAt[i]!) {
          reel.setText(formatSpinCoins(outcome.prize.coins));
          reel.setTextColor(this.colors.reelIdle);
          stopped[i] = true;
          this.ctx.audio.play(PokerSound.ChipsToPot);
        } else {
          const flicker = Math.trunc(elapsed * (18 + i * 6)) % prizes.length;
          reel.setText(formatSpinCoins(prizes[flicker]!.coins));
          reel.setTextColor(mixColor(this.colors.reelSpin, this.colors.reelIdle, 0.35));
        }
      }
      yield null;
    }
    for (const reel of this.reels.slice(0, 3)) {
      reel.setText(formatSpinCoins(outcome.prize.coins));
      reel.setTextColor(this.colors.reelIdle);
    }
    this.resultLabel?.setText(`You won ${formatN0(outcome.prize.coins)} Coins!`);
    this.statusLabel?.setText(outcome.prize.label);
    if (this.spinLabel && !this.hasAvailableSprite) this.spinLabel.setText('Come back tomorrow');
    if (this.spinNode?.image && this.spentSprite) {
      setImageSprite(this.spinNode, this.spentSprite);
      setImageColor(this.spinNode, RetentionColors.White);
    }
    this.ctx.audio.play(PokerSound.ChipsToWinner);
    this.busy = false;
    this.routine = null;
    this.refreshIdle();
  }

  private refreshIdle(): void {
    const svc = this.svc;
    if (!svc) return;
    const state = svc.engagement.load();
    const can = svc.engagement.canSpin();
    if (this.spinNode) {
      this.spinNode.setActive(can);
      this.spinButton?.setInteractable(can && !this.busy);
      if (can && this.availableSprite) setImageSprite(this.spinNode, this.availableSprite);
      if (can) setImageColor(this.spinNode, RetentionColors.White);
    }
    if (this.spinLabel) {
      this.spinLabel.setText(this.hasAvailableSprite ? '' : can ? 'SPIN' : '');
      this.spinLabel.setTextColor(this.colors.available);
    }
    this.hideClaimChrome();
    if (this.closeNode) {
      this.closeNode.setActive(true);
      this.placeUnderMachine(this.closeNode, can ? -430 : -360);
    }
    if (can) {
      this.statusLabel?.setText('Match three to bank today\'s Coins.');
      this.resultLabel?.setText('');
      for (const r of this.reels) {
        r.setText('•');
        r.setTextColor(this.colors.reelIdle);
      }
    } else {
      const last = state.lastSpinCoins;
      this.resultLabel?.setText(last > 0 ? `Today's prize: ${formatN0(last)} Coins` : '');
      this.statusLabel?.setText('Already spun today.');
      const shown = last > 0 ? formatSpinCoins(last) : '—';
      for (const r of this.reels) {
        r.setText(shown);
        r.setTextColor(this.colors.reelIdle);
      }
    }
    this.relayout();
  }
}
