// Run-ahead for agent tables.
//
// OutLayer's queue can take minutes to start a dealer run, while playing a session back at human pace takes longer
// still. So as soon as session N is settled and handed to playback, the feeder asks the dealer for session N+1 and
// settles it on the table contract, while N plays. Viewers only ever wait for the first session.
//
// Sessions chain: each starts from the previous one's final stacks. Inside a session a busted player sits out; between
// sessions every busted seat rebuys, so each session starts with a full table.
// Every step is safe to repeat (the dealer and the contract both accept an identical request again), so any failure
// is retried with the same request.
import { EventEmitter } from "node:events";
import { readFile, writeFile, rename } from "node:fs/promises";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** Seconds a viewer needs per hand: a pause between hands plus time per action. */
export const humanPace = ({ actions }) => 2500 + 1200 * (actions ? actions.split(",").length : 0);

export class FileStore {
  constructor(path) {
    this.path = path;
  }
  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async save(state) {
    await writeFile(this.path + ".tmp", JSON.stringify(state, null, 2));
    await rename(this.path + ".tmp", this.path);
  }
}

export class MemoryStore {
  state = null;
  async load() {
    return this.state && structuredClone(this.state);
  }
  async save(state) {
    this.state = structuredClone(state);
  }
}

export function sessionId(tableId, n) {
  const id = `${tableId}-${n}`;
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error(`session id "${id}": 1 to 40 of a-z, 0-9, -`);
  return id;
}

export class SessionFeeder extends EventEmitter {
  /**
   * @param o.tableId    short id; sessions are named `<tableId>-<n>`
   * @param o.seats      [{ profile: { tight, aggro }, stack }] in seat order; `stack` is the starting and rebuy stack
   * @param o.hands      hands per session
   * @param o.ahead      sessions to keep ready beyond the one playing (1 is enough when playback outlasts a fetch)
   * @param o.dealer     { run(input) -> { output, runMs, cost } }   (OutlayerClient)
   * @param o.table      { openSession, submitSession }                (TableClient)
   * @param o.poker      { replay }                                     (loadPoker())
   * @param o.pace       hand -> milliseconds of playback
   */
  constructor({ tableId, seats, backed = null, sb = 1, bb = 2, hands = 50, ahead = 1, dealer, table, poker, store = new MemoryStore(), pace = humanPace, retryMs = 5000 }) {
    super();
    // Backed tables: every seat is an agent bought in from its backer's position on the table contract, and every
    // session cashes out, so stacks do not carry over. `backed = { seats: [{ backer, agent_id }], buyIn }`.
    if (backed) seats = backed.seats.map(() => ({ stack: backed.buyIn }));
    if (seats.length < 2 || seats.length > 9) throw new Error("2 to 9 seats");
    sessionId(tableId, 0);
    Object.assign(this, { tableId, seats, backed, sb, bb, hands, ahead, dealer, table, poker, store, pace, retryMs });
    this.ready = [];
    this.wake = null;
  }

  async #state() {
    return (await this.store.load()) ?? { index: 0, stacks: this.seats.map((s) => s.stack), button: 0 };
  }

  async #retry(what, fn, signal) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (signal?.aborted) throw e;
        // The contract refused for a reason a retry cannot fix (funds, limits, unknown agents): stop the table.
        if (/loss limit|below the buy-in|of the pool|too small|lost too much|no position|has no pool|no agent|owner only/.test(e.message)) throw e;
        this.emit("retry", { what, attempt, error: e.message });
        await sleep(Math.min(this.retryMs * attempt, 60_000), signal);
      }
    }
  }

  /** Fetches, settles and replays the next session in the chain. */
  async prepare(signal) {
    const st = await this.#state();
    const id = sessionId(this.tableId, st.index);
    const stacks = this.backed ? this.backed.seats.map(() => this.backed.buyIn) : st.stacks;
    const req = { stacks, button: st.button, sb: this.sb, bb: this.bb, hands: this.hands };
    const t0 = Date.now();
    this.emit("fetching", { id, index: st.index, stacks });

    const askDealer = (profiles) =>
      this.#retry(
        `dealer ${id}`,
        async () => {
          const a = await this.dealer.run({ action: "session", hand_id: id, profiles, ...req });
          if (!a.output?.ok) throw new Error(`dealer refused: ${a.output?.error}`);
          return a;
        },
        signal,
      );
    let answer;
    if (this.backed) {
      // The contract locks each buy-in and records the agents' profiles; the dealer gets exactly that request.
      const recorded = await this.#retry(
        `open ${id}`,
        () => this.table.openBackedSession({ sessionId: id, seats: this.backed.seats, buyIn: this.backed.buyIn, button: req.button, sb: req.sb, bb: req.bb, hands: req.hands }),
        signal,
      );
      answer = await askDealer(recorded.profiles);
    } else {
      const profiles = this.seats.map((s) => s.profile);
      [, answer] = await Promise.all([this.#retry(`open ${id}`, () => this.table.openSession({ sessionId: id, profiles, ...req }), signal), askDealer(profiles)]);
    }
    const fetchedMs = Date.now() - t0;
    const { alpha, signature_hex, actions } = answer.output;

    const t1 = Date.now();
    const settled = await this.#retry(
      `settle ${id}`,
      async () => {
        try {
          return await this.table.submitSession({ sessionId: id, alpha, signature_hex, actions });
        } catch (e) {
          // Settled by an earlier attempt whose answer was lost: the stored result stands.
          if (/not pending/.test(e.message)) return { ok: true, already: true };
          throw e;
        }
      },
      signal,
    );
    const settleMs = Date.now() - t1;

    const detail = this.poker.replay({ signature_hex, actions, ...req });
    if (settled.stacks && settled.stacks.join() !== detail.stacks.join()) {
      throw new Error(`session ${id}: contract recorded ${settled.stacks}, replay gives ${detail.stacks}`);
    }
    const rebuys = [];
    const next = this.backed
      ? stacks
      : detail.stacks.map((s, i) => {
          if (s > 0) return s;
          rebuys.push({ seat: i, amount: this.seats[i].stack });
          return this.seats[i].stack;
        });
    // Busted seats sat out the rest of this session; they rebuy before the next. The next session's button is the
    // seat after the last hand's button.
    const lastButton = detail.hands.at(-1)?.button ?? st.button;
    await this.store.save({ index: st.index + 1, stacks: next, button: (lastButton + 1) % this.seats.length });

    const session = { id, index: st.index, hands: detail.hands, startStacks: stacks, endStacks: detail.stacks, rebuys, payouts: settled.payouts ?? null, alpha, signature_hex, fetchedMs, runMs: answer.runMs, cost: answer.cost, settleMs, readyAt: Date.now() };
    this.emit("ready", session);
    return session;
  }

  /** Plays `sessions` sessions back, keeping `ahead` sessions fetched and settled in advance. */
  async run({ sessions = Infinity, signal } = {}) {
    let produced = 0;
    let producerError = null;
    const notify = () => {
      const w = this.wake;
      this.wake = null;
      w?.();
    };
    const waitFor = () => new Promise((r) => (this.wake = r));

    const producer = (async () => {
      while (produced < sessions && !signal?.aborted) {
        while (this.ready.length >= this.ahead && !signal?.aborted) await waitFor();
        if (signal?.aborted) return;
        this.ready.push(await this.prepare(signal));
        produced++;
        notify();
      }
    })().catch((e) => {
      producerError = e;
      notify();
    });

    for (let played = 0; played < sessions; played++) {
      const wantedAt = Date.now();
      while (this.ready.length === 0) {
        if (producerError) throw producerError;
        if (signal?.aborted) throw signal.reason;
        await waitFor();
      }
      const s = this.ready.shift();
      notify(); // room in the buffer: the producer starts on the next session now
      const gotAt = Date.now();
      // lead: how long the session was ready before playback wanted it; stall: how long playback waited for it.
      this.emit("session", { ...s, leadMs: Math.max(0, wantedAt - s.readyAt), stallMs: gotAt - wantedAt, first: played === 0 });
      for (const hand of s.hands) {
        this.emit("hand", { session: s.id, ...hand });
        const ms = this.pace(hand);
        if (ms > 0) await sleep(ms, signal);
      }
      this.emit("session-end", { id: s.id, endStacks: s.endStacks, rebuys: s.rebuys });
    }
    await producer;
  }
}
