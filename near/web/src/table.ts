// Plays a settled session back hand by hand at reading pace, from the browser's own replay of the proof.
import type { Hand, Replay, Step } from "./poker";

const SUIT: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
const RED = new Set(["d", "h"]);
const BOARD_AT_STREET = [0, 3, 4, 5];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function cardEl(code: string | null): HTMLElement {
  const el = document.createElement("span");
  if (!code) {
    el.className = "card card--slot";
    return el;
  }
  const rank = code[0] === "T" ? "10" : code[0];
  el.className = `card${RED.has(code[1]) ? " card--red" : ""}`;
  el.innerHTML = `<b>${rank}</b><i>${SUIT[code[1]]}</i>`;
  el.setAttribute("aria-label", `${rank} of ${{ c: "clubs", d: "diamonds", h: "hearts", s: "spades" }[code[1]]}`);
  return el;
}

function describe(step: Step, stackLeft: number): string {
  if (step.act === "f") return "Fold";
  if (step.act === "c") return step.put_in === 0 ? "Check" : stackLeft === 0 ? `All in ${step.put_in}` : `Call ${step.put_in}`;
  const to = step.act.slice(1);
  return stackLeft === 0 ? `All in, ${to}` : `Raise to ${to}`;
}

type SeatEls = { root: HTMLElement; cards: HTMLElement; stack: HTMLElement; bet: HTMLElement; bubble: HTMLElement };

export class TablePlayer {
  private seats: SeatEls[] = [];
  private board: HTMLElement;
  private pot: HTMLElement;
  private caption: HTMLElement;
  private run = 0;

  constructor(private root: HTMLElement, private stepMs = 1100) {
    root.innerHTML = `
      <div class="felt" role="img" aria-label="Poker table">
        <div class="felt__center">
          <div class="board" aria-live="polite"></div>
          <div class="pot">Pot <span>0</span></div>
        </div>
      </div>
      <p class="table-caption" aria-live="polite"></p>`;
    this.board = root.querySelector(".board")!;
    this.pot = root.querySelector(".pot span")!;
    this.caption = root.querySelector(".table-caption")!;
  }

  private layout(names: string[]) {
    const felt = this.root.querySelector(".felt")!;
    felt.querySelectorAll(".seat").forEach((s) => s.remove());
    const n = names.length;
    this.seats = names.map((name, i) => {
      const angle = (2 * Math.PI * i) / n;
      const el = document.createElement("div");
      el.className = "seat";
      el.style.setProperty("--x", `${50 - 44 * Math.sin(angle)}%`);
      el.style.setProperty("--y", `${50 + 41 * Math.cos(angle)}%`);
      el.innerHTML = `
        <div class="seat__cards"></div>
        <div class="seat__plate"><strong>${name}</strong><span class="seat__stack"></span></div>
        <div class="seat__bet"></div>
        <div class="seat__bubble"></div>`;
      felt.appendChild(el);
      return {
        root: el,
        cards: el.querySelector(".seat__cards")!,
        stack: el.querySelector(".seat__stack")!,
        bet: el.querySelector(".seat__bet")!,
        bubble: el.querySelector(".seat__bubble")!,
      };
    });
  }

  private showBoard(cards: string[], count: number) {
    this.board.replaceChildren(...[0, 1, 2, 3, 4].map((i) => cardEl(i < count ? cards[i] : null)));
  }

  stop() {
    this.run++;
  }

  private async wait(ms: number, run: number) {
    await new Promise((r) => setTimeout(r, reducedMotion ? ms * 0.6 : ms));
    if (run !== this.run) throw new Error("stopped");
  }

  /** Plays every hand of a replayed session. Resolves when done; a later `play` or `stop` cuts it short. */
  async play(replay: Replay, names: string[], onHand?: (h: Hand, i: number) => void) {
    const run = ++this.run;
    this.layout(names);
    try {
      for (const [i, hand] of replay.hands.entries()) {
        onHand?.(hand, i);
        await this.playHand(hand, run, i, replay.hands.length);
      }
      this.caption.textContent = `Session over. Final stacks: ${replay.stacks.join(", ")} chips.`;
    } catch (e) {
      if ((e as Error).message !== "stopped") throw e;
    }
  }

  private async playHand(hand: Hand, run: number, i: number, total: number) {
    const stacks = hand.stacks_before.map((s, k) => s - hand.blinds[k]);
    const bets = [...hand.blinds];
    const folded = hand.stacks_before.map((s) => s === 0);
    let pot = hand.blinds.reduce((a, b) => a + b, 0);
    let street = 0;

    this.caption.textContent = `Hand ${i + 1} of ${total}`;
    this.showBoard(hand.board, 0);
    this.pot.textContent = String(pot);
    this.seats.forEach((s, k) => {
      s.root.classList.toggle("seat--out", folded[k]);
      s.root.classList.remove("seat--folded", "seat--acting", "seat--won", "seat--lost");
      s.root.classList.toggle("seat--button", k === hand.button);
      s.cards.replaceChildren(...(folded[k] ? [] : hand.holes[k].map(cardEl)));
      s.stack.textContent = String(stacks[k]);
      s.bet.textContent = bets[k] ? String(bets[k]) : "";
      s.bubble.textContent = folded[k] ? "Sitting out" : "";
    });
    await this.wait(this.stepMs, run);

    for (const step of hand.steps) {
      if (step.street !== street) {
        street = step.street;
        bets.fill(0);
        this.seats.forEach((s) => (s.bet.textContent = ""));
        this.showBoard(hand.board, BOARD_AT_STREET[street]);
        await this.wait(this.stepMs * 0.6, run);
      }
      const s = this.seats[step.seat];
      this.seats.forEach((x) => x.root.classList.remove("seat--acting"));
      s.root.classList.add("seat--acting");
      stacks[step.seat] -= step.put_in;
      bets[step.seat] += step.put_in;
      pot = step.pot;
      if (step.act === "f") {
        folded[step.seat] = true;
        s.root.classList.add("seat--folded");
      }
      s.bubble.textContent = describe(step, stacks[step.seat]);
      s.stack.textContent = String(stacks[step.seat]);
      s.bet.textContent = bets[step.seat] ? String(bets[step.seat]) : "";
      this.pot.textContent = String(pot);
      await this.wait(this.stepMs, run);
    }

    // Showdown when more than one player is left: the whole board is dealt out.
    const live = folded.filter((f) => !f).length;
    if (live > 1) this.showBoard(hand.board, 5);
    this.seats.forEach((s, k) => {
      s.root.classList.remove("seat--acting");
      s.bet.textContent = "";
      const d = hand.deltas[k];
      if (d > 0) {
        s.root.classList.add("seat--won");
        s.bubble.textContent = `Wins ${d}`;
      } else if (d < 0 && !folded[k]) {
        s.root.classList.add("seat--lost");
      }
      s.stack.textContent = String(hand.stacks_before[k] + d);
    });
    this.pot.textContent = "0";
    await this.wait(this.stepMs * 2.2, run);
  }
}
