/**
 * Watch an Agent hand at the real 3D table: a TableSession that feeds the replay's events (replayEvents.ts) through the
 * same TableEventPresenter the offline game uses, at the controller's pacing, with a caption and Restart / Pause /
 * Speed / Back controls. Unity's viewer is the 2D Nomad dialog (NomadUiHost.Replay.cs, ported in ui/replayDialog.ts);
 * this is the web port's extra "Watch at the table" view of the same data.
 */
import { addTableChrome, type TableSessionFactory, type TableSessionHost } from '../table/tableScreen';
import { tickerWait } from '../table/tableView';
import { TableEventPresenter } from '@nomad/engine/orchestration/tableEventPresenter';
import { DEFAULT_TABLE_SETTINGS } from '@nomad/engine/orchestration/tableSettings';
import { AgentHandReplayText, type AgentHandReplay } from '@nomad/engine/agents';
import { replayToEvents, type ReplayPause } from './replayEvents';

/** The DOM layer table chrome gets, per table visit (the replay session mounts its controls there). */
const layers = new WeakMap<TableSessionHost, HTMLElement>();
let chromeInstalled = false;

export function installReplayChrome(): void {
  if (chromeInstalled) return;
  chromeInstalled = true;
  addTableChrome((host, layer) => {
    layers.set(host, layer);
    return () => layers.delete(host);
  });
}

export interface ReplaySessionOptions {
  /** Where Back goes (default: the screen the caller names; else the router's default). */
  returnTo?: string;
  /** Called when the player leaves the replay (e.g. to reopen the hands list). */
  onBack?: () => void;
  /** With several hands (a whole session), " · hand k of n" follows it. */
  title?: string;
  /** The leave button's label (default "Back to hands"). */
  backLabel?: string;
  /** What captions call the face-up seat instead of "your Agent" (e.g. "you back it"); '' drops the note. */
  focusLabel?: string;
}

const PAUSES: Record<ReplayPause, number> = {
  none: 0,
  deal: DEFAULT_TABLE_SETTINGS.dealDelay,
  settle: DEFAULT_TABLE_SETTINGS.dealSettleDelay,
  turn: 0.55,
  action: DEFAULT_TABLE_SETTINGS.actionDelay + 0.5,
  showdown: DEFAULT_TABLE_SETTINGS.showdownDelay,
};

/** One hand, or a whole session's hands played one after another. */
export function replaySession(replays: AgentHandReplay | readonly AgentHandReplay[], opts: ReplaySessionOptions = {}): TableSessionFactory {
  const list: readonly AgentHandReplay[] = Array.isArray(replays) ? replays : [replays as AgentHandReplay];
  return (host) => {
    let abort = new AbortController();
    let speed = 1;
    let paused = false;
    let resume: (() => void) | null = null;
    let bar: HTMLElement | null = null;
    let caption: HTMLElement | null = null;
    let playBtn: HTMLButtonElement | null = null;
    let titleEl: HTMLElement | null = null;
    const titleOf = (k: number) =>
      list.length > 1 ? `${opts.title ?? 'Session'} · hand ${k + 1} of ${list.length}` : (opts.title ?? `Hand #${list[0]!.handNumber} · replay`);

    const wait = async (seconds: number, signal: AbortSignal) => {
      if (seconds > 0) await tickerWait(seconds / speed, signal);
      while (paused && !signal.aborted) await new Promise<void>((r) => (resume = r));
    };

    const setCaption = (text: string) => {
      if (opts.focusLabel !== undefined) text = text.replace(' (your Agent)', opts.focusLabel ? ` (${opts.focusLabel})` : '');
      if (caption) caption.textContent = text;
    };

    async function play(signal: AbortSignal): Promise<void> {
      for (let k = 0; k < list.length; k++) {
        if (signal.aborted) return;
        if (k > 0) {
          await wait(1.2, signal);
          if (signal.aborted) return;
          host.view.endHand();
        }
        if (titleEl) titleEl.textContent = titleOf(k);
        await playHand(list[k]!, signal);
      }
      if (!signal.aborted) {
        if (list.length > 1) setCaption(`End of the session: ${list.length} hands.`);
        if (playBtn) playBtn.textContent = 'Replay';
      }
    }

    async function playHand(replay: AgentHandReplay, signal: AbortSignal): Promise<void> {
      const { items, seatMap } = replayToEvents(replay, host.view.seatCount);
      const presenter = new TableEventPresenter(host.view, seatMap.get(replay.agentSeat) ?? 0, host.audio);
      setCaption('Cards are dealt.');
      for (const item of items) {
        if (signal.aborted) return;
        const e = item.event;
        if (item.step >= 0) setCaption(AgentHandReplayText.describe(replay, replay.steps[item.step]!));
        switch (e.type) {
          case 'HandStarted': presenter.onHandStarted(e); break;
          case 'BlindPosted': presenter.onBlindPosted(e); break;
          case 'HoleCardsDealt': presenter.onHoleCardsDealt(e); break;
          case 'BettingRoundChanged': presenter.onRoundChanged(e); break;
          case 'CommunityDealt': presenter.onCommunityDealt(e); break;
          case 'PlayerActed':
            host.view.setTurn(e.seat, 0);
            await wait(PAUSES.turn, signal);
            if (signal.aborted) return;
            presenter.onPlayerActed(e);
            host.view.clearTurn(e.seat);
            break;
          case 'Showdown': presenter.onShowdown(e); break;
          case 'PotAwarded': presenter.onPotAwarded(e); break;
          case 'HandEnded': presenter.onHandEnded(e); break;
          default: break;
        }
        await wait(PAUSES[item.pause], signal);
      }
      if (!signal.aborted) setCaption(AgentHandReplayText.summary(replay));
    }

    const restart = () => {
      abort.abort();
      resume?.();
      abort = new AbortController();
      paused = false;
      if (playBtn) playBtn.textContent = 'Pause';
      host.view.endHand();
      const signal = abort.signal;
      void tickerWait(0.8, signal).then(() => {
        if (!signal.aborted) void play(signal);
      });
    };

    function mountControls(): void {
      const layer = layers.get(host);
      if (!layer) return;
      bar = document.createElement('div');
      bar.className = 'agent-replay-bar';
      const title = (titleEl = document.createElement('div'));
      title.className = 'agent-replay-title';
      title.textContent = titleOf(0);
      caption = document.createElement('div');
      caption.className = 'agent-replay-caption';
      const buttons = document.createElement('div');
      buttons.className = 'agent-replay-buttons';
      const button = (label: string, onClick: (b: HTMLButtonElement) => void, primary = false) => {
        const b = document.createElement('button');
        b.className = 'nomad-btn v2-b ' + (primary ? 'gold primary' : 'blue');
        b.textContent = label;
        b.addEventListener('click', () => onClick(b));
        buttons.append(b);
        return b;
      };
      button('Restart', restart);
      playBtn = button('Pause', (b) => {
        if (b.textContent === 'Replay') return restart();
        paused = !paused;
        b.textContent = paused ? 'Play' : 'Pause';
        if (!paused) resume?.();
      }, true);
      button('SPEED 1X', (b) => {
        speed = speed >= 4 ? 1 : speed * 2;
        b.textContent = `SPEED ${speed}X`;
      });
      button(opts.backLabel ?? 'Back to hands', () => {
        opts.onBack?.();
        host.leave(opts.returnTo);
      });
      bar.append(title, caption, buttons);
      layer.append(bar);
    }

    return {
      start: () => {
        mountControls();
        void play(abort.signal);
      },
      stop: () => {
        abort.abort();
        resume?.();
        bar?.remove();
        bar = null;
      },
    };
  };
}
