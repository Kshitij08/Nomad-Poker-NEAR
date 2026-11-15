import { describe, expect, it } from 'vitest';
import { WNEAR, fromBaseUnits, listTokens, origins, quote, quoteRequest, timeWords, toBaseUnits, type IntentsToken } from '../intents';

const BASE_USDC: IntentsToken = { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 0.9997 };
const TOKENS: IntentsToken[] = [
  { assetId: WNEAR, decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 2.99 },
  BASE_USDC,
  { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 68.77 },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 62761 },
];

/** A real dry-quote answer from 1Click (15 Nov 2026), trimmed. */
const ANSWER = {
  quote: {
    amountIn: '25000000', amountInFormatted: '25.0', amountInUsd: '24.993325000000', minAmountIn: '25000000',
    amountOut: '8281252961258704288563829', amountOutFormatted: '8.281252961258704288563829', amountOutUsd: '24.760946354164',
    minAmountOut: '8198440431646117245678190', timeEstimate: 37, refundFee: '2400', withdrawFee: '0',
  },
  quoteRequest: { dry: true, appFees: [{ recipient: '5880ad2b', fee: 20 }] },
  signature: 'ed25519:47MP', timestamp: '2026-11-15T01:13:48.269Z',
};

function fake(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('NEAR Intents tokens', () => {
  it('lists tokens and picks the curated origins in order, skipping ones the list lacks', async () => {
    const { fetchImpl, calls } = fake(200, [...TOKENS, { junk: true }]);
    const tokens = await listTokens(fetchImpl);
    expect(calls[0]!.url).toBe('https://1click.chaindefuser.com/v0/tokens');
    expect(tokens).toHaveLength(4);
    expect(origins(tokens).map((o) => `${o.chainName} ${o.symbol}`)).toEqual(['Base USDC', 'Solana SOL', 'Bitcoin BTC']);
  });
});

describe('NEAR Intents quotes', () => {
  it('asks for a dry quote into wNEAR with the documented fields', async () => {
    const { fetchImpl, calls } = fake(201, ANSWER);
    await quote(BASE_USDC, 25_000_000n, fetchImpl);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://1click.chaindefuser.com/v0/quote');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: BASE_USDC.assetId, depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:wrap.near', amount: '25000000', refundType: 'INTENTS', recipientType: 'DESTINATION_CHAIN',
    });
    expect(Date.parse(body.deadline)).toBeGreaterThan(Date.now());
  });

  it('parses amounts, cost, time and the fee', async () => {
    const q = await quote(BASE_USDC, 25_000_000n, fake(201, ANSWER).fetchImpl);
    expect(q.amountOut).toBe(8281252961258704288563829n);
    expect(q.minAmountOut).toBe(8198440431646117245678190n);
    expect(q.costUsd).toBeCloseTo(0.2324, 3);
    expect(q.seconds).toBe(37);
    expect(q.feeBps).toBe(20);
  });

  it('turns a too-small amount into the minimum in the origin asset', async () => {
    const { fetchImpl } = fake(400, { message: 'Amount is too low for bridge, try at least 150000' });
    await expect(quote(BASE_USDC, 1000n, fetchImpl)).rejects.toThrow('Enter at least 0.15 USDC.');
  });

  it('hides a bare server error', async () => {
    const { fetchImpl } = fake(400, { message: 'Internal server error' });
    await expect(quote(BASE_USDC, 1n, fetchImpl)).rejects.toThrow("NEAR Intents couldn't price that (400)");
  });

  it('builds a deadline ten minutes out', () => {
    expect(quoteRequest('x', 1n, 0).deadline).toBe('1970-01-01T00:10:00.000Z');
  });
});

describe('amounts and words', () => {
  it('converts to and from base units', () => {
    expect(toBaseUnits('25', 6)).toBe(25_000_000n);
    expect(toBaseUnits('0.15', 6)).toBe(150_000n);
    expect(() => toBaseUnits('0.0000001', 6)).toThrow('at most 6');
    expect(() => toBaseUnits('abc', 6)).toThrow();
    expect(fromBaseUnits(150_000n, 6)).toBe('0.15');
    expect(fromBaseUnits(25_000_000n, 6)).toBe('25');
  });

  it('says time in seconds or minutes', () => {
    expect(timeWords(37)).toBe('about 37 s');
    expect(timeWords(805)).toBe('about 13 min');
  });
});
