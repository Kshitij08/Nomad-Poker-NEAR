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
    // Seated sessions ("seating": "vrf") are seated from the proof, as the real dealer does.
    const actions = this.poker.simulate({ signature_hex, ...input });
    const attest = createHash("sha256").update(`${input.hand_id}|${actions}`).digest("hex");
    return { output: { ok: true, hand_id: input.hand_id, alpha: `vrf:1:fake:session-${input.hand_id}`, signature_hex, actions, attest_alpha: `vrf:2:fake:act-${attest}`, attest_signature_hex: sigFor(attest) }, runMs: 1, cost: "1000" };
  }
}

export class FakeTable {
  constructor(poker) {
    this.poker = poker;
    this.sessions = new Map();
    this.backed = new Map();
    this.opens = [];
    /** agent_id -> { profile, owner } */
    this.agents = {};
  }
  async openSession(args) {
    this.opens.push(structuredClone(args));
    const prev = this.sessions.get(args.sessionId);
    if (prev && JSON.stringify(prev.args) !== JSON.stringify(args)) throw new Error("a retry must repeat the same request");
    if (!prev) this.sessions.set(args.sessionId, { args, status: "Pending" });
  }
  /** Mirrors the contract: no two seats of one pro, records the agents' profiles, seats from the randomness. */
  async openBackedSession({ sessionId, seats, buyIn, button, sb, bb, hands }) {
    const agents = seats.map((s) => this.agents[s.agent_id]);
    if (agents.some((a) => !a)) throw new Error("no agent");
    const owners = agents.map((a) => a.owner);
    if (new Set(owners).size !== owners.length) throw new Error("self-play: two seats belong to one pro");
    const profiles = agents.map((a) => a.profile);
    const stacks = seats.map(() => buyIn);
    await this.openSession({ sessionId, stacks, profiles, button, sb, bb, hands, seating: "vrf" });
    this.backed.set(sessionId, { seats, buyIn });
    return { action: "session", hand_id: sessionId, stacks, profiles, button, sb, bb, hands, seating: "vrf" };
  }

  async submitSession({ sessionId, signature_hex, actions, attest_alpha }) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("no session");
    if (s.status !== "Pending") throw new Error("session is not pending");
    // Stands in for the contract's attestation check: backed sessions need the dealer's signature over these actions.
    const want = createHash("sha256").update(`${sessionId}|${actions}`).digest("hex");
    if (this.backed.has(sessionId) && attest_alpha !== `vrf:2:fake:act-${want}`) throw new Error("the attestation does not match these actions");
    const { stacks, button, sb, bb, hands, seating } = s.args;
    const order = seating === "vrf" ? this.poker.seatOrder(signature_hex, stacks.length) : null;
    const seated = order ? order.map((i) => stacks[i]) : stacks;
    const r = this.poker.replay({ signature_hex, stacks: seated, button, sb, bb, hands, actions });
    s.status = "Done";
    const b = this.backed.get(sessionId);
    // Payouts by table position, as the contract reports them.
    const bySeat = b ? (order ? order.map((i) => b.seats[i]) : b.seats) : null;
    const payouts = b ? { session_id: sessionId, seats: bySeat.map((seat, i) => ({ ...seat, buy_in: b.buyIn, cash_out: r.stacks[i] })) } : null;
    return { ok: true, hands_played: r.hands.length, stacks: r.stacks, payouts, seat_order: order };
  }
}
