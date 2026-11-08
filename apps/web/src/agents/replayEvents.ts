/**
 * An AgentHandReplay turned back into the engine's event stream, so the real table (TableEventPresenter → TableView:
 * spline deal, chips, showdown reveal, pot to the winner) can replay an Agent's hand. Pure, no DOM.
 *
 * Seats: the Agent sits at the view's seat 0 (the local player's seat, bottom of the table) and the others follow it
 * clockwise in their table order, spread over the view's seats. Hidden hole cards (everyone but the Agent, until shown at
 * showdown) are dealt face down as placeholders: the replay never had them (privacy), so the view can't leak them.
 */
import { ActionType } from '@nomad/engine/actions/actions';
import { Card } from '@nomad/engine/cards/card';
import type { EngineEvent, SeatSnapshot, ShowdownEntry } from '@nomad/engine/events/pokerEvent';
import type { HandValue } from '@nomad/engine/evaluation/handValue';
import { BettingRound } from '@nomad/engine/state/state';
import { ReplayStep, type AgentHandReplay } from '@nomad/engine/agents';

/** Which pause follows an event (the controller's TableSettings delays). */
export type ReplayPause = 'none' | 'deal' | 'settle' | 'turn' | 'action' | 'showdown';

export interface ReplayItem {
  /** The replay step this came from (-1: synthesised, e.g. the hand start and the deal). */
  step: number;
  event: EngineEvent;
  pause: ReplayPause;
}

export interface ReplayEvents {
  /** replay seat → view seat */
  seatMap: Map<number, number>;
  items: ReplayItem[];
}

const parse = (c: string | null | undefined): Card | null => {
  try {
    return c ? Card.parse(c) : null;
  } catch {
    return null;
  }
};

const ROUND_BY_NAME: Record<string, BettingRound> = {
  Preflop: BettingRound.Preflop, Flop: BettingRound.Flop, Turn: BettingRound.Turn, River: BettingRound.River,
};

/** Agent first, then clockwise by seat index; spread evenly over `viewSeats`. */
export function mapReplaySeats(r: AgentHandReplay, viewSeats: number): Map<number, number> {
  const seats = [...r.seats].sort((a, b) => a.seat - b.seat).slice(0, viewSeats);
  let me = seats.findIndex((s) => s.isAgent);
  if (me < 0) me = 0;
  const n = Math.max(1, seats.length);
  const map = new Map<number, number>();
  for (let k = 0; k < seats.length; k++) map.set(seats[(me + k) % n]!.seat, Math.round((k * viewSeats) / n) % viewSeats);
  return map;
}

export function replayToEvents(r: AgentHandReplay, viewSeats: number): ReplayEvents {
  const seatMap = mapReplaySeats(r, viewSeats);
  const at = (seat: number | null | undefined): number => (seat == null ? -1 : seatMap.get(seat) ?? -1);
  const items: ReplayItem[] = [];
  const push = (step: number, event: EngineEvent, pause: ReplayPause) => items.push({ step, event, pause });

  const blinds = r.steps.filter((s) => s.type === ReplayStep.Blind);
  const sbStep = blinds.find((s) => s.action === 'small_blind');
  const bbStep = blinds.find((s) => s.action === 'big_blind');
  const snapshots: SeatSnapshot[] = Array.from({ length: viewSeats }, () => ({
    name: null, stack: 0, isOccupied: false, isBusted: false, isBot: false, isAgent: false, isPendingNextHand: false, isLeaving: false, avatar: 0,
  }));
  for (const s of r.seats) {
    const v = at(s.seat);
    if (v < 0) continue;
    snapshots[v] = {
      name: r.nameOf(s.seat), stack: s.startStack, isOccupied: true, isBusted: false, isBot: s.isBot, isAgent: s.isAgent || s.isOtherAgent,
      isPendingNextHand: false, isLeaving: false, avatar: 0,
    };
  }
  push(-1, {
    type: 'HandStarted', handNumber: r.handNumber, buttonSeat: at(r.buttonSeat), smallBlindSeat: at(sbStep?.seat), bigBlindSeat: at(bbStep?.seat),
    seats: snapshots,
  }, 'none');

  // The deal: the Agent's real cards, face-down placeholders for everyone else (they were never recorded).
  let dealt = false;
  const deal = () => {
    if (dealt) return;
    dealt = true;
    let placeholder = 0;
    const order = [...seatMap.entries()].sort((a, b) => a[1] - b[1]);
    for (const [seat, v] of order) {
      const rs = r.seat(seat);
      const own = rs?.isAgent ? (rs.cards ?? r.agentCards) : null;
      const c0 = parse(own?.[0]) ?? Card.fromIndex(placeholder++ % 52);
      const c1 = parse(own?.[1]) ?? Card.fromIndex(placeholder++ % 52);
      push(-1, { type: 'HoleCardsDealt', seat: v, card0: c0, card1: c1 }, 'deal');
    }
    push(-1, { type: 'BettingRoundChanged', round: BettingRound.Preflop }, 'settle');
  };

  let board: Card[] = [];
  for (let i = 0; i < r.steps.length; i++) {
    const st = r.steps[i]!;
    const next = r.steps[i + 1];
    switch (st.type) {
      case ReplayStep.Street: {
        const round = ROUND_BY_NAME[st.streetName ?? ''];
        if (round == null || round === BettingRound.Preflop) break;
        deal();
        push(i, { type: 'BettingRoundChanged', round }, 'none');
        if (st.board) {
          const full = st.board.map(parse).filter((c): c is Card => c != null);
          const newCards = full.slice(board.length);
          board = full;
          push(i, { type: 'CommunityDealt', round, newCards, board: [...full] }, 'settle');
        }
        break;
      }
      case ReplayStep.Blind:
        push(i, {
          type: 'BlindPosted', seat: at(st.seat), amount: st.amount ?? 0, isSmallBlind: st.action === 'small_blind',
          stackAfter: st.stack ?? 0, potAfter: st.pot ?? 0,
        }, 'deal');
        if (next?.type !== ReplayStep.Blind) deal();
        break;
      case ReplayStep.Act: {
        deal();
        const action = ActionType[(st.action ?? 'Fold') as keyof typeof ActionType] ?? ActionType.Fold;
        push(i, { type: 'PlayerActed', seat: at(st.seat), action, amount: st.amount ?? 0, stackAfter: st.stack ?? 0, potAfter: st.pot ?? 0 }, 'action');
        break;
      }
      case ReplayStep.Show: {
        deal();
        // Consecutive show steps are one Showdown event at the table.
        const entries: ShowdownEntry[] = [];
        let j = i;
        for (; j < r.steps.length && r.steps[j]!.type === ReplayStep.Show; j++) {
          const s = r.steps[j]!;
          const c0 = parse(s.cards?.[0]);
          const c1 = parse(s.cards?.[1]);
          if (c0 && c1 && at(s.seat) >= 0)
            entries.push({ seat: at(s.seat), card0: c0, card1: c1, value: null as unknown as HandValue, description: s.description ?? '' });
        }
        push(i, { type: 'Showdown', entries, board: [...board] }, 'showdown');
        i = j - 1;
        break;
      }
      case ReplayStep.Award:
        deal();
        push(i, {
          type: 'PotAwarded', seat: at(st.seat), seatName: st.seat != null ? r.nameOf(st.seat) : null, amount: st.amount ?? 0,
          stackAfter: st.stack ?? 0, potAfter: st.pot ?? 0, reason: st.description ?? 'Pot',
        }, 'showdown');
        break;
    }
  }
  deal();
  push(-1, { type: 'HandEnded', handNumber: r.handNumber }, 'none');
  return { seatMap, items };
}
