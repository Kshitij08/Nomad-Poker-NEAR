import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopClient } from '../shopClient';
import type { AppContext } from '../../app/app';

function ctxWith(call: (method: string, path: string) => Promise<unknown>): { ctx: AppContext; emit: (ev: string) => void } {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const events = {
    on: (ev: string, fn: (p: unknown) => void) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
      return () => undefined;
    },
    emit: (ev: string, p?: unknown) => (handlers.get(ev) ?? []).forEach((f) => f(p)),
  };
  const ctx = { services: { nomadApi: { signedIn: true, call } }, events } as unknown as AppContext;
  return { ctx, emit: (ev) => events.emit(ev) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('ShopClient catalogue loading', () => {
  it('a server without the shop is asked once, then not again until the backoff passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const call = vi.fn(async () => {
      throw Object.assign(new Error('No such route.'), { status: 404, code: 'not_found' });
    });
    const { ctx } = ctxWith(call);
    const c = new ShopClient(ctx);
    let renders = 0;
    const render = () => {
      renders++;
      c.ensure(render); // the screen re-renders after every load, which calls ensure again
    };
    c.ensure(render);
    for (let i = 0; i < 5; i++) await flush();
    expect(call).toHaveBeenCalledTimes(1);
    expect(renders).toBe(1);
    // Within the backoff nothing new goes out, however often the screen renders.
    for (let i = 0; i < 50; i++) c.ensure(render);
    await flush();
    expect(call).toHaveBeenCalledTimes(1);
    // After it, one more try.
    vi.setSystemTime(1_000_000 + 46_000);
    c.ensure(render);
    for (let i = 0; i < 5; i++) await flush();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('only one request is in flight, even with a forced reload', async () => {
    let resolve!: (v: unknown) => void;
    const call = vi.fn(() => new Promise((r) => (resolve = r)));
    const { ctx } = ctxWith(call);
    const c = new ShopClient(ctx);
    c.ensure(() => undefined, true);
    c.ensure(() => undefined, true);
    c.ensure(() => undefined);
    expect(call).toHaveBeenCalledTimes(1);
    resolve({ items: [], owned: [], xpBoostUntil: null, solEnabled: false });
    await flush();
    expect(c.catalog?.owned).toEqual([]);
  });

  it('an account change clears the backoff and the catalogue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(5_000_000);
    const call = vi.fn(async () => {
      throw Object.assign(new Error('down'), { status: 503 });
    });
    const { ctx, emit } = ctxWith(call);
    const c = new ShopClient(ctx);
    c.ensure(() => undefined);
    for (let i = 0; i < 5; i++) await flush();
    emit('nomad:changed');
    c.ensure(() => undefined);
    for (let i = 0; i < 5; i++) await flush();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
