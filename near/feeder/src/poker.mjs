// Loads poker-core (compiled to WebAssembly by ../poker-wasm) so this server replays sessions with the exact code
// the table contract runs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_WASM = fileURLToPath(new URL("../../poker-wasm/target/wasm32-unknown-unknown/release/poker_wasm.wasm", import.meta.url));

export async function loadPoker(path = process.env.POKER_WASM ?? DEFAULT_WASM) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`poker wasm not found at ${path}: run "npm run build:wasm" first`);
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;

  function call(fn, input) {
    const inBytes = new TextEncoder().encode(JSON.stringify(input));
    const inPtr = x.alloc(inBytes.length);
    new Uint8Array(x.memory.buffer, inPtr, inBytes.length).set(inBytes);
    const packed = BigInt.asUintN(64, x[fn](inPtr, inBytes.length));
    x.dealloc(inPtr, inBytes.length);
    const outPtr = Number(packed >> 32n);
    const outLen = Number(packed & 0xffffffffn);
    const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, outPtr, outLen).slice());
    x.dealloc(outPtr, outLen);
    const out = JSON.parse(text);
    if (!out.ok) throw new Error(out.error);
    return out;
  }

  const simulateSeated = ({ signature_hex, stacks, profiles, button, sb, bb, hands, seating = null }) => {
    const out = call("simulate_session", { signature_hex, stacks, profiles, button, sb, bb, hands, seating });
    return { actions: out.actions, seat_order: out.seat_order ?? null };
  };

  return {
    /** Per-hand detail of a session: cards, actions, stacks before and each seat's result. Refuses what the contract refuses. */
    replay: ({ signature_hex, stacks, button, sb, bb, hands, actions }) => call("replay_session", { signature_hex, stacks, button, sb, bb, hands, actions }),
    /** Plays a session locally as the dealer would for this proof (v2 or {tight, aggro} profiles). Tests and offline demos only. */
    simulate: (input) => simulateSeated(input).actions,
    /** The same, also returning the seat order when `seating` is "vrf" (table position p = listed seat seat_order[p]). */
    simulateSeated,
    /** The seat order a proof gives n listed seats. */
    seatOrder: (signature_hex, n) => call("seat_order_of", { signature_hex, n }).seat_order,
  };
}
