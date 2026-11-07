/**
 * The retention HUD as a mountable component: `mountRetentionHud(ctx, el)`.
 *
 * Unity: RetentionMenuHud's own top bar is always switched off (its Update hides barRoot: "The table uses the main
 * menu's own widgets"). What shows on the RetentionHud canvas is TableMenuChips (Net/NomadUi): the main menu art's
 * Coins, Level, Missions and Friends widgets cloned and pinned under the top edge, wired to OpenDailySpin /
 * OpenMissions / the friends panel. Both are hidden while the Nomad menu runs (RetentionMenuHud.BarSuppressed), so in
 * the shipped flow nothing of this HUD is visible; it shows in the plain table flow (Test.unity, no Nomad menu).
 *
 * The panels it opens are router overlays: Coins → 'daily-spin', Level / Missions → 'missions'. Friends emits
 * 'friends:open' on ctx.events (the social module owns that panel).
 */
import type { AppContext } from './../app/app';
import { formatN0 } from '../core/util/dotnetMath';
import { whenFontsReady, UNode } from '../hud/unityUi';
import { OverlayCanvas, RETENTION_DATA, chipData, instantiate, wireButton } from './ui/retentionUi';

const TOP_INSET = 8;

export interface RetentionHudHandle {
  /** RetentionMenuHud.BarSuppressed: hide the chips (the Nomad menu draws its own top bar). */
  setSuppressed(v: boolean): void;
  refresh(): void;
  dispose(): void;
}

export function mountRetentionHud(ctx: AppContext, el: HTMLElement, opts: { suppressed?: boolean } = {}): RetentionHudHandle {
  const root = new UNode('TableMenuChips');
  root.sizeDelta = [1920, 1080];
  const holder = document.createElement('div');
  holder.className = 'rt-chips';
  el.append(holder);
  // The chips live on the RetentionHud canvas (its CanvasScaler).
  const scaler = RETENTION_DATA.canvases.spin?.scaler ?? { mode: 1, referenceResolution: [1920, 1080] as [number, number], match: 0.5 };
  const canvas = new OverlayCanvas(holder, root, scaler);

  const add = (key: 'coins' | 'level' | 'missions' | 'friends', name: string): UNode | null => {
    const d = chipData(key);
    if (!d) return null;
    const n = instantiate({ ...d, name, active: true });
    root.add(n);
    return n;
  };
  const coins = add('coins', 'Coins');
  const level = add('level', 'Level');
  const missions = add('missions', 'Missions');
  const friends = add('friends', 'Friends');
  pinTop(coins, true);
  pinTop(level, true);
  pinTop(missions, false, level ? 596 : 337);
  pinTop(friends, false, -191, true);

  const open = (id: string) => () => {
    if (ctx.router.has(id)) void ctx.router.push(id);
  };
  wireButton(ctx, coins, open('daily-spin'));
  wireButton(ctx, level, open('missions'));
  wireButton(ctx, missions, open('missions'));
  wireButton(ctx, friends, () => (ctx.router.has('friends') ? void ctx.router.push('friends') : ctx.events.emit('friends:open')));

  const coinsLabel = coins?.find('Value') ?? null;
  const levelLabel = level?.find('Caption') ?? null;
  const xpFill = level?.find('XPBar/Fill') ?? null;

  const refresh = () => {
    const svc = ctx.services.retention;
    coinsLabel?.setText(formatN0(ctx.services.wallet?.coins ?? 0));
    levelLabel?.setText(`LV ${svc?.progression.level ?? 1}`);
    if (xpFill) {
      const amount = Math.min(1, Math.max(0, svc?.progression.levelProgress01 ?? 0));
      if (xpFill.image?.type === 'Filled') xpFill.image.fillAmount = amount;
      else {
        xpFill.anchorMin = [0, xpFill.anchorMin[1]];
        xpFill.anchorMax = [amount, xpFill.anchorMax[1]];
        xpFill.anchoredPosition = [0, xpFill.anchoredPosition[1]];
        xpFill.sizeDelta = [0, xpFill.sizeDelta[1]];
      }
      if (xpFill.parent) xpFill.layout();
    }
  };
  const offs = [ctx.events.on('wallet:changed', refresh), ctx.events.on('progression:changed', refresh)];
  let suppressed = !!opts.suppressed;
  const apply = () => (holder.style.display = suppressed ? 'none' : '');
  apply();
  refresh();
  canvas.layout();
  whenFontsReady([root]);

  return {
    setSuppressed(v) {
      suppressed = v;
      apply();
    },
    refresh,
    dispose() {
      for (const o of offs) o();
      canvas.dispose();
      holder.remove();
    },
  };
}

/** TableMenuChips.PinTop: the chip's top sits just under the screen edge. */
function pinTop(row: UNode | null, keepX: boolean, centerX = 0, fromRight = false): void {
  if (!row) return;
  const h = row.sizeDelta[1] > 1 ? row.sizeDelta[1] : 82;
  const y = -(TOP_INSET + h * 0.5);
  const x = keepX ? row.anchoredPosition[0] : centerX;
  row.anchorMin = [fromRight ? 1 : 0, 1];
  row.anchorMax = [fromRight ? 1 : 0, 1];
  row.pivot = [0.5, 0.5];
  row.anchoredPosition = [x, y];
  row.scale = [1, 1];
}
