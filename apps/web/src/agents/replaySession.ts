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
  title?: string;
}

const PAUSES: Record<ReplayPause, number> = {
  none: 0,
  deal: DEFAULT_TABLE_SETTINGS.dealDelay,
  settle: DEFAULT_TABLE_SETTINGS.dealSettleDelay,
  turn: 0.55,
  action: DEFAULT_TABLE_SETTINGS.actionDelay + 0.5,
  showdown: DEFAULT_TABLE_SETTINGS.showdownDelay,
};

export function replaySession(replay: AgentHandReplay, opts: ReplaySessionOptions = {}): TableSessionFactory {
  return (host) => {
    let abort = new AbortController();
    let speed = 1;
    let paused = false;
    let resume: (() => void) | null = null;
    let bar: HTMLElement | null = null;
    let caption: HTMLElement | null = null;
    let playBtn: HTMLButtonElement | null = null;
    const { items, seatMap } = replayToEvents(replay, host.view.seatCount);
    const agentViewSeat = seatMap.get(replay.agentSeat) ?? 0;

    const wait = async (seconds: number, signal: AbortSignal) => {
      if (seconds > 0) await tickerWait(seconds / speed, signal);
      while (paused && !signal.aborted) await new Promise<void>((r) => (resume = r));
    };

    const setCaption = (text: string) => {
      if (caption) caption.textContent = text;
    };

    async function play(signal: AbortSignal): Promise<void> {
      const presenter = new TableEventPresenter(host.view, agentViewSeat, host.audio);
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
      if (!signal.aborted) {
        setCaption(AgentHandReplayText.summary(replay));
        if (playBtn) playBtn.textContent = 'Replay';
      }
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
      const title = document.createElement('div');
      title.className = 'agent-replay-title';
      title.textContent = opts.title ?? `Hand #${replay.handNumber} · replay`;
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
      button('Back to hands', () => {
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
