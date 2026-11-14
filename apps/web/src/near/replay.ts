/**
 * Watching a settled NEAR agent session: poker-core (compiled to WebAssembly, the same code the table contract runs)
 * re-deals every hand from the dealer's randomness proof and replays each bet, and each hand becomes an
 * AgentHandReplay for the 3D table's replayer (agents/replaySession.ts). Agents' cards are no secret after a settled
 * session, but the replay keeps the table's rule anyway: the backed agent's cards face up, the others shown at showdown.
 */
import { AgentHandReplay, ReplaySeat, ReplayStep } from '@nomad/engine/agents';

export type WasmStep = { seat: number; act: string; street: number; put_in: number; pot: number };
export type WasmHand = {
  index: number;
  button: number;
  stacks_before: number[];
  holes: [string, string][];
  board: [string, string, string, string, string];
  actions: string;
  deltas: number[];
  /** Each seat's blind as posted. */
  blinds: number[];
  steps: WasmStep[];
};
export type WasmReplay = { hands: WasmHand[]; stacks: number[] };
export type ReplayInput = { signature_hex: string; stacks: number[]; button: number; sb: number; bb: number; hands: number; actions: string };

type PokerWasm = {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  replay_session(p: number, n: number): bigint;
};

let wasm: Promise<PokerWasm> | null = null;

function load(): Promise<PokerWasm> {
  wasm ??= WebAssembly.instantiateStreaming(fetch('/near/poker_wasm.wasm'), {}).then(({ instance }) => instance.exports as unknown as PokerWasm);
  wasm.catch(() => (wasm = null));
  return wasm;
}

/** Re-deals a settled session from its randomness proof and replays every action under the betting rules. */
export async function replaySettled(input: ReplayInput, x?: PokerWasm): Promise<WasmReplay> {
  x ??= await load();
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const inPtr = x.alloc(bytes.length);
  new Uint8Array(x.memory.buffer, inPtr, bytes.length).set(bytes);
  const packed = BigInt.asUintN(64, x.replay_session(inPtr, bytes.length));
  x.dealloc(inPtr, bytes.length);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, outPtr, outLen).slice());
  x.dealloc(outPtr, outLen);
  const out = JSON.parse(text) as WasmReplay & { ok: boolean; error?: string };
  if (!out.ok) throw new Error(out.error ?? 'replay failed');
  return out;
}

const STREETS = ['Preflop', 'Flop', 'Turn', 'River'] as const;
const BOARD_AT = [0, 3, 4, 5];

/**
 * One re-dealt hand as an AgentHandReplay. `names` are the seats' agent ids; `focus` is the seat whose cards are shown
 * from the deal (the agent being watched), -1 for none.
 */
export function toAgentReplay(h: WasmHand, names: readonly string[], sb: number, bb: number, focus: number): AgentHandReplay {
  const n = h.stacks_before.length;
  const r = new AgentHandReplay();
  r.handNumber = h.index + 1;
  r.smallBlind = sb;
  r.bigBlind = bb;
  r.buttonSeat = h.button;
  const playing = (i: number) => h.stacks_before[i]! > 0;
  r.agentSeat = focus >= 0 && playing(focus) ? focus : -1;
  r.agentCards = r.agentSeat >= 0 ? [...h.holes[r.agentSeat]!] : null;

  const stack = [...h.stacks_before];
  const putIn = new Array<number>(n).fill(0);
  const streetBet = new Array<number>(n).fill(0);
  const folded = new Array<boolean>(n).fill(false);
  let pot = 0;
  const steps: ReplayStep[] = [];

  // Blinds: the smaller post is the small blind (heads-up, the button posts it); a short stack may post less.
  steps.push(ReplayStep.of({ type: ReplayStep.Street, streetName: 'Preflop', board: [] }));
  const posted = h.blinds.map((amt, seat) => ({ amt, seat })).filter((b) => b.amt > 0 && playing(b.seat));
  const after = (seat: number) => (seat - h.button + n) % n || n;
  posted.sort((a, b) => after(a.seat) - after(b.seat));
  if (posted.length === 2 && posted[0]!.seat !== h.button && after(posted[1]!.seat) === n) posted.reverse();
  posted.forEach((b, k) => {
    stack[b.seat]! -= b.amt;
    putIn[b.seat]! += b.amt;
    streetBet[b.seat] = b.amt;
    pot += b.amt;
    steps.push(ReplayStep.of({ type: ReplayStep.Blind, seat: b.seat, action: k === 0 && posted.length > 1 ? 'small_blind' : 'big_blind', amount: b.amt, pot, stack: stack[b.seat] }));
  });

  let street = 0;
  const toStreet = (s: number) => {
    while (street < s) {
      street++;
      streetBet.fill(0);
      steps.push(ReplayStep.of({ type: ReplayStep.Street, streetName: STREETS[street], board: h.board.slice(0, BOARD_AT[street]) }));
    }
  };
  let betOnStreet = street === 0;
  for (const st of h.steps) {
    if (st.street > street) {
      toStreet(st.street);
      betOnStreet = false;
    }
    const s = st.seat;
    stack[s]! -= st.put_in;
    putIn[s]! += st.put_in;
    streetBet[s]! += st.put_in;
    pot = st.pot;
    let action: string;
    if (st.act === 'f') {
      folded[s] = true;
      action = 'Fold';
    } else if (st.act === 'c') action = st.put_in === 0 ? 'Check' : stack[s] === 0 ? 'AllIn' : 'Call';
    else {
      action = stack[s] === 0 ? 'AllIn' : betOnStreet ? 'Raise' : 'Bet';
      betOnStreet = true;
    }
    steps.push(ReplayStep.of({ type: ReplayStep.Act, seat: s, action, amount: streetBet[s], pot, stack: stack[s] }));
  }

  const live = [...Array(n).keys()].filter((i) => playing(i) && !folded[i]);
  if (live.length > 1) {
    toStreet(3); // all-in run-outs deal the rest of the board
    for (const i of live) steps.push(ReplayStep.of({ type: ReplayStep.Show, seat: i, cards: [...h.holes[i]!], description: '' }));
  }
  const winners = [...Array(n).keys()].filter((i) => playing(i) && h.stacks_before[i]! + h.deltas[i]! > stack[i]!);
  for (const i of winners) {
    const won = h.stacks_before[i]! + h.deltas[i]! - stack[i]!;
    pot = Math.max(0, pot - won);
    steps.push(ReplayStep.of({ type: ReplayStep.Award, seat: i, amount: won, pot, stack: stack[i]! + won, description: live.length > 1 ? 'Pot' : 'Uncontested' }));
  }

  r.seats = [...Array(n).keys()].filter(playing).map((i) => {
    const seat = new ReplaySeat();
    seat.seat = i;
    seat.name = names[i] ?? `Seat ${i + 1}`;
    seat.startStack = h.stacks_before[i]!;
    seat.isAgent = i === r.agentSeat;
    seat.isOtherAgent = i !== r.agentSeat;
    seat.cards = i === r.agentSeat || (live.length > 1 && live.includes(i)) ? [...h.holes[i]!] : null;
    seat.endStack = h.stacks_before[i]! + h.deltas[i]!;
    seat.net = h.deltas[i]!;
    return seat;
  });
  r.steps = steps;
  return r;
}
