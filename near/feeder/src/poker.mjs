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

  return {
    /** Per-hand detail of a session: cards, actions, stacks before and each seat's result. Refuses what the contract refuses. */
    replay: ({ signature_hex, stacks, button, sb, bb, hands, actions }) => call("replay_session", { signature_hex, stacks, button, sb, bb, hands, actions }),
    /** Plays a session locally as the dealer would for this proof. Tests and offline demos only. */
    simulate: ({ signature_hex, stacks, profiles, button, sb, bb, hands }) =>
      call("simulate_session", { signature_hex, stacks, profiles: profiles.map((p) => [p.tight, p.aggro]), button, sb, bb, hands }).actions,
  };
}
