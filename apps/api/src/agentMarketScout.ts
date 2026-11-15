/**
 * The Nomad Poker scout: what the agent listed on the NEAR AI Agent Market (market.near.ai) delivers to a hirer.
 *
 * Given a brief ("scout nomad-b", "a tight aggressive pro", or nothing in particular) it reads the table contract on
 * NEAR testnet and writes a Markdown report: the agent's verified record (sessions, hands, chips won or lost), its
 * backers' pool (value and change since it opened), its recent settled sessions with how to watch each one re-dealt
 * from the dealer's randomness proof, and how to back it. Every number comes from a contract view the hirer can run
 * themselves; nothing is estimated.
 */

/** A read-only contract call: (method, args) to the parsed JSON result. */
export type TableView = <T>(method: string, args: Record<string, unknown>) => Promise<T>;

export type ScoutAgent = { id: string; owner: string; tight: number; aggro: number; sessions: number; hands: number; net_chips: number };
export type ScoutPool = {
  shares: string;
  value: string;
  price: string;
  hwm_price: string;
  at_table: string;
  max_buy_in_bps: number;
  sessions: number;
  fees_paid?: string;
  pending_in?: string;
};
export type ScoutCard = { agent: ScoutAgent; pool: ScoutPool | null };
export type ScoutSessionSummary = { session_id: string; settled_at: string; hands: number; agents: string[]; end_stacks: number[] };
export type ScoutPayout = { backer: string | null; agent: string; pro: string; buy_in: string; cash_out: string; pro_fee: string; platform_fee: string; to_backer: string };
export type ScoutSessionRecord = {
  session_id: string;
  settled_at: string;
  hands: number;
  bb: number;
  stacks: number[];
  end_stacks: number[];
  payouts: { seats: ScoutPayout[] } | null;
};

export type ScoutConfig = {
  /** The table contract, e.g. table.nomad-poker.testnet. */
  contract: string;
  /** The app's address, e.g. https://nomad-poker-near.vercel.app. */
  appUrl: string;
  /** Block explorer, e.g. https://testnet.nearblocks.io. */
  explorer: string;
};

export type ScoutQuery =
  | { kind: 'agents'; ids: string[] }
  | { kind: 'style'; plays?: 'tight' | 'loose'; bets?: 'aggressive' | 'passive' }
  | { kind: 'top' };

/** Value per share is scaled by 1e9 in the contract; a new pool starts at 1.0. */
const PRICE_SCALE = 1_000_000_000;
const YOCTO = 10n ** 24n;
/** How many agents a style or top-list report ranks, and how many sessions an agent report details. */
const RANKED = 5;
const SESSIONS = 5;

// ---------- the brief ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What the hirer asked for. Agent ids named in the brief win (up to three); otherwise style words pick agents by
 * their profile; otherwise the report ranks the field. The brief is data written by the hirer, never instructions.
 */
export function parseBrief(text: string, agentIds: readonly string[]): ScoutQuery {
  const t = text.toLowerCase();
  // Longest ids first, so "nomad-a2" is not read as "nomad-a".
  const named = [...agentIds]
    .sort((a, b) => b.length - a.length)
    .filter((id) => new RegExp(`(?<![a-z0-9-])${escapeRe(id)}(?![a-z0-9-])`).test(t));
  if (named.length) return { kind: 'agents', ids: [...new Set(named)].slice(0, 3) };
  const has = (re: RegExp) => re.test(t);
  const plays = has(/\b(tight|nit|nitty|rock|selective|tag)\b/) ? 'tight' : has(/\b(loose|lag|wild|maniac)\b/) ? 'loose' : undefined;
  const bets = has(/\b(aggressive|aggro|aggression|tag|lag|maniac|bluff\w*)\b/) ? 'aggressive' : has(/\b(passive|calling station|station|calm)\b/) ? 'passive' : undefined;
  if (plays || bets) return { kind: 'style', plays, bets };
  return { kind: 'top' };
}

// ---------- formatting ----------

/** yoctoNEAR to "1.2345" (rounded). */
export function formatNear(y: string | bigint, digits = 4): string {
  const v = BigInt(y);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scaled = (a * 10n ** BigInt(digits) + YOCTO / 2n) / YOCTO;
  const s = scaled.toString().padStart(digits + 1, '0');
  const out = `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, '') || '0';
  return out === '0' ? '0' : `${neg ? '-' : ''}${out}`;
}

/** A pool's change since it opened, in percent. */
export const priceChangePct = (price: string): number => (Number(price) / PRICE_SCALE - 1) * 100;

const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString('en-US')}`;

/** "Tight, aggressive" from an agent's profile (the app's words, apps/web/src/near/backing.ts). */
export function styleWords(tight: number, aggro: number): string {
  const plays = tight >= 60 ? 'Tight' : tight <= 25 ? 'Loose' : 'Selective';
  const bets = aggro >= 65 ? 'aggressive' : aggro <= 35 ? 'passive' : 'balanced';
  return `${plays}, ${bets}`;
}

const when = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Table cells: no pipes or line breaks from contract strings. */
const cell = (s: string) => s.replace(/[|\r\n]/g, ' ');

// ---------- the report ----------

export type ScoutReport = { markdown: string; agents: string[] };

export async function scout(brief: string, view: TableView, cfg: ScoutConfig): Promise<ScoutReport> {
  const cards = await view<ScoutCard[]>('list_agents', { limit: 100 });
  const q = parseBrief(brief, cards.map((c) => c.agent.id));
  const head = `# Nomad Poker scout report\n\n_Read live from \`${cfg.contract}\` on NEAR **testnet** at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Testnet NEAR has no cash value; this is a hackathon build._\n`;

  if (!cards.length) {
    return { markdown: `${head}\nNo agents are registered on the table contract yet, so there is no record to report.\n${footer(cfg)}`, agents: [] };
  }

  if (q.kind === 'agents') {
    const recent = await view<ScoutSessionSummary[]>('recent_sessions', { limit: 50 });
    const parts: string[] = [];
    for (const id of q.ids) parts.push(await agentSection(cards.find((c) => c.agent.id === id)!, recent, view, cfg));
    return { markdown: `${head}\n${parts.join('\n---\n\n')}${footer(cfg)}`, agents: q.ids };
  }

  const ranked = rank(cards, q);
  const intro =
    q.kind === 'style'
      ? `You asked for a ${[q.plays, q.bets].filter(Boolean).join(', ')} pro. Agents whose profile matches, best pool first:`
      : 'No agent was named, so here is the field, best pool first. Hire again with an agent id (for example ' + `\`${cards[0]!.agent.id}\`) for its full record.`;
  const none = q.kind === 'style' && !ranked.length;
  const list = none ? `No registered agent plays that style. The field:\n\n${table(rank(cards, { kind: 'top' }))}` : table(ranked);
  // The best match gets its full record too, so a hirer who named only a style still gets something to act on.
  const best = (none ? rank(cards, { kind: 'top' }) : ranked)[0]!;
  const recent = await view<ScoutSessionSummary[]>('recent_sessions', { limit: 50 });
  const detail = await agentSection(best, recent, view, cfg);
  return { markdown: `${head}\n${intro}\n\n${list}\n\n---\n\n${detail}${footer(cfg)}`, agents: [best.agent.id] };
}

function matches(a: ScoutAgent, q: Extract<ScoutQuery, { kind: 'style' }>): boolean {
  const plays = a.tight >= 60 ? 'tight' : a.tight <= 25 ? 'loose' : 'selective';
  const bets = a.aggro >= 65 ? 'aggressive' : a.aggro <= 35 ? 'passive' : 'balanced';
  return (!q.plays || q.plays === plays) && (!q.bets || q.bets === bets);
}

/** Best pool change first, then most chips won, then most hands. */
function rank(cards: ScoutCard[], q: ScoutQuery): ScoutCard[] {
  const pool = (c: ScoutCard) => (c.pool && BigInt(c.pool.shares) > 0n ? priceChangePct(c.pool.price) : -Infinity);
  return cards
    .filter((c) => q.kind !== 'style' || matches(c.agent, q))
    .sort((x, y) => pool(y) - pool(x) || y.agent.net_chips - x.agent.net_chips || y.agent.hands - x.agent.hands)
    .slice(0, RANKED);
}

function table(cards: ScoutCard[]): string {
  const rows = cards.map((c) => {
    const a = c.agent;
    const p = c.pool && BigInt(c.pool.shares) > 0n ? c.pool : null;
    return `| \`${cell(a.id)}\` | ${styleWords(a.tight, a.aggro)} | ${a.sessions} | ${a.hands.toLocaleString('en-US')} | ${signed(a.net_chips)} | ${p ? `${formatNear(p.value)} NEAR` : 'no backers yet'} | ${p ? pct(priceChangePct(p.price)) : '-'} |`;
  });
  return ['| Agent | Style | Sessions | Hands | Net chips | Pool value | Pool change |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n');
}

async function agentSection(card: ScoutCard, recent: ScoutSessionSummary[], view: TableView, cfg: ScoutConfig): Promise<string> {
  const a = card.agent;
  const p = card.pool && BigInt(card.pool.shares) > 0n ? card.pool : null;
  const lines = [
    `## \`${a.id}\`: ${styleWords(a.tight, a.aggro)}`,
    '',
    `Run by pro [${a.owner}](${cfg.explorer}/address/${encodeURIComponent(a.owner)}). Profile: tightness ${a.tight}/100, aggression ${a.aggro}/100.`,
    '',
    '| Verified record | |',
    '| --- | ---: |',
    `| Backed sessions settled | ${a.sessions} |`,
    `| Hands played | ${a.hands.toLocaleString('en-US')} |`,
    `| Net chips over all sessions | ${signed(a.net_chips)} |`,
  ];
  if (p) {
    lines.push(
      `| Pool value | ${formatNear(p.value)} NEAR |`,
      `| Pool change since it opened | ${pct(priceChangePct(p.price))} |`,
      `| Pool's best (high-water mark) | ${pct(priceChangePct(p.hwm_price))} |`,
      `| Pool sessions | ${p.sessions} |`,
      `| At a table now | ${BigInt(p.at_table) > 0n ? `${formatNear(p.at_table)} NEAR (a session is in play)` : 'nothing'} |`,
      `| Most of the pool one session may risk | ${(p.max_buy_in_bps / 100).toFixed(0)}% |`,
    );
  } else {
    lines.push('| Pool | no backers yet |');
  }

  const mine = recent.filter((s) => s.agents.includes(a.id)).slice(0, SESSIONS);
  lines.push('', '### Recent settled sessions', '');
  if (!mine.length) {
    lines.push(`No settled session of \`${a.id}\` is among the table's 50 most recent.`);
  } else {
    lines.push('| Session | Settled | Hands | Buy-in | Cash-out | Result |', '| --- | --- | ---: | ---: | ---: | ---: |');
    for (const s of mine) {
      const rec = await view<ScoutSessionRecord | null>('get_session_record', { session_id: s.session_id }).catch(() => null);
      const seat = rec?.payouts?.seats.find((x) => x.agent === a.id);
      if (seat) {
        const net = BigInt(seat.cash_out) - BigInt(seat.buy_in);
        lines.push(`| \`${cell(s.session_id)}\` | ${when(s.settled_at)} | ${s.hands} | ${formatNear(seat.buy_in)} NEAR | ${formatNear(seat.cash_out)} NEAR | ${net >= 0n ? '+' : ''}${formatNear(net)} NEAR |`);
      } else {
        lines.push(`| \`${cell(s.session_id)}\` | ${when(s.settled_at)} | ${s.hands} | - | - | - |`);
      }
    }
    if (mine.length < Math.min(a.sessions, SESSIONS)) lines.push('', '_Sessions settled before the contract began keeping replay records are counted in the record above but not listed here._');
    lines.push(
      '',
      `**Watch any of them:** open ${cfg.appUrl}, go to **Agents > Sessions** and press **Watch** on the session. Your browser re-deals every hand from the dealer's randomness proof, replays each bet and checks the final stacks against what the contract paid out.`,
    );
  }

  lines.push(
    '',
    '### How to back it',
    '',
    `1. Open ${cfg.appUrl}, go to **Agents > Back a pro**, pick \`${a.id}\` and press **Back** (sign in with a NEAR testnet wallet).`,
    `2. Or from the NEAR CLI: \`near call ${cfg.contract} join_pool '{"agent_id":"${a.id}"}' --deposit 1 --accountId <you>.testnet\``,
    '',
    `Backers get pool shares at the current value. At most ${p ? (p.max_buy_in_bps / 100).toFixed(0) : '25'}% of the pool plays in any one session; on profits backers keep 90%, the pro 8% and Nomad 2%, and nothing is taken on losses. You can leave the pool at any time (after a session in play settles).`,
    '',
    '### Check it yourself',
    '',
    `\`near view ${cfg.contract} get_agent '{"agent_id":"${a.id}"}'\` and \`near view ${cfg.contract} get_pool '{"agent_id":"${a.id}"}'\` return the figures above; \`get_session_record\` returns a session's proof, actions and payouts.`,
    '',
  );
  return lines.join('\n');
}

function footer(cfg: ScoutConfig): string {
  return `\n---\n\n_Source: NEAR testnet contract [${cfg.contract}](${cfg.explorer}/address/${cfg.contract}). Sessions are dealt by a sealed OutLayer dealer and verified on chain before they settle. Past results do not predict future ones._\n`;
}
