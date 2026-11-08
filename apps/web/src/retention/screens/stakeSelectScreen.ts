/**
 * Free-play stake picker (RetentionHud's StakeSelect_Panel). Port of Game/Retention/StakeSelectPanel.cs
 * (+ NomadRetentionRuntime.ApplyFigmaTables): Quick Play · Auto, then one row per StakeCatalog tier; rows the Coins
 * cannot cover are locked, the chosen one turns yellow; the status line explains the resolved table.
 *
 * Router id 'stake-select' (overlay). Selection lives in ctx.services.retention.stakes (StakeSelection port).
 */
import { PokerSound } from '@nomad/engine/orchestration/pokerSound';
import { StakeCatalog, type StakeTier } from '@nomad/engine/stakes/stakes';
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import type { RGBA, UNode } from '../../hud/unityUi';
import { RetentionColors, applySprite, setImageColor, wireButton, type ButtonHandle } from '../ui/retentionUi';
import { PanelScreen } from './panelScreen';

interface TierRow {
  button: UNode | null;
  handle: ButtonHandle | null;
  label: UNode | null;
  minBuyIn: number;
}

const caption = (t: StakeTier) => `${t.displayName}   ${formatN0(t.minBuyIn)}   ·   ${t.blindsLabel}`;
const rgbaOf = (c: unknown, fb: RGBA): RGBA => {
  const v = (c as { rgba?: [number, number, number, number] } | undefined)?.rgba;
  return v ? { r: v[0], g: v[1], b: v[2], a: v[3] } : fb;
};

export class StakeSelectScreen extends PanelScreen {
  private tiers: TierRow[] = [];
  private autoButton: UNode | null = null;
  private statusLabel: UNode | null = null;
  private colors = {
    autoSelected: RetentionColors.White, autoIdle: { r: 0.75, g: 0.75, b: 0.78, a: 1 }, selectedLabel: { r: 0.14, g: 0.1, b: 0.04, a: 1 },
    affordableLabel: RetentionColors.White, lockedLabel: RetentionColors.Muted,
  };

  constructor(ctx: ConstructorParameters<typeof PanelScreen>[0]) {
    super(ctx, 'stakes');
  }

  protected build(): void {
    const f = this.built.script('StakeSelectPanel') ?? {};
    this.autoButton = this.ref(f, 'autoButton');
    this.statusLabel = this.ref(f, 'statusLabel');
    const close = this.ref(f, 'closeButton');
    this.colors = {
      autoSelected: rgbaOf(f.autoSelectedColor, this.colors.autoSelected), autoIdle: rgbaOf(f.autoIdleColor, this.colors.autoIdle),
      selectedLabel: rgbaOf(f.selectedLabelColor, this.colors.selectedLabel), affordableLabel: rgbaOf(f.affordableLabelColor, this.colors.affordableLabel),
      lockedLabel: rgbaOf(f.lockedLabelColor, this.colors.lockedLabel),
    };
    const rows = (f.tiers as { Button?: { path: string }; Label?: { path: string }; MinBuyIn?: number }[] | undefined) ?? [];
    this.applyFigmaTables(close, rows);
    wireButton(this.ctx, this.ref(f, 'dimmerButton'), () => this.hide());
    wireButton(this.ctx, close, () => this.hide());
    wireButton(this.ctx, this.autoButton, () => this.select(0));
    for (const r of rows) {
      const button = r.Button ? this.ref({ r: r.Button }, 'r') : null;
      const label = r.Label ? this.ref({ r: r.Label }, 'r') : null;
      const minBuyIn = r.MinBuyIn ?? 0;
      const handle = wireButton(this.ctx, button, () => this.select(minBuyIn));
      const tier = StakeCatalog.tryGet(minBuyIn);
      if (label && tier) label.setText(caption(tier));
      this.tiers.push({ button, handle, label, minBuyIn });
    }
    this.listen('stake:changed', () => this.refresh());
    this.listen('wallet:changed', () => this.refresh());
  }

  protected afterMount(): void {
    this.canvas?.onBeforeLayout(() => this.layoutSheet());
    this.refresh();
  }

  /**
   * The Sheet's VerticalLayoutGroup (control width, not height): the panel was never opened in the editor, so its
   * children were serialized un-laid-out. Stack them as uGUI does: padding, spacing, full inner width, own heights.
   */
  private layoutSheet(): void {
    const sheet = this.root.find('Sheet');
    const lg = sheet ? this.built.dataOf(sheet)?.components?.layoutGroup : undefined;
    if (!sheet || !lg) return;
    const [pl, pr, pt] = lg.padding;
    const spacing = typeof lg.spacing === 'number' ? lg.spacing : 0;
    const w = sheet.sizeDelta[0] - pl - pr;
    let y = pt;
    for (const c of sheet.children) {
      if (!c.activeSelf || this.built.dataOf(c)?.components?.layoutElement?.ignoreLayout) continue;
      const h = c.sizeDelta[1];
      c.anchorMin = [0, 1];
      c.anchorMax = [0, 1];
      c.pivot = [0.5, 0.5];
      c.sizeDelta = [w, h];
      c.anchoredPosition = [pl + w / 2, -(y + h / 2)];
      y += h + spacing;
    }
  }

  private applyFigmaTables(close: UNode | null, rows: { Button?: { path: string } }[]): void {
    const sheet = this.root.find('Sheet');
    if (sheet) {
      applySprite(sheet, 'Retention/Art/Tables/bg');
      const title = sheet.find('Title');
      if (title?.text) {
        title.text.text = 'TABLES';
        title.text.color = RetentionColors.Gold;
      }
    }
    if (this.autoButton && applySprite(this.autoButton, 'Retention/Art/Tables/join_green')) {
      const label = [...this.autoButton.walk()].find((n) => n.text);
      if (label?.text) {
        label.text.text = 'Quick Play  ·  Auto';
        label.text.color = RetentionColors.White;
        label.text.bold = true;
      }
    }
    for (const r of rows) if (r.Button) applySprite(this.ref({ r: r.Button }, 'r'), 'Retention/Art/Tables/num_bg');
    if (close) {
      // DockCloseUnderTopBar.
      if (close.parent && close.parent !== this.root) {
        close.parent.children.splice(close.parent.children.indexOf(close), 1);
        this.root.add(close);
      }
      close.anchorMin = [1, 1];
      close.anchorMax = [1, 1];
      close.pivot = [1, 1];
      close.anchoredPosition = [-18, -118];
      close.sizeDelta = [148, 52];
      applySprite(close, 'Retention/Art/WeeklyRewards/close_btn', false);
      const label = [...close.walk()].find((n) => n.text);
      if (label?.text) {
        label.text.text = 'CLOSE';
        label.text.color = RetentionColors.White;
        label.text.fontSize = 16;
        label.text.autoSize = false;
        label.text.bold = true;
      }
    }
  }

  private select(minBuyIn: number): void {
    const stakes = this.svc?.stakes;
    if (!stakes) return;
    if (minBuyIn > 0) {
      const tier = StakeCatalog.get(minBuyIn);
      if (!stakes.canSit(tier)) {
        this.statusLabel?.setText(`Need ${formatN0(tier.minBuyIn)} Coins to sit at ${tier.displayName}.`);
        return;
      }
    }
    stakes.selectedMinBuyIn = minBuyIn;
    this.ctx.audio.play(PokerSound.ButtonStart);
    this.refresh();
  }

  private refresh(): void {
    const svc = this.svc;
    if (!svc) return;
    const coins = svc.wallet?.coins ?? 0;
    const selected = svc.stakes.selectedMinBuyIn;
    const resolved = svc.stakes.resolve();
    const auto = this.autoButton;
    if (auto?.image) setImageColor(auto, auto.image.sprite ? (selected <= 0 ? this.colors.autoSelected : this.colors.autoIdle) : selected <= 0 ? RetentionColors.Accent : RetentionColors.Reel);
    for (const row of this.tiers) {
      const tier = StakeCatalog.tryGet(row.minBuyIn);
      if (!tier) continue;
      const affordable = coins >= tier.minBuyIn;
      row.handle?.setInteractable(affordable);
      const on = selected === tier.minBuyIn;
      if (row.button?.image) {
        const path = on ? 'Retention/Art/Tables/yellow_scroll' : affordable ? 'Retention/Art/Tables/num_bg' : 'Retention/Art/Tables/scroll_bg';
        if (applySprite(row.button, path)) setImageColor(row.button, affordable ? RetentionColors.White : { r: 0.55, g: 0.55, b: 0.6, a: 0.9 });
        else setImageColor(row.button, on ? RetentionColors.GoldDark : affordable ? RetentionColors.Reel : RetentionColors.TierLocked);
      }
      if (row.label) {
        row.label.setText(caption(tier));
        row.label.setTextColor(on ? this.colors.selectedLabel : affordable ? this.colors.affordableLabel : this.colors.lockedLabel);
      }
    }
    this.statusLabel?.setText(
      selected <= 0
        ? `Quick Play → ${resolved.displayName}  (${formatN0(resolved.minBuyIn)} min · ${resolved.blindsLabel})`
        : `${resolved.displayName}  ·  ${formatN0(resolved.minBuyIn)} min buy-in  ·  blinds ${resolved.blindsLabel}`,
    );
    this.relayout();
  }
}
