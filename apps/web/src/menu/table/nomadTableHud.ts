/**
 * Table chrome from the Nomad menu (registered with addTableChrome), Redesign v2 (docs/ui-style-guide.md):
 *  - Leave: a top-left chip on every table (it used to sit in the action row on desktop, next to Fold). Leaving asks
 *    first, then ends the session (Unity: TableDisconnectButton / PerTableController.RequestLeave).
 *  - Settings: the top-right gear opens Settings with Leave table (NomadTableHud.TakeOverSettings); host.dialogs is
 *    rendered by the v2 global dialog layer (src/ui2/globalDialogs.ts), so Settings and the Leave confirm are v2.
 *  - Hand rankings: a "?" next to the gear opens the ranking list (hidden on phones at a tournament table, whose
 *    title uses the top row there).
 *  - TableMenuChips.cs (Coins / Level / Missions / Friends on the table): RetentionMenuHud.BarSuppressed is set true for
 *    good once the Nomad menu loads, so in the Nomad flow they never show. Ported as that same rule: nothing is drawn.
 */
import type { TableChrome, TableSessionHost } from '../../table/tableScreen';
import { PokerSound } from '@nomad/engine';
import type { NomadHost } from '../host';
import { chromeSlots, chipButton, iconButton, openHandRankings, tIcon } from '../../ui2/tableChrome';

/** RetentionMenuHud.BarSuppressed: set by NomadUiHost.Init and never cleared. */
export const barSuppressed = true;

export interface TableLeaveHooks {
  /** PerTableController on a tournament table: different wording (seat and chips stay in the tournament). */
  isTournament?(host: TableSessionHost): boolean;
  /** Own wording for the Leave confirm (e.g. an offline practice tournament, which simply ends). */
  leaveText?(host: TableSessionHost): { title: string; body: string } | null;
}
export const tableLeaveHooks: TableLeaveHooks = {};

export function nomadTableChrome(nomad: NomadHost): TableChrome {
  return (host, layer) => {
    // Review #3: the menu's "working…" note survives the scene load over everything; the table is the answer to it.
    nomad.dialogs.closeBusy();
    const slots = chromeSlots(layer);
    const confirmLeave = (): void => {
      const own = tableLeaveHooks.leaveText?.(host);
      if (own) nomad.message(own.title, own.body, 'Leave', () => host.leave(), 'Stay');
      else if (tableLeaveHooks.isTournament?.(host))
        nomad.message('Leave the tournament table?', "Your seat and chips stay in the tournament: you're blinded while away. Come back from Tournaments › Go to your table.", 'Leave', () => host.leave(), 'Stay');
      else nomad.message('Leave the table?', 'Your chips go back to your balance, then you return to the menu.', 'Leave', () => host.leave(), 'Stay');
    };
    const click = (fn: () => void) => () => {
      host.audio.play(PokerSound.ButtonGeneric);
      fn();
    };

    const leave = chipButton(slots.left, `${tIcon('back', 1)}<span>Leave</span>`, 'Leave the table', click(confirmLeave), 'leave', 0);
    const settings = iconButton(slots.right, 'gear', 'Settings', click(() => nomad.dialogs.settings(confirmLeave)), 9);
    const rankings = iconButton(slots.right, 'help', 'Hand rankings', click(() => openHandRankings(slots.layer)), 8);
    rankings.classList.add('help'); // hidden on phones while a tournament title shares the top row (tableChrome.css)

    return () => {
      leave.remove();
      settings.remove();
      rankings.remove();
    };
  };
}
