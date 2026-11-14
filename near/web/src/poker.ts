// poker-core compiled to WebAssembly: the same code the table contract runs to verify a session. The browser uses
// it to re-deal and replay settled sessions itself, so what it shows is what the contract checked.

export type Step = { seat: number; act: string; street: number; put_in: number; pot: number };
export type Hand = {
  index: number;
  button: number;
  stacks_before: number[];
  holes: [string, string][];
  board: [string, string, string, string, string];
  actions: string;
  deltas: number[];
  blinds: number[];
  steps: Step[];
};
export type Replay = { hands: Hand[]; stacks: number[] };

let exports_: WebAssembly.Exports | null = null;

async function load() {
  if (!exports_) {
    const { instance } = await WebAssembly.instantiateStreaming(fetch("/poker_wasm.wasm"), {});
    exports_ = instance.exports;
  }
  return exports_ as unknown as {
    memory: WebAssembly.Memory;
    alloc(n: number): number;
    dealloc(p: number, n: number): void;
    replay_session(p: number, n: number): bigint;
  };
}

/** Re-deals a settled session from its randomness proof and replays every action under the betting rules. */
export async function replaySession(input: { signature_hex: string; stacks: number[]; button: number; sb: number; bb: number; hands: number; actions: string }): Promise<Replay> {
  const x = await load();
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const inPtr = x.alloc(bytes.length);
  new Uint8Array(x.memory.buffer, inPtr, bytes.length).set(bytes);
  const packed = BigInt.asUintN(64, x.replay_session(inPtr, bytes.length));
  x.dealloc(inPtr, bytes.length);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, outPtr, outLen).slice());
  x.dealloc(outPtr, outLen);
  const out = JSON.parse(text);
  if (!out.ok) throw new Error(out.error);
  return out;
}
