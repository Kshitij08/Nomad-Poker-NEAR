import { TournamentPhase, TournamentPlayerState, TournamentViewReason, type TournamentResultEvent, type TournamentStatusEvent, type TournamentTableLine, type TournamentViewEvent } from '@nomad/engine/tournament';
import type { TableChrome } from '../../table/tableScreen';
import type { TournamentClientState } from '../clientState';
import { N0, clock, ordinal } from '../format';
import { ico, ICO } from '../../ui2/icons';
import { v2tButton, v2tEl, v2tLayer } from '../../ui2/tableKit';

/**
 * What a tournament player sees over the felt. Port of Tournaments/TournamentTableOverlay.cs, in the Redesign v2 look
 * (Screen Atlas › Tournament table):
 * - the tournament name is the table's top-left title (round and table under it); its dropdown holds the level and
 *   blinds, the level clock (fast when this table is the one everyone is waiting on), players left, the payout, and
 *   the Tables button (the floating banner is gone);
 * - while waiting for the next round, or after going out, the list of tables with a Watch button each;
 * - the result when it comes (champion / finished Nth / knocked out) as a v2 dialog.
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
  private readonly rootEl: HTMLElement;
  private readonly titleBtn: HTMLButtonElement;
  private readonly titleName: HTMLElement;
  private readonly titleSub: HTMLElement;
  private readonly info: HTMLElement;
  private readonly infoRows: HTMLElement;
  private readonly tablesDim: HTMLElement;
  private readonly tablesTitle: HTMLElement;
  private readonly tablesBody: HTMLElement;
  private readonly tablesList: HTMLElement;
  private tablesSignature: string | null = null;
  private readonly resultDim: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultBody: HTMLElement;
  private shownResult: TournamentResultEvent | null = null;
  private infoOpen = false;
  private tablesOpenByChoice = false;
  private tablesDismissed = false;
  private infoSignature = '';
  private readonly timer: number;
  private readonly unsubscribe: () => void;

  constructor(parent: HTMLElement, private readonly state: TournamentClientState, private readonly leave: () => void) {
    this.rootEl = v2tLayer(parent, 505, 'trn-overlay');

    // ---- Title (top-left) + dropdown
    this.titleBtn = v2tEl('button', 'v2t-ttitle', this.rootEl);
    this.titleBtn.type = 'button';
    this.titleBtn.setAttribute('aria-haspopup', 'true');
    this.titleName = v2tEl('b', '', this.titleBtn, 'Tournament');
    this.titleSub = v2tEl('small', '', this.titleBtn);
    this.titleBtn.insertAdjacentHTML('beforeend', ico('chev', 1));
    this.titleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.infoOpen = !this.infoOpen;
      this.refresh();
    });

    this.info = v2tEl('div', 'v2t-panel v2t-tinfo', this.rootEl);
    this.infoRows = v2tEl('div', '', this.info);
    v2tButton(this.info, 'Tables', 'blue', () => {
      this.infoOpen = false;
      this.tablesOpenByChoice = true;
      this.tablesDismissed = false;
      this.refresh();
    }, 'w');
    this.info.hidden = true;

    // ---- Tables sheet
    this.tablesDim = v2tEl('div', 'v2t-dim', this.rootEl);
    const tables = v2tEl('div', 'v2t-panel v2t-tables', this.tablesDim);
    this.tablesTitle = v2tEl('b', 'v2t-h', tables);
    this.tablesBody = v2tEl('span', 'v2t-mut', tables);
    this.tablesList = v2tEl('div', 'v2t-tables-list', tables);
    const tRow = v2tEl('div', 'v2t-row', tables);
    v2tButton(tRow, 'Back to lobby', 'ghost', () => this.leave());
    v2tButton(tRow, 'Close', 'gold', () => this.dismissTables());
    this.tablesDim.addEventListener('click', (e) => {
      if (e.target === this.tablesDim) this.dismissTables();
    });
    this.tablesDim.hidden = true;

    // ---- Result dialog
    this.resultDim = v2tEl('div', 'v2t-dim', this.rootEl);
    const dlg = v2tEl('div', 'v2t-dlg', this.resultDim);
    dlg.setAttribute('role', 'dialog');
    this.resultTitle = v2tEl('div', 'v2t-h', dlg);
    this.resultBody = v2tEl('div', 'v2t-dlg-b', dlg);
    const buttons = v2tEl('div', 'v2t-df', dlg);
    v2tButton(buttons, 'Keep watching', 'ghost', () => (this.resultDim.hidden = true));
    v2tButton(buttons, 'Back to lobby', 'gold', () => this.leave());
    this.resultDim.hidden = true;

    // A tap outside the dropdown closes it.
    this.onDocClick = (e: Event) => {
      if (!this.infoOpen) return;
      const t = e.target as Node;
      if (this.info.contains(t) || this.titleBtn.contains(t)) return;
      this.infoOpen = false;
      this.refresh();
    };
    document.addEventListener('pointerdown', this.onDocClick, true);

    this.rootEl.hidden = true;
    this.timer = window.setInterval(() => this.refresh(), 250);
    this.unsubscribe = state.onChanged(() => this.refresh());
    this.refresh();
  }

  private readonly onDocClick: (e: Event) => void;

  dispose(): void {
    window.clearInterval(this.timer);
    this.unsubscribe();
    document.removeEventListener('pointerdown', this.onDocClick, true);
    this.rootEl.remove();
  }

  /** The root element (tests / debugging). */
  get element(): HTMLElement {
    return this.rootEl;
  }

  refresh(): void {
    const active = this.state.active && this.state.session !== null;
    this.rootEl.hidden = !active;
    if (!active) {
      this.shownResult = null;
      this.infoOpen = false;
      this.tablesOpenByChoice = false;
      this.tablesDismissed = false;
      return;
    }

    const status = this.state.status;
    const view = this.state.view;
    this.renderTitle(status, view);

    const offTable = !view || view.tableId < 0;
    const showTables = (offTable && !this.tablesDismissed) || this.tablesOpenByChoice;
    this.tablesDim.hidden = !showTables;
    if (showTables) this.renderTables(status, view);

    const result = this.state.result;
    if (result && result !== this.shownResult) {
      this.shownResult = result;
      this.showResult(result);
    }
  }

  private renderTitle(status: TournamentStatusEvent | null, view: TournamentViewEvent | null): void {
    const chev = this.titleBtn.querySelector('svg');
    const want = ICO[this.infoOpen ? 'chevup' : 'chev'] ?? '';
    if (chev && chev.innerHTML !== want) chev.innerHTML = want;
    this.titleBtn.setAttribute('aria-expanded', String(this.infoOpen));
    this.info.hidden = !this.infoOpen;
    if (!status) {
      setText(this.titleName, 'Tournament');
      setText(this.titleSub, 'Connecting…');
      this.setInfo([]);
      return;
    }

    let line: TournamentTableLine | null = null;
    if (view && view.tableId >= 0) for (const t of status.tables) if (t.tableId === view.tableId) line = t;

    const where = line ? (line.isFinal ? 'Final table' : `Round ${line.round} · Table ${line.tableId + 1}`)
      : status.phase === TournamentPhase.BeforeStart ? 'Starting soon'
        : status.myState === TournamentPlayerState.Eliminated ? "You're out"
          : status.myState === TournamentPlayerState.Waiting ? "You're through — waiting"
            : '';
    const watching = view && view.reason === TournamentViewReason.Watching ? 'watching' : '';
    setText(this.titleName, status.name);
    const sub = [where, watching].filter((x) => x).join(' · ');
    const subSig = `${sub}|${line?.isSpedUp ? 1 : 0}`;
    if (this.titleSub.dataset.sig !== subSig) {
      this.titleSub.dataset.sig = subSig;
      this.titleSub.replaceChildren(document.createTextNode(sub));
      if (line?.isSpedUp) {
        if (sub) this.titleSub.append(document.createTextNode(' · '));
        v2tEl('span', 'v2t-fast', this.titleSub, 'FAST LEVELS');
      }
    }

    const rows: [string, string][] = [];
    if (status.phase === TournamentPhase.BeforeStart) rows.push(['Starts in', clock(status.startsInSeconds)]);
    else if (status.phase === TournamentPhase.Cancelled) rows.push(['Status', 'Called off · entries refunded']);
    else if (status.phase === TournamentPhase.Finished) rows.push(['Status', 'Finished']);
    else if (line && !line.isDealing) rows.push(['First hand', `in ${line.dealInSeconds}s`]);
    else if (line) {
      rows.push(['Level', `${line.level} · blinds ${N0(line.smallBlind)} / ${N0(line.bigBlind)}`]);
      rows.push(['Next level', `${clock(line.secondsToNextLevel)}${line.isSpedUp ? ' · fast' : ''}`]);
    }
    rows.push(status.phase === TournamentPhase.BeforeStart ? ['Players', `${status.entrants}`] : ['Players left', `${status.playersRemaining} / ${status.entrants}`]);
    if (status.firstPrize > 0 || status.secondPrize > 0) rows.push(['Payout', `1st ${N0(status.firstPrize)} · 2nd ${N0(status.secondPrize)}`]);
    this.setInfo(rows);
  }

  private setInfo(rows: [string, string][]): void {
    const sig = rows.map((r) => r.join('=')).join('|');
    if (sig === this.infoSignature) return;
    this.infoSignature = sig;
    this.infoRows.replaceChildren(...rows.map(([k, v]) => {
      const r = v2tEl('div', 'v2t-kv');
      v2tEl('span', '', r, k);
      v2tEl('b', '', r, v);
      return r;
    }));
  }

  private renderTables(status: TournamentStatusEvent | null, view: TournamentViewEvent | null): void {
    setText(this.tablesTitle, !status ? 'Tournament'
      : status.phase === TournamentPhase.BeforeStart ? 'Starting soon'
        : status.phase === TournamentPhase.Finished ? 'Tournament over'
          : status.myState === TournamentPlayerState.Eliminated ? "You're out — watch the rest"
            : status.myState === TournamentPlayerState.Waiting ? "You're through to the next round!"
              : status.myState === TournamentPlayerState.Spectator ? 'Watching'
                : 'Tables');

    const open = status?.tables.filter((t) => !t.isClosed) ?? [];
    setText(this.tablesBody, status?.phase === TournamentPhase.BeforeStart
      ? "Tables are drawn at the start time. Stay here — you'll be seated automatically."
      : status?.myState === TournamentPlayerState.Waiting
        ? "Your next table opens when another table finishes. You'll be moved there with a 60-second countdown."
        : open.length === 0 ? 'No tables are playing.'
          : status?.myState === TournamentPlayerState.Seated ? 'Tables in this round.' : 'Pick a table to watch.');

    const seated = !!status && status.myState === TournamentPlayerState.Seated;
    const signature = `${seated ? 1 : 0}|` + open.map((t) => `${t.tableId}:${t.playersLeft}:${view && view.tableId === t.tableId ? 1 : 0}`).join(',');
    if (signature === this.tablesSignature) return;
    this.tablesSignature = signature;

    this.tablesList.replaceChildren();
    for (const t of open) {
      const row = v2tEl('div', 'v2t-card', this.tablesList);
      const name = t.isFinal ? 'Final table' : `Round ${t.round} · Table ${t.tableId + 1}`;
      v2tEl('span', '', row, `${name} · ${t.playersLeft} left${t.isSpedUp ? ' · fast' : ''}`);
      const current = !!view && view.tableId === t.tableId;
      if (seated) {
        if (current) v2tEl('span', 'v2t-pill gold', row, 'Your table');
      } else {
        const id = t.tableId;
        v2tButton(row, current ? 'Watching' : 'Watch', current ? 'ghost' : 'gold', () => {
          this.state.requestWatch(id);
          this.tablesOpenByChoice = false;
        }, 'sm');
      }
    }
  }

  private showResult(result: TournamentResultEvent): void {
    const prize = result.yourPrize > 0 ? `\nYou won ${N0(result.yourPrize)} chips.` : '';
    const xp = result.xpEarned > 0 ? `\n+${result.xpEarned} XP` : '';
    if (result.finished && result.youWon) {
      setText(this.resultTitle, 'Champion!');
      setText(this.resultBody, `You won the tournament.${prize}${xp}`);
    } else if (result.finished) {
      setText(this.resultTitle, result.yourPlace > 0 ? `You finished ${ordinal(result.yourPlace)} of ${result.entrants}` : 'Tournament over');
      const winner = result.championName ? `\nWinner: ${result.championName}` : '';
      setText(this.resultBody, `${winner}${prize}${xp}`.replace(/^\n+/, ''));
    } else {
      setText(this.resultTitle, "You're out");
      setText(this.resultBody, `Knocked out in round ${result.yourRound}.${xp}\nStay and watch, or head back to the lobby.`);
    }
    this.resultDim.hidden = false;
  }

  private dismissTables(): void {
    this.tablesOpenByChoice = false;
    this.tablesDismissed = true;
    this.tablesDim.hidden = true;
  }
}

function setText(e: HTMLElement, t: string): void {
  if (e.textContent !== t) e.textContent = t;
}
