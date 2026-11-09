/** The support page's API client: the session it borrows, how a non-admin is told apart, and the adjust checks. */
import { describe, expect, it } from 'vitest';
import { AdminApi, AdminError, adjustProblem, newRequestId, sessionKey, signed, type Fetch } from '../api';

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string };
function fake(answer: (s: Sent) => { status: number; body: unknown }): { fetcher: Fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetcher: async (url, init) => {
      const s = { url, ...init };
      sent.push(s);
      const a = answer(s);
      return { status: a.status, json: async () => a.body };
    },
  };
}

describe('AdminApi', () => {
  it("uses the game's session for that API", () => {
    expect(sessionKey('https://api.test')).toBe('nomad.session:https://api.test');
  });

  it('sends the bearer token and reads the role', async () => {
    const f = fake(() => ({ status: 200, body: { player_id: 'p_1', role: 'admin' } }));
    const api = new AdminApi('https://api.test', 'np_tok', f.fetcher);
    expect(await api.whoAmI()).toEqual({ player_id: 'p_1', role: 'admin' });
    expect(f.sent[0]!.url).toBe('https://api.test/v1/admin/me');
    expect(f.sent[0]!.headers.authorization).toBe('Bearer np_tok');
  });

  it('a 404 from /v1/admin/me means "not an admin"; elsewhere it stays a 404', async () => {
    const f = fake(() => ({ status: 404, body: { error: { code: 'not_found', message: 'No such route.' } } }));
    const api = new AdminApi('https://api.test', 'np_tok', f.fetcher);
    await expect(api.whoAmI()).rejects.toMatchObject({ code: 'not_admin' });
    await expect(api.player('p_missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('without a session it asks to sign in, and sends nothing', async () => {
    const f = fake(() => ({ status: 200, body: {} }));
    await expect(new AdminApi('https://api.test', null, f.fetcher).search('x')).rejects.toBeInstanceOf(AdminError);
    expect(f.sent).toHaveLength(0);
  });

  it("passes the server's message through (e.g. support trying to adjust)", async () => {
    const f = fake(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'Only admins can adjust balances.' } } }));
    await expect(new AdminApi('https://api.test', 't', f.fetcher).adjust('p_1', 'coins', 5, 'test')).rejects.toThrow('Only admins can adjust balances.');
  });

  it('adjust sends a retry-safe request id and encodes the player id', async () => {
    const f = fake(() => ({ status: 200, body: { balances: { coins: 105 } } }));
    await new AdminApi('https://api.test', 't', f.fetcher).adjust('p_a/b', 'coins', 5, 'refund');
    expect(f.sent[0]!.url).toBe('https://api.test/v1/admin/players/p_a%2Fb/adjust');
    const body = JSON.parse(f.sent[0]!.body!);
    expect(body).toMatchObject({ currency: 'coins', delta: 5, reason: 'refund' });
    expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it('a network failure reads as one', async () => {
    const api = new AdminApi('https://api.test', 't', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.audit()).rejects.toMatchObject({ code: 'network' });
  });
});

describe('adjust checks (the server checks the same)', () => {
  it('needs a currency, a whole non-zero amount and a reason', () => {
    expect(adjustProblem('coins', 250, 'crash refund')).toBeNull();
    expect(adjustProblem('dollars', 250, 'crash refund')).toMatch(/currency/);
    expect(adjustProblem('coins', 0, 'crash refund')).toMatch(/not zero/);
    expect(adjustProblem('coins', 1.5, 'crash refund')).toMatch(/whole/);
    expect(adjustProblem('coins', 200_000_000, 'crash refund')).toMatch(/100,000,000/);
    expect(adjustProblem('coins', -5, 'ok')).toMatch(/Say why/);
  });
  it('shows the sign', () => {
    expect(signed(1250)).toBe('+1,250');
    expect(signed(-300)).toBe('−300');
  });
});
