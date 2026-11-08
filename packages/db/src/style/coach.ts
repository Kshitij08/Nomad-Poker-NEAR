// Coaching: stats and leaks computed from a player's decisions and hands (the numbers are the source of truth);
// an optional Claude note only puts them into words.
import type { Decision } from "./style";

export type HandResult = { position: number; bigBlind: number; net: number; showdown: boolean; won: boolean; handNo: number; table: string };
export type Leak = { id: string; title: string; detail: string; cost: number; advice: string };
export type Report = {
  hands: number;
  decisions: number;
  stats: {
    vpip: number; pfr: number; aggressionFactor: number; wentToShowdown: number; wonAtShowdown: number;
    bbPer100: number; byPosition: { early: number; late: number };
  };
  working: string[];
  notWorking: Leak[];
  tryNext: string;
  summary: string; // rule-based text; replaced by the Claude note when one is written
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const LATE = (pos: number) => pos <= 1; // button and cutoff (seats after the button)

export function coach(decisions: Decision[], hands: HandResult[]): Report {
  const handKey = (d: { table?: string; handNo?: number }) => `${d.table}|${d.handNo}`;
  const pre = decisions.filter((d) => d.street === 0);
  // VPIP / PFR per hand: put money in voluntarily (call/bet/raise preflop), raised preflop.
  const byHand = new Map<string, { vpip: boolean; pfr: boolean }>();
  for (const d of pre as (Decision & { table?: string; handNo?: number })[]) {
    const k = handKey(d);
    const h = byHand.get(k) ?? { vpip: false, pfr: false };
    if (d.action === "call" || d.action === "bet" || d.action === "raise") h.vpip = true;
    if (d.action === "bet" || d.action === "raise") h.pfr = true;
    byHand.set(k, h);
  }
  const preHands = Math.max(1, byHand.size);
  const vpip = [...byHand.values()].filter((h) => h.vpip).length / preHands;
  const pfr = [...byHand.values()].filter((h) => h.pfr).length / preHands;
  const post = decisions.filter((d) => d.street > 0);
  const aggr = post.filter((d) => d.action === "bet" || d.action === "raise").length;
  const calls = post.filter((d) => d.action === "call").length;
  const aggressionFactor = calls ? aggr / calls : aggr;
  const sd = hands.filter((h) => h.showdown);
  const wentToShowdown = hands.length ? sd.length / hands.length : 0;
  const wonAtShowdown = sd.length ? sd.filter((h) => h.won).length / sd.length : 0;
  const bb = (h: HandResult) => (h.bigBlind > 0 ? h.net / h.bigBlind : 0);
  const per100 = (xs: HandResult[]) => (xs.length ? (xs.reduce((s, h) => s + bb(h), 0) / xs.length) * 100 : 0);
  const early = hands.filter((h) => !LATE(h.position)), late = hands.filter((h) => LATE(h.position));

  const leaks: Leak[] = [];
  const working: string[] = [];

  // Calls without the odds: strength below the pot odds (and under 0.5).
  const badCalls = decisions.filter((d) => d.action === "call" && d.toCall > 0 && d.strength < Math.min(0.5, d.toCall / (d.pot + d.toCall)) - 0.1);
  if (badCalls.length >= 5) {
    const cost = badCalls.reduce((s, d) => s + d.toCall, 0);
    leaks.push({ id: "loose_calls", title: "Calling without the odds", cost,
      detail: `${badCalls.length} calls with a weak hand and poor pot odds (${cost.toLocaleString()} chips put in).`,
      advice: "Fold weak hands when the price is high; call when your hand is at least as strong as the pot odds." });
  }
  // Passive with strong hands.
  const strong = decisions.filter((d) => d.strength >= 0.8);
  const strongPassive = strong.filter((d) => d.action === "check" || d.action === "call");
  if (strong.length >= 8 && strongPassive.length / strong.length > 0.6)
    leaks.push({ id: "passive_strong", title: "Slow with strong hands", cost: 0,
      detail: `You checked or called ${pct(strongPassive.length / strong.length)} of the time with a strong hand.`,
      advice: "Bet and raise your strong hands; players who call give you chips." });
  else if (strong.length >= 8) working.push(`You bet your strong hands (${pct(1 - strongPassive.length / strong.length)} of the time).`);
  // Over-bluffing: aggressive with weak hands often, and losing on those hands.
  const weakAggr = decisions.filter((d) => d.strength < 0.3 && (d.action === "bet" || d.action === "raise"));
  if (decisions.length >= 50 && weakAggr.length / decisions.length > 0.12)
    leaks.push({ id: "over_bluff", title: "Bluffing too often", cost: 0,
      detail: `${weakAggr.length} bets or raises with a weak hand (${pct(weakAggr.length / decisions.length)} of your decisions).`,
      advice: "Bluff less, especially into 3 or more players; pick spots where one opponent is likely to fold." });
  // Position: much worse early than late, while playing as many hands early.
  if (early.length >= 30 && late.length >= 30 && per100(late) - per100(early) > 15)
    leaks.push({ id: "position", title: "Too many hands from early position", cost: 0,
      detail: `You win ${per100(late).toFixed(1)} bb/100 late but ${per100(early).toFixed(1)} bb/100 early.`,
      advice: "Play fewer, stronger hands from early seats; open up on the button and cutoff." });
  else if (late.length >= 30 && per100(late) > 0) working.push(`You win from late position (${per100(late).toFixed(1)} bb/100).`);
  // Preflop shape.
  if (preHands >= 40) {
    if (vpip > 0.45) leaks.push({ id: "vpip_high", title: "Playing too many hands", cost: 0,
      detail: `You put chips in ${pct(vpip)} of hands before the flop.`, advice: "Aim for about 20–30% at a full table." });
    else if (vpip < 0.12) leaks.push({ id: "vpip_low", title: "Too tight", cost: 0,
      detail: `You play only ${pct(vpip)} of hands.`, advice: "Open more hands from late position; the blinds add up." });
    else working.push(`A healthy range: you play ${pct(vpip)} of hands.`);
    if (vpip > 0.15 && pfr / vpip < 0.35) leaks.push({ id: "limp", title: "Calling instead of raising before the flop", cost: 0,
      detail: `You raise only ${pct(pfr)} of hands but play ${pct(vpip)}.`, advice: "When you play a hand, raise it more often than you call." });
  }
  if (sd.length >= 15 && wonAtShowdown >= 0.55) working.push(`You win ${pct(wonAtShowdown)} of showdowns: good hand selection.`);

  leaks.sort((a, b) => b.cost - a.cost);
  const tryNext = leaks[0]?.advice ?? (hands.length < 30 ? "Play a few more hands so the coach can see your style." : "Keep it up and try a higher stake.");
  const stats = { vpip, pfr, aggressionFactor, wentToShowdown, wonAtShowdown, bbPer100: per100(hands), byPosition: { early: per100(early), late: per100(late) } };
  const summary = [
    `${hands.length} hands, ${stats.bbPer100.toFixed(1)} bb/100.`,
    working.length ? `Working: ${working.join(" ")}` : "",
    leaks.length ? `Not working: ${leaks.map((l) => l.title.toLowerCase()).join(", ")}.` : "No big leaks found.",
    `Try next: ${tryNext}`,
  ].filter(Boolean).join(" ");
  return { hands: hands.length, decisions: decisions.length, stats, working, notWorking: leaks, tryNext, summary };
}

/** A short friendly coaching note from the computed report, by Claude. Null without a key or on any error. */
export async function claudeNote(
  report: Report,
  opts: { apiKey?: string | null; model?: string | null; fetch?: typeof fetch } = {},
): Promise<string | null> {
  const key = opts.apiKey?.trim();
  if (!key || report.hands < 20) return null;
  const model = opts.model?.trim() || "claude-haiku-5-5";
  const fetchImpl = opts.fetch ?? fetch;
  const facts = JSON.stringify({ hands: report.hands, stats: report.stats, working: report.working,
    notWorking: report.notWorking.map((l) => ({ title: l.title, detail: l.detail, advice: l.advice })), tryNext: report.tryNext });
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 350,
        system: "You are a friendly poker coach in a casual mobile poker game. Write 2 short paragraphs (under 110 words total) for the player: what is working, what is not, and one concrete thing to try next. Use only the facts given; do not invent numbers, hands or stats. No headings, no lists.",
        messages: [{ role: "user", content: `Facts about my recent play (JSON): ${facts}` }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const text = (body?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim();
    return text || null;
  } catch {
    return null;
  }
}
