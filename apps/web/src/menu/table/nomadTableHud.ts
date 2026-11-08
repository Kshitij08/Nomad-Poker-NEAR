/**
 * Table chrome from the Nomad menu (registered with addTableChrome):
 *  - NomadTableHud.cs: the table's settings button opens the Nomad Settings (with Leave table) instead of the old panel,
 *    and a LEAVE button (a copy of the Check/Fold button's look) sits at the left end of the action row. Leaving asks
 *    first, then ends the session (Unity: TableDisconnectButton / PerTableController.RequestLeave).
 *  - TableMenuChips.cs: the main menu's Coins / Level / Missions / Friends widgets on the table. In Unity they only show
 *    while RetentionMenuHud.BarSuppressed is false, and NomadUiHost sets it true for good once the menu loads — so in
 *    the Nomad flow they never show. Ported as that same rule: nothing is drawn.
 *  - FusionGameplayOverlayHider.cs: hides Fusion's session-code overlay at the table; the web has no such overlay.
 *
 * The table HUD port (src/hud) does not draw the scene's Setting button, so this layer draws it (the HUD canvas's own
 * node, from unity-hud.json) with the same CanvasScaler as the betting panel.
 */
import type { TableChrome, TableSessionHost } from '../../table/tableScreen';
import { buildNode, HUD_DATA, UNode, whenFontsReady, type NodeData } from '../../hud/unityUi';
import { PokerSound } from '@nomad/engine';
import type { NomadHost } from '../host';
import { overlayScale } from '../../layout/portraitRects';
import { portraitNomadTableRects } from '../../layout/portraitHud';

/** RetentionMenuHud.BarSuppressed: set by NomadUiHost.Init and never cleared. */
export const barSuppressed = true;

export interface TableLeaveHooks {
  /** PerTableController on a tournament table: different wording (seat and chips stay in the tournament). */
  isTournament?(host: TableSessionHost): boolean;
}
export const tableLeaveHooks: TableLeaveHooks = {};

export function nomadTableChrome(nomad: NomadHost): TableChrome {
  return (host, layer) => {
    // Review #3: the menu's "working…" note survives the scene load over everything; the table is the answer to it.
    nomad.dialogs.closeBusy();
    const canvas = HUD_DATA.canvases.find((c) => c.role === 'screen-hud');
    if (!canvas) return () => undefined;
    const root = new UNode('NomadTableHud');
    root.el.classList.add('nm-table-chrome', 'nm-canvas');
    const holder = document.createElement('div');
    holder.className = 'nm-layer nm-table-layer';
    holder.append(root.el);
    layer.append(holder);

    const find = (name: string) => canvas.root.children?.find((c) => c.name === name) as NodeData | undefined;
    const confirmLeave = () => {
      if (tableLeaveHooks.isTournament?.(host))
        nomad.message('Leave the tournament table?', "Your seat and chips stay in the tournament: you're blinded while away. Come back from Tournaments > Go to your table.", 'Leave', () => host.leave(), 'Stay');
      else nomad.message('Leave the table?', 'Your chips go back to your balance, then you return to the menu.', 'Leave', () => host.leave(), 'Stay');
    };

    // TakeOverSettings: the Setting button (its "window" child is the old panel's art, off).
    const settingData = find('Setting');
    if (settingData) {
      const s = root.add(buildNode({ ...settingData, active: true }));
      clickable(s, () => {
        host.audio.play(PokerSound.ButtonGeneric);
        nomad.dialogs.settings(confirmLeave);
      });
    }

    // AddLeaveButton: a copy of Check/fold, labelled LEAVE, at the left edge of the action row; only its look.
    const foldData = find('Check/fold');
    if (foldData?.rect) {
      const copy = root.add(buildNode({ ...foldData, name: 'Nomad_Leave', active: true }, { skip: (n) => n.name === 'dot' }));
      const r = foldData.rect;
      copy.anchorMin = copy.anchorMax = [0, r.anchorMin[1]];
      copy.pivot = [0, r.pivot[1]];
      copy.anchoredPosition = [40, r.anchoredPosition[1]];
      copy.sizeDelta = [r.sizeDelta[0] * 0.8, r.sizeDelta[1]];
      for (const t of copy.walk()) {
        if (!t.text) continue;
        t.text.autoSize = true;
        t.text.min = 12;
        t.setText('LEAVE');
      }
      clickable(copy, () => {
        host.audio.play(PokerSound.ButtonGeneric);
        confirmLeave();
      });
    }

    const layout = () => {
      // CanvasScaler as the betting panel's (Scale With Screen Size, 1920×1080, match 0.5).
      const w = holder.clientWidth || window.innerWidth;
      const h = holder.clientHeight || window.innerHeight;
      if (!(w > 0 && h > 0)) return; // zero-size viewport (hidden tab / pane): the scale would be 0 and w / s NaN; the next resize lays out
      const s = overlayScale(w, h); // portrait: layout/portraitHud.ts
      root.sizeDelta = [w / s, h / s];
      root.renderScale = s;
      root.el.style.transform = `scale(${s})`;
      portrait.apply();
      root.layout();
    };
    const portrait = portraitNomadTableRects(root);
    layout();
    whenFontsReady([root]);
    window.addEventListener('resize', layout);
    return () => {
      window.removeEventListener('resize', layout);
      holder.remove();
    };
  };
}

function clickable(n: UNode, fn: () => void): void {
  n.el.classList.add('nm-interactive');
  n.el.addEventListener('pointerdown', () => (n.el.style.filter = 'brightness(0.85)'));
  const up = () => (n.el.style.filter = '');
  n.el.addEventListener('pointerup', up);
  n.el.addEventListener('pointerleave', up);
  n.el.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
}
