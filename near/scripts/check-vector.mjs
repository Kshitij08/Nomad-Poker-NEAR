// Checks that the Node helper opens what the Rust dealer code sealed.
//   cargo run -q --features seal --example vector | node ../scripts/check-vector.mjs
import { open, keygen } from "./hand.mjs";

let text = "";
for await (const chunk of process.stdin) text += chunk;
const v = JSON.parse(text);
const cards = open(v.sk, v.eph, v.ct);
const ok = JSON.stringify(cards) === JSON.stringify(v.cards);
console.log(ok ? "MATCH" : "MISMATCH", "rust:", v.cards, "node:", cards);
if (keygen().pk.length !== 64) throw new Error("keygen");
process.exit(ok ? 0 : 1);
