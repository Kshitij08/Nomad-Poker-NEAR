import type { LegalActions, PlayerAction } from '../actions/actions';
import type { BotContext, IPokerBot } from '../bots/botContext';
import type { BettingPanelPort } from './tableView';

/** Everything a provider needs to decide one action. Port of IActionProvider.cs ActionRequest. */
export interface ActionRequest {
  seat: number;
  legal: LegalActions;
  /** already filtered to this seat's own information */
  context: BotContext;
}

/**
 * The swappable source of a seat's action (human panel, bot, later network). Port of IActionProvider.cs: the Unity
 * coroutine becomes an async call; `signal` aborts it when the turn timer expires (Unity's StopCoroutine).
 * Call `submit` at most once; the controller ignores everything after the first submission.
 */
export interface IActionProvider {
  requestAction(request: ActionRequest, submit: (action: PlayerAction) => void, signal: AbortSignal): void | Promise<void>;
}

/** Seconds-based wait the orchestration uses for every pause; injectable so tests can run on virtual time. */
export type WaitFn = (seconds: number, signal?: AbortSignal) => Promise<void>;

export const realWait: WaitFn = (seconds, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const id = setTimeout(done, Math.max(0, seconds) * 1000);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(id);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** Maps each seat to its provider. Port of ActionRouter.cs. */
export class ActionRouter {
  private readonly providers = new Map<number, IActionProvider>();
  set(seat: number, provider: IActionProvider): void { this.providers.set(seat, provider); }
  remove(seat: number): void { this.providers.delete(seat); }
  get(seat: number): IActionProvider | null { return this.providers.get(seat) ?? null; }
}

/**
 * Drives a bot: waits a "thinking" beat uniformly in [minThink, maxThink] seconds (Unity Random.Range), then submits
 * the bot's choice. Port of BotActionProvider.cs (defaults 0.6 / 1.4).
 */
export class BotActionProvider implements IActionProvider {
  private readonly maxThinkSeconds: number;

  constructor(
    private readonly bot: IPokerBot,
    private readonly minThinkSeconds = 0.6,
    maxThinkSeconds = 1.4,
    private readonly wait: WaitFn = realWait,
    private readonly random: () => number = Math.random,
  ) {
    this.maxThinkSeconds = Math.max(minThinkSeconds, maxThinkSeconds);
  }

  async requestAction(request: ActionRequest, submit: (a: PlayerAction) => void, signal: AbortSignal): Promise<void> {
    const w = this.minThinkSeconds + this.random() * (this.maxThinkSeconds - this.minThinkSeconds);
    if (w > 0) await this.wait(w, signal);
    if (signal.aborted) return;
    submit(this.bot.decide(request.context));
  }
}

/** Shows the betting panel and waits for the local player. Port of HumanActionProvider.cs. */
export class HumanActionProvider implements IActionProvider {
  constructor(private readonly panel: BettingPanelPort) {}

  requestAction(request: ActionRequest, submit: (a: PlayerAction) => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.panel.show(request.legal, request.context.myCurrentBet, (a) => {
      if (signal.aborted) return;
      this.panel.hide();
      submit(a);
    });
  }
}
