/**
 * The retention part of NomadUiHost (Net/NomadUi/NomadUiHost.Agents.cs "Level rewards and missions" + "Lucky slot"):
 * BindRewards, PaintLevelRewards, PaintMissions, OpenDailySpin, PaintSlot and Spin, bound by name on the Nomad
 * menu's own LevelRewards and LuckySlot_Win / LuckySlot_Lost screens.
 *
 * The menu module already binds the MainMenu header (Coins / LV / XP bar), the Daily Spin / Weekly rows and their
 * NotifyDots, and the once-a-session weekly prompt, through ctx.services.retention; this partial takes over
 * host.actions.openDailySpin / openWeeklyRewards so they run the real retention flows.
 */
import type { AppContext } from '../app/app';
import { MissionCatalog, type MissionDef } from '../core/retention';
import type { SpriteData, UNode } from '../hud/unityUi';
import type { NomadHost } from '../menu/host';
import { newText } from '../menu/ui/canvas';
import { LuckySlotController, type SlotScreen } from './nomad/luckySlot';
import { CoroutineHost } from './ui/coroutines';
import { setImageSprite } from './ui/retentionUi';

const SLOT_SCREENS: Record<SlotScreen, string> = { win: 'LuckySlot_Win', lost: 'LuckySlot_Lost' };

export function bindNomadRetention(host: NomadHost, ctx: AppContext): void {
  const svc = ctx.services.retention;
  if (!svc) return;

  // ---------------------------------------------------------------- Level rewards and missions (BindRewards)
  const level = host.screen('LevelRewards');
  let nodeOn: SpriteData | null = null;
  let nodeOff: SpriteData | null = null;
  if (level) {
    nodeOn = host.find(level, 'Content/Panel_Track/Node_Lv1')?.image?.sprite ?? null;
    nodeOff = host.find(level, 'Content/Panel_Track/Node_Lv5')?.image?.sprite ?? null;
  }

  const paintMissions = (content: UNode, prefix: string, defs: readonly MissionDef[]) => {
    const rows = svc.missionRows(defs === MissionCatalog.Daily ? 'daily' : 'weekly');
    const names: (UNode | null)[] = [];
    const rewards: (UNode | null)[] = [];
    for (let i = 1; i <= 5; i++) {
      const row = host.find(content, `Viewport/Content/${prefix}${i}`);
      if (!row) continue;
      // More art rows than missions (5 rows, 3 weekly missions): the spare rows go, not left as blank cards.
      row.setActive(i - 1 < defs.length);
      if (i - 1 >= defs.length) continue;
      names.push(host.find(row, 'Name'));
      rewards.push(host.find(row, 'Reward'));
      const m = rows[i - 1]!;
      host.setText(row, 'Name', m.def.title);
      host.setText(row, 'Reward', m.reward);
      host.setFill(row, 'Progress/Fill', m.target > 0 ? m.progress / m.target : 0);
      host.setText(row, 'Count', `${m.progress}/${m.target}`);
      host.setText(row, 'State', m.state);
      // The rows have no Claim button: a finished mission's row is the button.
      host.ensureClickable(row);
      const b = host.ensureButton(row);
      b.reset();
      const id = m.def.id;
      if (m.done && !m.claimed)
        b.addListener(() => {
          const res = svc.progression.tryClaimMission(id);
          host.message(res.ok ? 'Mission complete' : 'Missions', res.message || (res.ok ? 'Reward added.' : 'Not yet.'));
          paintLevelRewards();
        });
    }
    if (content.activeInHierarchy) {
      host.evenSizes(names);
      host.evenSizes(rewards);
    }
  };

  const paintLevelRewards = () => {
    const root = host.screen('LevelRewards');
    if (!root) return;
    const c = host.find(root, 'Content');
    if (!c) return;
    const m = svc.levelRewardsModel();
    host.setText(c, 'Panel_Level/Level', `Level ${m.level}`);
    host.setText(c, 'Panel_Level/XP', m.xpText);
    host.setFill(c, 'Panel_Level/XPBar/Fill', m.progress01);
    host.setText(c, 'Panel_Level/ToNext', m.toNextText);
    host.setText(c, 'Panel_Level/NextLevel', m.nextLevelText);
    host.setText(c, 'Panel_Level/NextReward', m.nextRewardText);
    host.setText(c, 'Panel_Level/NextHint', m.hint);
    // The track: five levels around the current one.
    m.track.forEach((t, i) => {
      host.setText(c, `Panel_Track/Lv_${i + 1}`, t.label);
      host.setText(c, `Panel_Track/Reward_${i + 1}`, t.reward);
      const node = host.find(c, `Panel_Track/Node_Lv${i + 1}`);
      if (node?.image && nodeOn && nodeOff) setImageSprite(node, t.reached ? nodeOn : nodeOff);
    });
    paintMissions(c, 'Mission_', MissionCatalog.Daily);
    paintMissions(c, 'Weekly_', MissionCatalog.Weekly);
  };

  host.onScreenShown('LevelRewards', paintLevelRewards);
  host.onRefresh(() => {
    if (host.isShowing('LevelRewards')) paintLevelRewards();
  });

  // ---------------------------------------------------------------- Lucky slot (daily spin)
  const win = host.screen(SLOT_SCREENS.win);
  const lost = host.screen(SLOT_SCREENS.lost);
  if (win && lost) {
    const co = new CoroutineHost();
    const slot = new LuckySlotController(ctx, co, {
      roots: { win, lost },
      show: (which) => host.show(SLOT_SCREENS[which]),
      isShowing: (which) => host.isShowing(SLOT_SCREENS[which]),
      message: (title, body) => host.message(title, body),
      bindSpin: (node, onClick) => {
        // Bind(root, "Content/Machine/Btn_Spin", Spin, replaceNavigation: true)
        const b = host.ensureButton(node);
        b.disablePersistent();
        b.addListener(onClick);
        return b;
      },
      newNote: (content, text) => {
        const n = newText(content, 'SpinNote', text, 30, true, [0, -420], [1200, 50]);
        if (n.text) {
          n.text.color = { r: 1, g: 0.86, b: 0.45, a: 1 };
          n.render();
        }
        n.el.style.pointerEvents = 'none';
        return n;
      },
      get signedIn() {
        return host.signedIn;
      },
      showLogin: () => host.show('Login'),
    });
    for (const which of ['win', 'lost'] as const) host.onScreenShown(SLOT_SCREENS[which], () => slot.onShown(which));
    host.onRefresh(() => {
      for (const which of ['win', 'lost'] as const) if (host.isShowing(SLOT_SCREENS[which])) slot.paint(which);
    });
    host.actions.openDailySpin = () => slot.open();
  }

  // ---------------------------------------------------------------- Weekly rewards (OpenWeeklyRewards)
  // The art team's WeeklyRewards_Screen mounted as an overlay above the menu (MountOverlay, order 560).
  host.actions.openWeeklyRewards = () => {
    if (ctx.router.has('weekly-reward')) void ctx.router.push('weekly-reward');
    else host.message('Weekly rewards', "The rewards screen isn't loaded.");
  };

  // DailyEngagement.Changed / PlayerProgression.Changed → RefreshSoon (the dots, the header, open screens).
  ctx.events.on('engagement:changed', () => host.refreshSoon());
}
