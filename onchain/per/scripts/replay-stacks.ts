// Rebuilds each seat's stack over a run of heads-up hands from what the backend archived: the public
// hand records (deck, button, who was dealt) and the admin-decrypted action logs. Buy-ins are raked
// (table.rake_bps), pots are not, so stacks follow exactly from who put in what and who won.
//   npx tsx scripts/replay-stacks.ts <table> <firstHand> <lastHand> <buyIn>
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { loadKey, programOn, teeConnection } from "./lib";
import { boardOf, cardName, dealOrder, holeCards } from "../tests/verifier";

const API = "https://poker-per-api-production.up.railway.app";
const [tableArg, firstArg, lastArg, buyInArg] = process.argv.slice(2);
const KIND = ["fold", "check", "call", "bet", "raise", "all-in", "small blind", "big blind"];

// Same evaluator as programs/poker-per/src/engine.rs (best 5 of 7; card = suit*13 + rank-2).
function eval5(c: number[]): number[] {
  const ranks = new Array(15).fill(0), suits = [0, 0, 0, 0];
  for (const x of c) { ranks[(x % 13) + 2]++; suits[Math.floor(x / 13)]++; }
  const flush = suits.some((s) => s === 5);
  let straight = 0;
  for (let h = 14; h >= 6 && !straight; h--) if ([0, 1, 2, 3, 4].every((k) => ranks[h - k] > 0)) straight = h;
  if (!straight && [14, 2, 3, 4, 5].every((r) => ranks[r] > 0)) straight = 5;
  const g: [number, number][] = [];
  for (let r = 14; r >= 2; r--) if (ranks[r]) g.push([ranks[r], r]);
  g.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const r = (i: number) => (g[i] ? g[i][1] : 0);
  if (straight && flush) return [8, straight];
  if (g[0][0] === 4) return [7, r(0), r(1)];
  if (g[0][0] === 3 && g[1]?.[0] === 2) return [6, r(0), r(1)];
  if (flush) return [5, r(0), r(1), r(2), r(3), r(4)];
  if (straight) return [4, straight];
  if (g[0][0] === 3) return [3, r(0), r(1), r(2)];
  if (g[0][0] === 2 && g[1]?.[0] === 2) return [2, r(0), r(1), r(2)];
  if (g[0][0] === 2) return [1, r(0), r(1), r(2), r(3)];
  return [0, r(0), r(1), r(2), r(3), r(4)];
}
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
function best(cards: number[]): number[] {
  let top: number[] | null = null;
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    const v = eval5(cards.filter((_, i) => i !== a && i !== b));
    if (!top || cmp(v, top) > 0) top = v;
  }
  return top!;
}

(async () => {
  const token = fs.readFileSync(path.join(process.env.POKER_PER_KEYS!, "m7-admin-token.txt"), "utf8").trim();
  const deployer = loadKey("deployer");
  const t: any = await (programOn(await teeConnection(deployer), deployer).account as any).table.fetch(new PublicKey(tableArg));
  const buyIn = Number(buyInArg), rake = Math.ceil((buyIn * t.rakeBps) / 10_000);
  const stack: Record<number, number> = {};
  const hands: any[] = [];
  for (let h = Number(firstArg); h <= Number(lastArg); h++) {
    const rec = (await (await fetch(`${API}/tables/${tableArg}/hands/${h}`)).json()) as any;
    const log = (await (await fetch(`${API}/audit/tables/${tableArg}/hands/${h}/log`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
    const r = rec.record;
    const seats = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((s) => (r.dealtMask >> s) & 1);
    for (const s of seats) if (stack[s] === undefined) stack[s] = buyIn - rake; // sat down before this hand
    const committed: Record<number, number> = {}, folded = new Set<number>();
    for (const e of log.entries) { committed[e.seat] = Number(e.committed); if ((e.kind & 0x7f) === 0) folded.add(e.seat); }
    const before = { ...stack };
    const live = seats.filter((s) => !folded.has(s));
    const [a, b] = seats;
    // Heads-up: an uncalled excess goes back; the matched part is the pot.
    const matched = Math.min(committed[a] ?? 0, committed[b] ?? 0);
    for (const s of seats) stack[s] -= committed[s] ?? 0;
    for (const s of seats) stack[s] += (committed[s] ?? 0) - matched;
    const pot = 2 * matched;
    let winners: number[];
    let shown: any = null;
    if (live.length === 1) winners = live;
    else {
      const holes = holeCards(r.cards, dealOrder(r.button, r.dealtMask));
      const board = boardOf(r.cards, seats.length);
      const vals = live.map((s) => ({ s, v: best([...holes[s], ...board]) }));
      vals.sort((x, y) => cmp(y.v, x.v));
      winners = vals.filter((x) => cmp(x.v, vals[0].v) === 0).map((x) => x.s);
      shown = { board: board.map(cardName), ...Object.fromEntries(live.map((s) => [`seat${s}`, holes[s].map(cardName)])) };
    }
    const share = Math.floor(pot / winners.length);
    for (const w of winners) stack[w] += share;
    stack[winners[0]] += pot - share * winners.length;
    hands.push({ hand: h, button: r.button, verified: rec.verified, actions: log.entries.map((e: any) => `s${e.seat} ${KIND[e.kind & 0x7f]}${e.kind & 0x80 ? " (timeout)" : ""} ${e.committed}`),
      showdown: shown, pot, winners, stacksBefore: before, stacksAfter: { ...stack } });
  }
  const out = { table: tableArg, rakeBps: t.rakeBps, buyIn, chipsAfterRake: buyIn - rake, hands, finalStacks: stack, total: Object.values(stack).reduce((x, y) => x + y, 0) };
  fs.writeFileSync(`results/replay-${tableArg.slice(0, 4)}-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
