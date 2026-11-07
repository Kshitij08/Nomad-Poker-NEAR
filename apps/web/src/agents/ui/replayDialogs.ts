/**
 * Port of Assets/Scripts/Net/NomadUi/NomadUiHost.Replay.cs: tapping a Session History row lists that session's hands
 * (the Agent's cards, the board, the result, 20 at a time, "Load more"), and tapping a hand replays it on a small table:
 * seats, stacks, bets, the board and the pot, step by step, with Restart / Prev / Play-Pause / Next / Speed / End, beside
 * a per-round summary and the one-line summary of the Agent's hand. Hands recorded before replays existed show their old
 * fields. Same reference layout (panel sizes and positions) as the C#; the web port adds "Watch at the table".
 *
 * The replay is privacy-filtered by the table that recorded it: an opponent's cards are in it only if they were shown at
 * showdown, so "?" is all this can ever draw for the rest.
 */
import {
  AgentHandReplay, AgentHandReplayText, ReplaySeatFrame, ReplayStep, type AgentDeploymentSummary, type AgentHandRecord, type ReplaySeat,
} from '../../core/agents';
import {
  COLORS, button, cardMark, cardsRich, richCards, duration, el, escapeHtml, line, place, refPanel, setChip, shortText, type RefPanel,
} from './dom';

export const HANDS_PAGE = 20;

/** What the dialogs need from the Agents service. */
export interface ReplayDialogHost {
  /** The layer dialogs open on (above the menu and the table). */
  readonly layer: HTMLElement;
  fetchHands(deploymentId: string, limit: number, offset: number): Promise<{ Hands: AgentHandRecord[] | null; Total: number } | null>;
  /** Opens the hand at the 3D table (web port extra). */
  watchAtTable(hand: AgentHandRecord, replay: AgentHandReplay, sessionLabel: string): void;
  message(title: string, body: string): void;
}

/** One open dialog at a time, like NomadDialogs' modal: opening another closes the previous one. */
export class ReplayDialogs {
  private current: { dispose(): void } | null = null;
  private session: AgentDeploymentSummary | null = null;
  private sessionLabel = '';
  private readonly hands: AgentHandRecord[] = [];
  private total = 0;
  private loading = false;

  constructor(private readonly host: ReplayDialogHost) {}

  get isOpen(): boolean {
    return this.current != null;
  }

  close(): void {
    this.current?.dispose();
    this.current = null;
  }

  private open(title: string, w: number, h: number): RefPanel {
    this.close();
    const p = refPanel(this.host.layer, title, w, h, () => this.close());
    this.current = p;
    return p;
  }

  // ---- a session's hands

  /** A Session History row was tapped. `label` is how the row numbers it ("#12"). */
  async openSession(s: AgentDeploymentSummary, label: string): Promise<void> {
    if (!s.DeploymentId) return;
    if (!this.session || this.session.DeploymentId !== s.DeploymentId) {
      this.session = s;
      this.hands.length = 0;
      this.total = 0;
    }
    this.sessionLabel = label;
    if (this.hands.length > 0) return this.showSessionHands();
    const busy = this.open('Session ' + label, 800, 300);
    line(busy, 'Loading its hands…', 30, 0, -10, 700, 60, COLORS.soft, 'center');
    const added = await this.loadMore(false);
    if (added) this.showSessionHands();
  }

  /** The next page; null on failure (`quiet`: the caller relabels its button instead of a message). */
  private async loadMore(quiet: boolean): Promise<AgentHandRecord[] | null> {
    if (this.loading || !this.session) return null;
    const id = this.session.DeploymentId!;
    this.loading = true;
    let page: { Hands: AgentHandRecord[] | null; Total: number } | null = null;
    try {
      page = await this.host.fetchHands(id, HANDS_PAGE, this.hands.length);
    } catch (e) {
      console.warn('[agents] hands: ' + String(e));
    } finally {
      this.loading = false;
    }
    if (!this.session || this.session.DeploymentId !== id) return null; // another session was opened meanwhile
    if (!page) {
      if (!quiet) {
        this.close();
        this.host.message('Session hands', "Couldn't load this session's hands. Check your connection and try again.");
      }
      return null;
    }
    const added: AgentHandRecord[] = [];
    for (const h of page.Hands ?? [])
      if (h && !this.hands.some((x) => x.HandNumber === h.HandNumber)) {
        this.hands.push(h);
        added.push(h);
      }
    this.total = Math.max(page.Total, this.hands.length);
    if (added.length === 0) this.total = this.hands.length; // nothing more to page through
    return added;
  }

  showSessionHands(): void {
    const s = this.session;
    if (!s) return;
    const p = this.open(`Session ${this.sessionLabel} · hands`, 1700, 940);
    const net = AgentHandReplayText.signed(s.NetPnl);
    line(p, `${AgentHandReplayText.coins(s.HandsPlayed)} hands · ${duration(s.RuntimeSeconds)} · ${AgentHandReplayText.coins(s.StartingBankroll)} to ${AgentHandReplayText.coins(s.EndingStack)} Coins · ` +
      `<span style="color:${s.NetPnl >= 0 ? '#66E67F' : '#F27373'}">${net}</span>  <small>· tap a hand to watch it</small>`, 26, 0, 335, 1560, 44, COLORS.soft, 'center');

    // Column titles over the list (x positions match the rows).
    const titles = ['Hand', "Agent's cards", 'Board', 'Showdown', 'Result'];
    const xs = [-700, -480, -90, 255, 445];
    const ws = [150, 260, 420, 170, 190];
    titles.forEach((t, i) => line(p, t, 22, xs[i]!, 282, ws[i]!, 34, COLORS.soft, i === 4 ? 'right' : 'left'));

    const list = el('div', 'agent-scroll');
    place(list, p.w, p.h, 0, 258 - 570 / 2, 1600, 570);
    p.body.append(list);
    if (this.hands.length === 0) {
      const none = el('div', 'agent-line', 'No hands were recorded for this session.');
      Object.assign(none.style, { textAlign: 'center', color: COLORS.soft, fontSize: '26px', lineHeight: '80px' });
      list.append(none);
      return;
    }
    for (const h of this.hands) list.append(this.handRow(h));
    this.addLoadMore(list);
  }

  private handRow(h: AgentHandRecord): HTMLElement {
    const W = 1600;
    const H = 84;
    const row = el('div', 'agent-row clickable');
    row.style.height = `${H}px`;
    const box = { body: row, w: W, h: H };
    const replay = h.HasReplay || !!h.ReplayJson;
    line(box, `#${h.HandNumber}`, 28, -700, 0, 150, 50);
    line(box, !h.HoleCards?.trim() ? '<span style="color:#7F8AB0">-</span>' : cardsRich(h.HoleCards), 30, -480, 0, 260, 50);
    line(box, !h.BoardCards?.trim() ? '<span style="color:#7F8AB0">no flop</span>' : cardsRich(h.BoardCards), 28, -90, 0, 420, 50);
    line(box, h.Showdown ? 'Showdown' : '-', 24, 255, 0, 170, 50, h.Showdown ? COLORS.white : COLORS.soft);
    line(box, AgentHandReplayText.signed(h.NetPnl), 30, 445, 0, 190, 50, h.NetPnl > 0 ? COLORS.good : h.NetPnl < 0 ? COLORS.bad : COLORS.soft, 'right');
    const b = button(replay ? 'Watch' : 'Details', replay, () => this.openHand(h));
    place(b, W, H, 670, 0, 220, 60);
    b.style.transform = 'scale(0.72)';
    row.append(b);
    row.addEventListener('click', () => this.openHand(h));
    return row;
  }

  /** "Load more" at the end of the list: the next page is appended in place (the scroll stays put). */
  private addLoadMore(list: HTMLElement): void {
    const left = this.total - this.hands.length;
    if (left <= 0) return;
    const wrap = el('div', 'agent-buttons');
    wrap.style.height = '96px';
    const b = button(`Load more (${AgentHandReplayText.coins(left)} left)`, false, async () => {
      if (this.loading) return;
      b.textContent = 'LOADING…';
      const added = await this.loadMore(true);
      if (!list.isConnected) return; // the list was closed meanwhile; the hands stay cached
      if (!added) {
        b.textContent = 'TRY AGAIN';
        return;
      }
      wrap.remove();
      for (const h of added) list.append(this.handRow(h));
      this.addLoadMore(list);
    });
    b.style.minWidth = '460px';
    wrap.append(b);
    list.append(wrap);
  }

  // ---- one hand

  openHand(h: AgentHandRecord): void {
    const replay = AgentHandReplay.fromJson(h.ReplayJson);
    if (!replay || replay.steps.length === 0) this.showHandWithoutReplay(h);
    else this.showReplay(h, replay);
  }

  /** Hands recorded before replays existed (or whose replay was too large to keep): the old fields. */
  private showHandWithoutReplay(h: AgentHandRecord): void {
    const p = this.open(`Hand #${h.HandNumber}`, 1400, 860);
    line(p, 'Replay not available for this hand.', 28, 0, 320, 1250, 44, COLORS.gold, 'center');
    const result = h.NetPnl > 0 ? `<span style="color:#66E67F">won ${AgentHandReplayText.signed(h.NetPnl)}</span>`
      : h.NetPnl < 0 ? `<span style="color:#F27373">lost ${AgentHandReplayText.coins(-h.NetPnl)}</span>` : 'broke even';
    line(p, `Agent's cards ${!h.HoleCards?.trim() ? '-' : cardsRich(h.HoleCards)}    ·    Board ${!h.BoardCards?.trim() ? 'no flop' : cardsRich(h.BoardCards)}`,
      32, 0, 255, 1250, 54, COLORS.white, 'center');
    line(p, `Your Agent ${result} · stack ${AgentHandReplayText.coins(h.StartingStack)} to ${AgentHandReplayText.coins(h.EndingStack)} · ${h.Showdown ? 'went to showdown' : 'no showdown'}`,
      26, 0, 195, 1250, 44, COLORS.soft, 'center');
    line(p, 'Actions (seat · action · amount in Coins)', 22, -600 + 350 - 25, 140, 700, 34, COLORS.soft);
    const list = el('div', 'agent-scroll');
    place(list, p.w, p.h, 0, 118 - 415 / 2, 1240, 415);
    p.body.append(list);
    let n = 0;
    try {
      const arr = h.PublicActionsJson?.trim() ? (JSON.parse(h.PublicActionsJson) as unknown[]) : [];
      for (const t of arr) {
        if (!t || typeof t !== 'object') continue;
        const a = t as { action?: string; amount?: number; seat?: number };
        const act = a.action ?? '';
        const amt = a.amount ?? 0;
        const label = act === 'small_blind' ? 'posts the small blind' : act === 'big_blind' ? 'posts the big blind' : act.toLowerCase();
        const row = el('div', 'agent-row');
        row.style.height = '52px';
        line({ body: row, w: 1240, h: 52 }, `Seat ${(a.seat ?? 0) + 1}  ${escapeHtml(label)}` + (amt > 0 && act !== 'Fold' && act !== 'Check' ? `  ${AgentHandReplayText.coins(amt)}` : ''),
          24, 0, 0, 1160, 44);
        list.append(row);
        n++;
      }
    } catch (e) {
      console.warn('[agents] old hand actions: ' + String(e));
    }
    if (n === 0) {
      const none = el('div', 'agent-line', 'No actions were recorded.');
      Object.assign(none.style, { textAlign: 'center', color: COLORS.soft, fontSize: '24px', lineHeight: '60px' });
      list.append(none);
    }
    const back = button('Back to hands', false, () => this.showSessionHands());
    place(back, p.w, p.h, -1400 / 2 + 190, -860 / 2 + 70, 300, 64);
    p.body.append(back);
  }

  // ---- the replay view

  private showReplay(h: AgentHandRecord, r: AgentHandReplay): void {
    const PanelW = 1840;
    const PanelH = 1030;
    const FX = -365;
    const FY = 95;
    const p = this.open(`Hand #${r.handNumber > 0 ? r.handNumber : h.HandNumber} · replay`, PanelW, PanelH);
    const v = new ReplayView(r, p);

    // --- the table (left)
    const felt = el('div', 'agent-seat');
    felt.style.background = 'rgba(13, 69, 51, 0.95)';
    felt.style.borderRadius = '200px';
    place(felt, PanelW, PanelH, FX, FY, 1040, 560);
    p.body.append(felt);
    line(p, `Blinds ${AgentHandReplayText.coins(r.smallBlind)} / ${AgentHandReplayText.coins(r.bigBlind)}`, 20, FX - 410, FY + 250, 220, 30, 'rgb(191, 230, 204)');
    v.street = line(p, '', 26, FX, FY + 118, 400, 36, 'rgb(204, 242, 217)', 'center');
    for (let i = 0; i < 5; i++) v.board.push(chip(p, FX + (i - 2) * 88, FY + 45, 76, 104, 40));
    v.pot = line(p, '', 30, FX, FY - 38, 400, 40, COLORS.gold, 'center');

    // Seats around the felt, clockwise from the Agent at the bottom.
    const seats = [...r.seats].sort((a, b) => a.seat - b.seat);
    let me = seats.findIndex((s) => s.isAgent);
    if (me < 0) me = 0;
    const n = Math.max(1, seats.length);
    const boxW = n > 6 ? 214 : 250;
    for (let k = 0; k < seats.length; k++) {
      const seat = seats[(me + k) % seats.length]!;
      const angle = ((-90 - (k * 360) / n) * Math.PI) / 180;
      const x = FX + Math.cos(angle) * 440;
      const y = FY + Math.sin(angle) * 225;
      const sv = seatBox(p, r, seat, x, y, boxW);
      // The bet sits on the felt side of the seat box: under the upper seats, over the lower ones.
      sv.bet = line(p, '', 22, x, y + (y > FY + 1 ? -74 : 74), 170, 30, COLORS.gold, 'center');
      v.seats.set(seat.seat, sv);
    }

    // Caption and step counter under the table, then the controls.
    v.caption = line(p, '', 28, FX, -225, 1040, 44, COLORS.white, 'center');
    v.counter = line(p, '', 20, FX, -258, 400, 28, COLORS.soft, 'center');
    const labels = ['Restart', 'Prev', 'Play', 'Next', '1x', 'End'];
    const actions = [
      () => { v.playing = false; v.goTo(0); },
      () => { v.playing = false; v.goTo(v.step - 1); },
      () => v.togglePlay(),
      () => { v.playing = false; v.goTo(v.step + 1); },
      () => { v.speed = v.speed >= 4 ? 1 : v.speed * 2; v.updateControls(); },
      () => { v.playing = false; v.goTo(r.steps.length); },
    ];
    labels.forEach((label, i) => {
      const b = button(label, i === 2, actions[i]!);
      place(b, PanelW, PanelH, FX + (i - 2.5) * 172, -318, 200, 64);
      b.style.transform = 'scale(0.8)';
      p.body.append(b);
      if (i === 2) v.playLabel = b;
      if (i === 4) v.speedLabel = b;
    });

    // --- the summaries (right)
    const card = el('div', 'agent-row');
    place(card, PanelW, PanelH, 545, 318, 700, 130);
    const sum = el('div', 'agent-line');
    sum.innerHTML = richCards(AgentHandReplayText.summary(r, cardMark));
    Object.assign(sum.style, { whiteSpace: 'normal', fontSize: '24px', padding: '10px 20px', lineHeight: '1.3' });
    card.append(sum);
    p.body.append(card);

    const list = el('div', 'agent-scroll');
    place(list, PanelW, PanelH, 195 + 350, 240 - 585 / 2, 700, 585);
    p.body.append(list);
    v.scroll = list;
    for (const round of AgentHandReplayText.rounds(r, cardMark)) {
      const lineH = 34;
      const rowH = 52 + round.steps.length * lineH;
      const row = el('div', 'agent-row');
      row.style.height = `${rowH}px`;
      const box = { body: row, w: 700, h: rowH };
      const top = rowH / 2;
      const title = line(box, richCards(round.title), 24, 0, top - 26, 660, 34, COLORS.gold);
      if (round.streetStep >= 0) v.lines.set(round.streetStep, [title, COLORS.gold]);
      round.steps.forEach((si, i) => {
        const st = r.steps[si]!;
        const mine = st.seat != null && st.seat === r.agentSeat;
        const col = mine ? COLORS.agentLine : COLORS.white;
        v.lines.set(si, [line(box, richCards(AgentHandReplayText.describe(r, st, cardMark)), 21, 10, top - 60 - i * lineH, 650, lineH - 2, col), col]);
      });
      list.append(row);
    }

    const back = button('Back to hands', false, () => this.showSessionHands());
    place(back, PanelW, PanelH, -PanelW / 2 + 190, -PanelH / 2 + 70, 300, 64);
    const watch = button('Watch at the table', true, () => {
      this.close();
      this.host.watchAtTable(h, r, this.sessionLabel);
    });
    place(watch, PanelW, PanelH, -PanelW / 2 + 560, -PanelH / 2 + 70, 380, 64);
    p.body.append(back, watch);

    v.goTo(0);
    v.playing = true; // opens playing from the deal
    v.updateControls();
    v.start();
    const dispose = p.dispose;
    p.dispose = () => {
      v.stop();
      dispose();
    };
  }
}

interface SeatView {
  box: HTMLElement;
  boxColor: [number, number, number, number];
  stack: HTMLElement;
  label: HTMLElement;
  bet: HTMLElement | null;
  card0: HTMLElement;
  card1: HTMLElement;
}

function chip(p: { body: HTMLElement; w: number; h: number }, x: number, y: number, w: number, h: number, fontSize: number): HTMLElement {
  const c = el('div', 'agent-chip');
  c.style.fontSize = `${fontSize}px`;
  place(c, p.w, p.h, x, y, w, h);
  p.body.append(c);
  return c;
}

function seatBox(p: RefPanel, r: AgentHandReplay, seat: ReplaySeat, x: number, y: number, width: number): SeatView {
  const box = el('div', 'agent-seat');
  place(box, p.w, p.h, x, y, width, 116);
  p.body.append(box);
  const inner = { body: box, w: width, h: 116 };
  const boxColor: [number, number, number, number] = seat.isAgent ? [77, 56, 10, 0.97] : [15, 23, 66, 0.97];
  const textW = width - 104;
  const textX = -width / 2 + 10 + textW / 2;
  const tag = seat.isAgent ? ' <small style="color:#FFD34D;font-size:70%">AGENT</small>'
    : seat.isOtherAgent ? ' <small style="color:#E8C46A;font-size:70%">agent</small>'
    : seat.isBot ? ' <small style="color:#A9B4D8;font-size:70%">bot</small>' : '';
  line(inner, escapeHtml(shortText(r.nameOf(seat.seat), 14)) + tag, 22, textX, 34, textW, 30);
  const stack = line(inner, '', 22, textX, 2, textW, 30, COLORS.soft);
  const label = line(inner, '', 20, textX, -32, textW, 30);
  const card0 = chip(inner, width / 2 - 72, 0, 42, 60, 24);
  const card1 = chip(inner, width / 2 - 26, 0, 42, 60, 24);
  return { box, boxColor, stack, label, bet: null, card0, card1 };
}

/** Seconds a step stays on screen at 1x: long enough to read the caption, longer for the reveals. */
function stepSeconds(st: ReplayStep | undefined): number {
  switch (st?.type) {
    case ReplayStep.Street: return 1.3;
    case ReplayStep.Blind: return 0.7;
    case ReplayStep.Show: return 1.6;
    case ReplayStep.Award: return 1.8;
    default: return 1.0;
  }
}

/** Everything one open replay draws into, and where playback is. */
class ReplayView {
  step = 0;
  playing = false;
  speed = 1;
  wait = 0.8;
  readonly seats = new Map<number, SeatView>();
  readonly board: HTMLElement[] = [];
  readonly lines = new Map<number, [HTMLElement, string]>();
  pot!: HTMLElement;
  street!: HTMLElement;
  caption!: HTMLElement;
  counter!: HTMLElement;
  playLabel: HTMLElement | null = null;
  speedLabel: HTMLElement | null = null;
  scroll: HTMLElement | null = null;
  private raf = 0;
  private last = 0;

  constructor(readonly replay: AgentHandReplay, readonly panel: RefPanel) {}

  start(): void {
    this.wait = 0.8;
    this.last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(0.25, (t - this.last) / 1000);
      this.last = t;
      if (this.playing) {
        this.wait -= dt * this.speed;
        if (this.wait <= 0) {
          this.goTo(this.step + 1);
          if (this.step >= this.replay.steps.length) {
            this.playing = false;
            this.updateControls();
          }
        }
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  togglePlay(): void {
    if (!this.playing && this.step >= this.replay.steps.length) this.goTo(0); // play again from the deal
    this.playing = !this.playing;
    this.wait = 0.35;
    this.updateControls();
  }

  updateControls(): void {
    if (this.playLabel) this.playLabel.textContent = this.playing ? 'PAUSE' : this.step >= this.replay.steps.length ? 'REPLAY' : 'PLAY';
    if (this.speedLabel) this.speedLabel.textContent = `SPEED ${this.speed}X`;
  }

  /** Draws the table after `step` steps. */
  goTo(step: number): void {
    const r = this.replay;
    this.step = Math.max(0, Math.min(step, r.steps.length));
    this.wait = this.step < r.steps.length ? stepSeconds(r.steps[this.step]) : 0;
    const f = AgentHandReplayText.frameAt(r, this.step, cardMark);

    this.street.textContent = f.street.toUpperCase();
    for (let i = 0; i < 5; i++) setChip(this.board[i]!, i < f.board.length ? f.board[i]! ?? '' : '');
    this.pot.textContent = f.pot > 0 ? `Pot ${AgentHandReplayText.coins(f.pot)}` : '';
    this.caption.innerHTML = this.step === 0 ? 'Cards are dealt. Press Play, or step through with Next.' : richCards(f.caption);
    this.counter.textContent = `Step ${this.step} of ${r.steps.length}`;

    for (const [seat, sv] of this.seats) {
      const s = f.seats.get(seat) ?? new ReplaySeatFrame();
      sv.stack.innerHTML = AgentHandReplayText.coins(s.stack) + (s.allIn && !s.folded && s.stack === 0 ? '  <span style="color:#FFD34D">ALL-IN</span>' : '');
      sv.label.textContent = s.label;
      sv.label.style.color = s.folded ? COLORS.soft : s.won > 0 ? COLORS.good : COLORS.white;
      if (sv.bet) sv.bet.textContent = s.bet > 0 && !s.folded ? AgentHandReplayText.coins(s.bet) : '';
      let [cr, cg, cb, ca] = sv.boxColor;
      if (seat === f.activeSeat) {
        cr += (64 - cr) * 0.45;
        cg += (115 - cg) * 0.45;
        cb += (242 - cb) * 0.45;
        ca += (1 - ca) * 0.45;
      }
      if (s.folded) ca = 0.45;
      sv.box.style.background = `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${ca})`;
      // Face down unless it's the Agent's (always) or shown at showdown: the frame only ever has those.
      const cards = s.folded && seat !== r.agentSeat ? null : s.cards;
      setChip(sv.card0, cards && cards.length > 0 ? cards[0] ?? null : null);
      setChip(sv.card1, cards && cards.length > 1 ? cards[1] ?? null : null);
      const show = !s.folded || seat === r.agentSeat;
      sv.card0.style.display = show ? '' : 'none';
      sv.card1.style.display = show ? '' : 'none';
    }

    // The per-round list follows along: the current step in gold, scrolled into view.
    const current = this.step - 1;
    for (const [k, [e, col]] of this.lines) {
      const on = k === current;
      e.style.color = on ? COLORS.gold : col;
      e.style.fontWeight = on || col === COLORS.gold ? 'bold' : 'normal';
    }
    const target = this.lines.get(current)?.[0];
    if (target && this.scroll) {
      const row = target.parentElement!;
      const y = row.offsetTop + target.offsetTop + target.offsetHeight / 2 - this.scroll.clientHeight * 0.35;
      this.scroll.scrollTop = Math.max(0, y);
    }
    this.updateControls();
  }
}
