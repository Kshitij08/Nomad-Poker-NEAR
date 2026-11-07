/**
 * Weekly (7-day login) rewards. Port of Game/Retention/LoginRewardsPanel.cs + WeeklyRewardCard.cs on the art team's
 * WeeklyRewards_Screen prefab (what NomadUiHost.OpenWeeklyRewards mounts at sorting order 560). Each day card shows
 * its own CLAIM / Claimed / Locked state; CLAIM on today's card claims the day and closes the screen.
 *
 * Router ids 'weekly-reward' and 'login-rewards' (overlay).
 */
import { RewardKind, type RewardGrant } from '../../app/services';
import { LoginRewardCatalog, loginRewardSummary } from '../../core/retention';
import { PokerSound } from '../../core/orchestration/pokerSound';
import type { SpriteData, UNode } from '../../hud/unityUi';
import {
  setImageEnabled, setImageSprite, setTextEnabled, spriteByKey, wireButton,
} from '../ui/retentionUi';
import { PanelScreen } from './panelScreen';

enum CardState {
  Locked,
  Claimable,
  Claimed,
}

/** WeeklyRewardCard view over one Card_Day_N subtree. */
class WeeklyRewardCardView {
  readonly background: UNode | null;
  readonly activeGlow: UNode | null;
  readonly title: UNode | null;
  readonly iconGlow: UNode | null;
  readonly icon: UNode | null;
  readonly iconLabel: UNode | null;
  readonly reward: UNode | null;
  readonly claimButton: UNode | null;
  readonly claimedPill: UNode | null;
  readonly lockedPill: UNode | null;
  private readonly normalSprite: SpriteData | null;
  private readonly activeSprite: SpriteData | null;
  private readonly stackRewardLines: boolean;

  constructor(ref: (k: string) => UNode | null, fields: Record<string, unknown>) {
    this.background = ref('background');
    this.activeGlow = ref('activeGlow');
    this.title = ref('title');
    this.iconGlow = ref('iconGlow');
    this.icon = ref('icon');
    this.iconLabel = ref('iconLabel');
    this.reward = ref('reward');
    this.claimButton = ref('claimButton');
    this.claimedPill = ref('claimedPill');
    this.lockedPill = ref('lockedPill');
    this.normalSprite = spriteByKey((fields.normalSprite as { sprite?: string } | null)?.sprite);
    this.activeSprite = spriteByKey((fields.activeSprite as { sprite?: string } | null)?.sprite);
    this.stackRewardLines = !!fields.stackRewardLines;
  }

  setReward(dayTitle: string, rewardText: string, rewardIcon: SpriteData | null, iconText: string | null): void {
    this.title?.setText(dayTitle);
    this.reward?.setText(this.stackRewardLines ? rewardText.replace(/ \+ /g, '\n+ ') : rewardText);
    if (this.icon) {
      setImageSprite(this.icon, rewardIcon);
      setImageEnabled(this.icon, !!rewardIcon);
    }
    if (this.iconLabel) {
      const has = !!iconText;
      if (has) this.iconLabel.setText(iconText!);
      setTextEnabled(this.iconLabel, has);
      // Txt_IconLabel is an inactive object in the art; TMP.enabled alone cannot show it.
      if (has) this.iconLabel.setActive(true);
    }
    if (this.iconGlow) setImageEnabled(this.iconGlow, false); // glowSprite is always null from LoginRewardsPanel
  }

  setState(state: CardState): void {
    const claimable = state === CardState.Claimable;
    if (this.background && this.normalSprite) setImageSprite(this.background, claimable && this.activeSprite ? this.activeSprite : this.normalSprite);
    if (this.activeGlow) setImageEnabled(this.activeGlow, claimable);
    this.claimButton?.setActive(claimable);
    this.claimedPill?.setActive(state === CardState.Claimed);
    this.lockedPill?.setActive(state === CardState.Locked);
  }
}

export class WeeklyRewardsScreen extends PanelScreen {
  private cards: WeeklyRewardCardView[] = [];
  private statusLabel: UNode | null = null;
  private tokensLabel: UNode | null = null;
  private defaultSubtitle = '';

  constructor(ctx: ConstructorParameters<typeof PanelScreen>[0]) {
    super(ctx, 'weekly');
  }

  protected build(): void {
    const f = this.built.script('LoginRewardsPanel') ?? {};
    const sp = (k: string) => spriteByKey((f[k] as { sprite?: string } | null)?.sprite);
    const coinsSmall = sp('coinsSmallIcon');
    const coinsLarge = sp('coinsLargeIcon');
    const xpIcon = sp('xpIcon');
    const gemsIcon = sp('gemsIcon');
    const grandIcon = sp('grandIcon');
    const coinsLargeFrom = (f.coinsLargeFrom as number) ?? 1000;
    const grandIconText = String(f.grandIconText ?? 'XP');
    this.defaultSubtitle = String(f.defaultSubtitle ?? 'Log in daily to claim your rewards and keep your streak going!');
    this.statusLabel = this.ref(f, 'statusLabel');
    this.tokensLabel = this.ref(f, 'tokensLabel');

    const iconFor = (g: RewardGrant): { icon: SpriteData | null; text: string | null } => {
      if (g.kind === RewardKind.Xp && xpIcon) return { icon: xpIcon, text: 'XP' };
      if (g.kind === RewardKind.Gems) {
        if (gemsIcon) return { icon: gemsIcon, text: null };
        if (xpIcon) return { icon: xpIcon, text: 'GEM' };
      }
      return { icon: g.kind === RewardKind.Coins && g.amount >= coinsLargeFrom && coinsLarge ? coinsLarge : coinsSmall, text: null };
    };

    // Wire(): dimmer / close → Hide, each card's reward + CLAIM.
    wireButton(this.ctx, this.ref(f, 'dimmerButton'), () => this.hide());
    wireButton(this.ctx, this.ref(f, 'closeButton'), () => this.hide());
    wireButton(this.ctx, this.ref(f, 'claimButton'), () => this.onClaimClicked(), { sound: PokerSound.ButtonStart });
    const dayCards = (f.dayCards as { View?: { path: string } }[] | undefined) ?? [];
    const days = LoginRewardCatalog.Days;
    for (let i = 0; i < dayCards.length && i < days.length; i++) {
      const viewRef = dayCards[i]?.View;
      if (!viewRef) continue;
      const cardNode = this.ref({ v: viewRef }, 'v');
      if (!cardNode) continue;
      const cf = this.built.dataOf(cardNode)?.components?.scripts?.find((s) => s.script === 'WeeklyRewardCard')?.fields ?? {};
      const view = new WeeklyRewardCardView((k) => this.ref(cf, k), cf);
      const day = days[i]!;
      const isGrand = i === days.length - 1 && !!grandIcon;
      const pick = isGrand ? { icon: grandIcon, text: grandIconText } : iconFor(day.primary);
      view.setReward(day.title, loginRewardSummary(day), pick.icon, pick.text);
      if (view.claimButton) wireButton(this.ctx, view.claimButton, () => this.onClaimClicked(), { sound: PokerSound.ButtonStart });
      this.cards[i] = view;
    }
    this.listen('engagement:changed', () => this.refresh());
    this.listen('wallet:changed', () => this.refresh());
  }

  protected afterMount(): void {
    this.refresh();
  }

  private onClaimClicked(): void {
    const svc = this.svc;
    if (!svc) return;
    const result = svc.engagement.tryClaimLogin();
    if (result.canClaim) {
      this.ctx.audio.play(PokerSound.ChipsToWinner);
      this.refresh();
      this.hide();
      return;
    }
    this.refresh();
  }

  private refresh(): void {
    const svc = this.svc;
    if (!svc) return;
    const state = svc.engagement.load();
    const preview = svc.engagement.previewLogin();
    const tokens = svc.wallet?.streakTokens ?? 0;
    this.tokensLabel?.setText(`Streak Shields: ${tokens}`);
    this.cards.forEach((card, i) => {
      if (!card) return;
      const day = i + 1;
      let done: boolean;
      let current: boolean;
      if (preview.reset && preview.canClaim) {
        done = false;
        current = day === preview.day;
      } else if (!preview.canClaim) {
        done = day <= state.streakDay;
        current = day === state.streakDay;
      } else {
        done = day < preview.day;
        current = day === preview.day;
      }
      card.setState(current && preview.canClaim ? CardState.Claimable : done ? CardState.Claimed : CardState.Locked);
    });
    if (this.statusLabel) {
      if (preview.canClaim && preview.tokenConsumed) this.statusLabel.setText("A Streak Shield will cover yesterday's miss.");
      else if (preview.canClaim && preview.reset) this.statusLabel.setText('Streak reset — starting a new 7-day track.');
      else this.statusLabel.setText(this.defaultSubtitle);
    }
    this.relayout();
  }
}
