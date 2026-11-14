// Stand-ins for OutLayer and the table contract, driven by the real poker-core (via WebAssembly).
import { createHash } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sigFor = (id) => createHash("sha512").update(`fake-proof:${id}`).digest("hex");

export class FakeDealer {
  constructor(poker, { delayMs = 0, failFirst = 0 } = {}) {
    Object.assign(this, { poker, delayMs, failFirst });
    this.calls = [];
  }
  async run(input) {
    this.calls.push({ at: Date.now(), input: structuredClone(input) });
    await sleep(typeof this.delayMs === "function" ? this.delayMs(input) : this.delayMs);
    if (this.failFirst > 0) {
      this.failFirst--;
      throw new Error("dealer call failed (injected)");
    }
    const signature_hex = sigFor(input.hand_id);
    const actions = this.poker.simulate({ signature_hex, ...input });
    return { output: { ok: true, hand_id: input.hand_id, alpha: `vrf:1:fake:session-${input.hand_id}`, signature_hex, actions }, runMs: 1, cost: "1000" };
  }
}

export class FakeTable {
  constructor(poker) {
    this.poker = poker;
    this.sessions = new Map();
    this.backed = new Map();
    this.opens = [];
    this.agents = {};
  }
  async openSession(args) {
    this.opens.push(structuredClone(args));
    const prev = this.sessions.get(args.sessionId);
    if (prev && JSON.stringify(prev.args) !== JSON.stringify(args)) throw new Error("a retry must repeat the same request");
    if (!prev) this.sessions.set(args.sessionId, { args, status: "Pending" });
  }
  /** Mirrors the contract: records the agents' profiles and returns the request the dealer must get. */
  async openBackedSession({ sessionId, seats, buyIn, button, sb, bb, hands }) {
    const profiles = seats.map((s) => this.agents[s.agent_id]);
    if (profiles.some((p) => !p)) throw new Error("no agent");
    const stacks = seats.map(() => buyIn);
    await this.openSession({ sessionId, stacks, profiles, button, sb, bb, hands });
    this.backed.set(sessionId, { seats, buyIn });
    return { action: "session", hand_id: sessionId, stacks, profiles, button, sb, bb, hands };
  }

  async submitSession({ sessionId, signature_hex, actions }) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("no session");
    if (s.status !== "Pending") throw new Error("session is not pending");
    const { stacks, button, sb, bb, hands } = s.args;
    const r = this.poker.replay({ signature_hex, stacks, button, sb, bb, hands, actions });
    s.status = "Done";
    const b = this.backed.get(sessionId);
    const payouts = b ? { session_id: sessionId, seats: b.seats.map((seat, i) => ({ ...seat, buy_in: b.buyIn, cash_out: r.stacks[i] })) } : null;
    return { ok: true, hands_played: r.hands.length, stacks: r.stacks, payouts };
  }
}
