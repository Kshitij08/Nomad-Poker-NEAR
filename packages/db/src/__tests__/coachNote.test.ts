import { describe, expect, it } from 'vitest';
import { coach, coachNote, COACH_DEFAULT_MODEL, NEAR_AI_CHAT } from '../style/coach';

const report = { ...coach([], []), hands: 40 };

describe('coachNote (NEAR AI Cloud)', () => {
  it('asks NEAR AI with the key, the private model and thinking off, and returns its words', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '<think></think>Nice work. Raise more.' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const n = await coachNote(report, { apiKey: 'k', fetch: fake });
    expect(n).toEqual({ text: 'Nice work. Raise more.', model: COACH_DEFAULT_MODEL });
    expect(seen!.url).toBe(NEAR_AI_CHAT);
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(String(seen!.init.body));
    expect(body.model).toBe(COACH_DEFAULT_MODEL);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[1].content).toContain('"hands":40');
  });

  it('writes nothing without a key, under 20 hands, or when NEAR AI fails', async () => {
    const boom = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    expect(await coachNote(report, {})).toBeNull();
    expect(await coachNote({ ...report, hands: 5 }, { apiKey: 'k', fetch: boom })).toBeNull();
    expect(await coachNote(report, { apiKey: 'k', fetch: boom })).toBeNull();
  });
});

describe('shortNote', () => {
  it('keeps at most 3 sentences and 70 words', async () => {
    const { shortNote } = await import('../style/coach');
    const long = 'One two three. Four five six! Seven eight nine? Ten eleven twelve. Thirteen.';
    expect(shortNote(long)).toBe('One two three. Four five six! Seven eight nine?');
    const wordy = Array.from({ length: 50 }, () => 'word').join(' ') + '. ' + Array.from({ length: 50 }, () => 'more').join(' ') + '.';
    expect(shortNote(wordy).split(' ').length).toBeLessThanOrEqual(70);
    expect(shortNote('<think>x</think> Fold more.')).toBe('Fold more.');
  });
});
