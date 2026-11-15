/**
 * NEAR Intents (1Click API) price quotes for backing an agent from another chain: "pay with USDC on Base, NEAR arrives
 * in the pool". 1Click runs on NEAR mainnet only (there is no testnet), and this app runs on testnet, so it only asks
 * for dry quotes: a live price and time estimate, no deposit address, nothing to send. The browser calls 1Click
 * directly (it answers CORS with `*`).
 *
 * The step that would complete it on mainnet: the same request with `dry: false` returns `quote.depositAddress`; the
 * backer sends the origin asset there, and 1Click delivers wNEAR to the pool contract with `ft_transfer_call`
 * (`customRecipientMsg` = the join_pool message), or to an intermediate account that joins the pool for them.
 */

export const ONECLICK_API = (import.meta.env?.VITE_ONECLICK_API as string | undefined) ?? 'https://1click.chaindefuser.com';
/** wNEAR on NEAR mainnet: what the pools hold, as NEAR. */
export const WNEAR = 'nep141:wrap.near';
/**
 * Stand-in NEAR mainnet account for dry quotes, used as both recipient and refund account. A quote needs an existing
 * account registered with wrap.near (a made-up name fails); the price doesn't depend on which one. The mainnet pool
 * contract would take its place.
 */
export const QUOTE_ACCOUNT = 'near';
/** Price protection in basis points: the least that arrives is 1% under the quote. */
export const SLIPPAGE_BPS = 100;

export type IntentsToken = { assetId: string; decimals: number; blockchain: string; symbol: string; price: number; priceUpdatedAt?: string; contractAddress?: string };

/** One origin the UI offers: an asset on a chain, matched against the live token list. */
export type Origin = { chain: string; chainName: string; symbol: string; token: IntentsToken };

/** The short list the UI offers, in order: [1Click blockchain id, display name, symbols]. */
export const CURATED: readonly [string, string, readonly string[]][] = [
  ['eth', 'Ethereum', ['USDC', 'USDT', 'ETH']],
  ['base', 'Base', ['USDC', 'ETH']],
  ['arb', 'Arbitrum', ['USDC', 'ETH']],
  ['sol', 'Solana', ['SOL', 'USDC', 'USDT']],
  ['btc', 'Bitcoin', ['BTC']],
  ['tron', 'Tron', ['USDT']],
  ['doge', 'Dogecoin', ['DOGE']],
];

export type QuoteRequest = {
  dry: true;
  swapType: 'EXACT_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'INTENTS';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
};

/** A parsed quote. Amounts out are yoctoNEAR (wNEAR has 24 decimals, as NEAR). */
export type Quote = {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  amountInUsd: number;
  amountOutUsd: number;
  /** What the swap costs end to end (fees and price impact), in US dollars: value in minus value out. */
  costUsd: number;
  /** Seconds from deposit to delivery. */
  seconds: number;
  /** The fee 1Click itself takes, in basis points (charged without a partner key). */
  feeBps: number;
};

type RawQuote = {
  quote?: { amountIn?: string; amountOut?: string; minAmountOut?: string; amountInUsd?: string; amountOutUsd?: string; timeEstimate?: number };
  quoteRequest?: { appFees?: { fee?: number }[] };
  message?: string;
};

let tokensCache: Promise<IntentsToken[]> | null = null;

/** 1Click's asset list (fetched once per page load; a failure is retried next time). */
export function listTokens(fetchImpl: typeof fetch = fetch): Promise<IntentsToken[]> {
  if (fetchImpl !== fetch) return fetchTokens(fetchImpl);
  tokensCache ??= fetchTokens(fetchImpl).catch((e) => {
    tokensCache = null;
    throw e;
  });
  return tokensCache;
}

async function fetchTokens(fetchImpl: typeof fetch): Promise<IntentsToken[]> {
  const res = await fetchImpl(`${ONECLICK_API}/v0/tokens`);
  if (!res.ok) throw new Error(`NEAR Intents is unavailable (${res.status})`);
  const list = (await res.json()) as unknown;
  if (!Array.isArray(list)) throw new Error('NEAR Intents sent an unexpected token list');
  return list.filter((t): t is IntentsToken => !!t && typeof t.assetId === 'string' && typeof t.decimals === 'number' && typeof t.blockchain === 'string' && typeof t.symbol === 'string');
}

/** The curated origins found in the token list (anything missing from it is left out). */
export function origins(tokens: readonly IntentsToken[]): Origin[] {
  const out: Origin[] = [];
  for (const [chain, chainName, symbols] of CURATED)
    for (const symbol of symbols) {
      const token = tokens.find((t) => t.blockchain === chain && t.symbol === symbol);
      if (token) out.push({ chain, chainName, symbol, token });
    }
  return out;
}

/** "25.5" in an asset with `decimals` to base units; throws on anything else. */
export function toBaseUnits(text: string, decimals: number): bigint {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('Enter an amount like 25');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Base units to "0.15" (trailing zeros trimmed). */
export function fromBaseUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** The dry quote request for `amount` (base units) of `originAsset` into wNEAR. */
export function quoteRequest(originAsset: string, amount: bigint, now = Date.now()): QuoteRequest {
  return {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE_BPS,
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: WNEAR,
    amount: amount.toString(),
    refundTo: QUOTE_ACCOUNT,
    refundType: 'INTENTS',
    recipient: QUOTE_ACCOUNT,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + 10 * 60_000).toISOString(),
  };
}

/** A live dry quote: how much NEAR `amount` (base units) of `origin` would deliver. */
export async function quote(origin: IntentsToken, amount: bigint, fetchImpl: typeof fetch = fetch): Promise<Quote> {
  const res = await fetchImpl(`${ONECLICK_API}/v0/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(quoteRequest(origin.assetId, amount)),
  });
  let j: RawQuote;
  try {
    j = (await res.json()) as RawQuote;
  } catch {
    throw new Error(`NEAR Intents is unavailable (${res.status})`);
  }
  if (!res.ok || !j.quote) throw new Error(quoteError(j.message, origin) ?? `NEAR Intents couldn't price that (${res.status})`);
  return parseQuote(j);
}

export function parseQuote(j: RawQuote): Quote {
  const q = j.quote ?? {};
  if (!q.amountOut) throw new Error('NEAR Intents sent a quote without an amount');
  const amountInUsd = Number(q.amountInUsd ?? 0);
  const amountOutUsd = Number(q.amountOutUsd ?? 0);
  return {
    amountIn: BigInt(q.amountIn ?? '0'),
    amountOut: BigInt(q.amountOut),
    minAmountOut: BigInt(q.minAmountOut ?? q.amountOut),
    amountInUsd,
    amountOutUsd,
    costUsd: Math.max(0, amountInUsd - amountOutUsd),
    seconds: Number(q.timeEstimate ?? 0),
    feeBps: (j.quoteRequest?.appFees ?? []).reduce((s, f) => s + (Number(f.fee) || 0), 0),
  };
}

/** 1Click's error message in player words; null when there is nothing useful in it. */
export function quoteError(message: string | undefined, origin: IntentsToken): string | null {
  if (!message) return null;
  const low = message.match(/too low.*?at least (\d+)/i);
  if (low) return `Enter at least ${fromBaseUnits(BigInt(low[1]!), origin.decimals)} ${origin.symbol}.`;
  if (/internal server error/i.test(message)) return null;
  return message;
}

/** "about 40 s", "about 13 min". */
export function timeWords(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  return `about ${Math.round(seconds / 60)} min`;
}
