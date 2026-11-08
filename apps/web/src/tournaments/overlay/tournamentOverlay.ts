import { TournamentPhase, TournamentPlayerState, TournamentViewReason, type TournamentResultEvent, type TournamentStatusEvent, type TournamentTableLine, type TournamentViewEvent } from '@nomad/engine/tournament';
import type { TableChrome } from '../../table/tableScreen';
import type { TournamentClientState } from '../clientState';
import { N0, clock, ordinal } from '../format';
import { Colors, anchored, button, el, group, label, overlayCanvas, verticalScroll } from '../ui/retentionDom';

/** TMP rich text the Unity overlay writes: the FAST LEVELS tag colour. */
const FAST = '#f27350';

/**
 * What a tournament player sees over the felt. Port of Tournaments/TournamentTableOverlay.cs:
 * - a banner with the round, the table, the blinds and the level clock ("FAST LEVELS" when this table is the one
 *   everyone is waiting on), plus how many are left and the prizes;
 * - while waiting for the next round, or after going out, the list of tables with a Watch button each;
 * - the result when it comes (champion / finished Nth / knocked out).
 * Added as table chrome; shown only while a tournament's client state is active (any table visit otherwise sees
 * nothing). Refreshes every 0.25 s like the C# coroutine, and on every state change.
 */
export function tournamentOverlayChrome(state: TournamentClientState): TableChrome {
  return (host, layer) => {
    const overlay = new TournamentTableOverlay(layer, state, () => {
      const leave = state.leaveHandler;
      state.clear();
      if (leave) leave();
      else host.leave();
    });
    return () => overlay.dispose();
  };
}

export class TournamentTableOverlay {
  private readonly canvas: { root: HTMLElement; dispose: () => void };
  private readonly rootEl: HTMLElement;
  private readonly title: ReturnType<typeof label>;
  private readonly blinds: ReturnType<typeof label>;
  private readonly field: ReturnType<typeof label>;
  private readonly tablesButton: HTMLElement;
  private readonly tablesPanel: HTMLElement;
  private readonly tablesTitle: ReturnType<typeof label>;
  private readonly tablesBody: ReturnType<typeof label>;
  private readonly tablesList: HTMLElement;
  private tablesSignature: string | null = null;
  private readonly resultPanel: HTMLElement;
  private readonly resultTitle: ReturnType<typeof label>;
  private readonly resultBody: ReturnType<typeof label>;
  private shownResult: TournamentResultEvent | null = null;
  private tablesOpenByChoice = false;
  private tablesDismissed = false;
  private readonly timer: number;
  private readonly unsubscribe: () => void;

  constructor(parent: HTMLElement, private readonly state: TournamentClientState, private readonly leave: () => void) {
    this.canvas = overlayCanvas(parent, 505);
    this.rootEl = el('div', 'trn-overlay', this.canvas.root);
    this.rootEl.style.position = 'absolute';
    this.rootEl.style.inset = '0';

    // ---- Banner
    const banner = group(this.rootEl, 'row', 10, [18, 12, 8, 8]);
    banner.classList.add('trn-panel');
    banner.style.background = Colors.BannerBg;
    banner.style.alignItems = 'stretch';
    anchored(banner, 0.5, 1, [0, -12], 820, 112);
    const lines = group(banner, 'column', 0);
    lines.style.flex = '1 1 0';
    lines.style.justifyContent = 'center';
    this.title = label(lines, 'Tournament', 21, Colors.Gold, { align: 'left', height: 30 });
    this.blinds = label(lines, '', 19, Colors.White, { align: 'left', height: 30 });
    this.field = label(lines, '', 16, Colors.Muted, { align: 'left', height: 26 });
    this.tablesButton = button(banner, 'Tables', Colors.Grey, 44, 120, () => {
      this.tablesOpenByChoice = !this.tablesOpenByChoice;
      if (this.tablesOpenByChoice) this.tablesDismissed = false;
      this.refresh();
    });
    this.tablesButton.style.alignSelf = 'center';

    // ---- Tables panel
    this.tablesPanel = group(this.rootEl, 'column', 10, [24, 24, 20, 20]);
    this.tablesPanel.classList.add('trn-panel');
    this.tablesPanel.style.background = Colors.Panel;
    anchored(this.tablesPanel, 0.5, 0.5, [0, -40], 680, 520);
    const header = group(this.tablesPanel, 'row', 8);
    header.style.height = '46px';
    header.style.flex = '0 0 auto';
    this.tablesTitle = label(header, '', 26, Colors.Gold, { bold: true, align: 'left' });
    this.tablesTitle.style.flex = '1 1 0';
    this.tablesTitle.style.alignSelf = 'stretch';
    button(header, 'Close', Colors.Grey, 42, 120, () => this.dismissTables());
    this.tablesBody = label(this.tablesPanel, '', 17, Colors.Muted, { height: 52 });
    this.tablesList = verticalScroll(this.tablesPanel, 260);
    const leaveTables = button(this.tablesPanel, 'Back to lobby', Colors.Grey, 48, 0, () => this.leave());
    leaveTables.style.flex = '0 0 auto';
    this.tablesPanel.classList.add('trn-hidden');

    // ---- Result panel
    this.resultPanel = group(this.rootEl, 'column', 12, [28, 28, 24, 24]);
    this.resultPanel.classList.add('trn-panel');
    this.resultPanel.style.background = Colors.Panel;
    anchored(this.resultPanel, 0.5, 0.5, [0, 0], 600, 380);
    this.resultTitle = label(this.resultPanel, '', 34, Colors.Gold, { bold: true, height: 52 });
    this.resultBody = label(this.resultPanel, '', 20, Colors.White, { height: 150 });
    const buttons = group(this.resultPanel, 'row', 12);
    buttons.style.height = '52px';
    buttons.style.flex = '0 0 auto';
    button(buttons, 'Close', Colors.Grey, 50, 0, () => this.resultPanel.classList.add('trn-hidden'));
    button(buttons, 'Back to lobby', Colors.TourGold, 50, 0, () => this.leave());
    this.resultPanel.classList.add('trn-hidden');

    this.rootEl.classList.add('trn-hidden');
    this.timer = window.setInterval(() => this.refresh(), 250);
    this.unsubscribe = state.onChanged(() => this.refresh());
    this.refresh();
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.unsubscribe();
    this.canvas.dispose();
  }

  /** The root element (tests / debugging). */
  get element(): HTMLElement {
    return this.rootEl;
  }

  refresh(): void {
    const active = this.state.active && this.state.session !== null;
    this.rootEl.classList.toggle('trn-hidden', !active);
    if (!active) {
      this.shownResult = null;
      this.tablesOpenByChoice = false;
      this.tablesDismissed = false;
      return;
    }

    const status = this.state.status;
    const view = this.state.view;
    this.renderBanner(status, view);

    const offTable = !view || view.tableId < 0;
    const watching = !!view && view.reason === TournamentViewReason.Watching;
    this.tablesButton.classList.toggle('trn-hidden', !(offTable || watching));
    const showTables = (offTable && !this.tablesDismissed) || this.tablesOpenByChoice;
    this.tablesPanel.classList.toggle('trn-hidden', !showTables);
    if (showTables) this.renderTables(status, view);

    const result = this.state.result;
    if (result && result !== this.shownResult) {
      this.shownResult = result;
      this.showResult(result);
    }
  }

  private renderBanner(status: TournamentStatusEvent | null, view: TournamentViewEvent | null): void {
    if (!status) {
      this.title.setText('Tournament');
      this.blinds.setText('Connecting…');
      this.field.setText('');
      return;
    }

    let line: TournamentTableLine | null = null;
    if (view && view.tableId >= 0) for (const t of status.tables) if (t.tableId === view.tableId) line = t;

    const where = line ? (line.isFinal ? 'Final table' : `Round ${line.round} · Table ${line.tableId + 1}`)
      : status.phase === TournamentPhase.BeforeStart ? 'Starting soon'
        : status.myState === TournamentPlayerState.Eliminated ? "You're out"
          : status.myState === TournamentPlayerState.Waiting ? "You're through — waiting"
            : '';
    const watching = view && view.reason === TournamentViewReason.Watching ? ' · watching' : '';
    this.title.setText(`<b>${status.name}</b>${where.length > 0 ? ' · ' + where : ''}${watching}`);

    if (status.phase === TournamentPhase.BeforeStart) this.blinds.setText(`Starts in ${clock(status.startsInSeconds)}`);
    else if (status.phase === TournamentPhase.Cancelled) this.blinds.setText('The tournament was called off. Entry fees and the prize are refunded.');
    else if (status.phase === TournamentPhase.Finished) this.blinds.setText('Finished');
    else if (line && !line.isDealing) this.blinds.setText(`First hand in ${line.dealInSeconds}s`);
    else if (line) {
      const fast = line.isSpedUp ? `  <color=${FAST}>FAST LEVELS</color>` : '';
      this.blinds.setText(`Level ${line.level} · ${N0(line.smallBlind)}/${N0(line.bigBlind)} · next in ${clock(line.secondsToNextLevel)}${fast}`);
    } else this.blinds.setText('');

    this.field.setText(status.phase === TournamentPhase.BeforeStart
      ? `${status.entrants} players · 1st ${N0(status.firstPrize)} · 2nd ${N0(status.secondPrize)}`
      : `${status.playersRemaining}/${status.entrants} left · 1st ${N0(status.firstPrize)} · 2nd ${N0(status.secondPrize)}`);
  }

  private renderTables(status: TournamentStatusEvent | null, view: TournamentViewEvent | null): void {
    this.tablesTitle.setText(!status ? 'Tournament'
      : status.phase === TournamentPhase.BeforeStart ? 'Starting soon'
        : status.phase === TournamentPhase.Finished ? 'Tournament over'
          : status.myState === TournamentPlayerState.Eliminated ? "You're out — watch the rest"
            : status.myState === TournamentPlayerState.Waiting ? "You're through to the next round!"
              : status.myState === TournamentPlayerState.Spectator ? 'Watching'
                : 'Tables');

    const open = status?.tables.filter((t) => !t.isClosed) ?? [];
    this.tablesBody.setText(status?.phase === TournamentPhase.BeforeStart
      ? "Tables are drawn at the start time. Stay here — you'll be seated automatically."
      : status?.myState === TournamentPlayerState.Waiting
        ? "Your next table opens when another table finishes. You'll be moved there with a 60-second countdown."
        : open.length === 0 ? 'No tables are playing.' : 'Pick a table to watch.');

    const signature = open.map((t) => `${t.tableId}:${t.playersLeft}:${view && view.tableId === t.tableId ? 1 : 0}`).join(',');
    if (signature === this.tablesSignature) return;
    this.tablesSignature = signature;

    this.tablesList.replaceChildren();
    const seated = !!status && status.myState === TournamentPlayerState.Seated;
    for (const t of open) {
      const row = group(this.tablesList, 'row', 10);
      row.style.height = '46px';
      row.style.flex = '0 0 auto';
      const name = t.isFinal ? 'Final table' : `Round ${t.round} · Table ${t.tableId + 1}`;
      const lab = label(row, `${name} · ${t.playersLeft} left${t.isSpedUp ? ' · fast' : ''}`, 18, Colors.White, { align: 'left' });
      lab.style.flex = '1 1 0';
      lab.style.alignSelf = 'stretch';
      const current = !!view && view.tableId === t.tableId;
      if (!seated) {
        const id = t.tableId;
        button(row, current ? 'Watching' : 'Watch', current ? Colors.Grey : Colors.TourGold, 42, 140, () => {
          this.state.requestWatch(id);
          this.tablesOpenByChoice = false;
        });
      }
    }
  }

  private showResult(result: TournamentResultEvent): void {
    const prize = result.yourPrize > 0 ? `\nYou won <b>${N0(result.yourPrize)}</b> chips.` : '';
    const xp = result.xpEarned > 0 ? `\n+${result.xpEarned} XP` : '';
    if (result.finished && result.youWon) {
      this.resultTitle.setText('Champion!');
      this.resultBody.setText(`You won the tournament.${prize}${xp}`);
    } else if (result.finished) {
      this.resultTitle.setText(result.yourPlace > 0 ? `You finished ${ordinal(result.yourPlace)} of ${result.entrants}` : 'Tournament over');
      const winner = result.championName ? `\nWinner: ${result.championName}` : '';
      this.resultBody.setText(`${winner}${prize}${xp}`.replace(/^\n+/, ''));
    } else {
      this.resultTitle.setText("You're out");
      this.resultBody.setText(`Knocked out in round ${result.yourRound}.${xp}\nStay and watch, or head back to the lobby.`);
    }
    this.resultPanel.classList.remove('trn-hidden');
  }

  private dismissTables(): void {
    this.tablesOpenByChoice = false;
    this.tablesDismissed = true;
    this.tablesPanel.classList.add('trn-hidden');
  }
}
