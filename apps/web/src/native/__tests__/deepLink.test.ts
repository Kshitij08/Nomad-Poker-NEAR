import { describe, expect, it } from 'vitest';
import { parseDeepLink, partyLink } from '../deepLink';

describe('deep links', () => {
  it('reads party and tournament links in every form', () => {
    expect(parseDeepLink('nomadpoker://join/abcd2345')).toEqual({ kind: 'party', code: 'ABCD2345' });
    expect(parseDeepLink('https://nomad-poker-web.vercel.app/join/ABCD2345')).toEqual({ kind: 'party', code: 'ABCD2345' });
    expect(parseDeepLink('https://nomad-poker-web.vercel.app/?net=ABCD2345')).toEqual({ kind: 'party', code: 'ABCD2345' });
    expect(parseDeepLink('nomadpoker://t/ubzk4j')).toEqual({ kind: 'tournament', code: 'UBZK4J' });
    expect(parseDeepLink('https://x.app/tournament/UBZK4J')).toEqual({ kind: 'tournament', code: 'UBZK4J' });
    expect(parseDeepLink('https://x.app/?trn=UBZK4J')).toEqual({ kind: 'tournament', code: 'UBZK4J' });
  });

  it('opens the app for anything else, never a half-valid code', () => {
    expect(parseDeepLink('nomadpoker://')).toEqual({ kind: 'open' });
    expect(parseDeepLink('nomadpoker://join/short')).toEqual({ kind: 'open' });
    expect(parseDeepLink('https://x.app/t/IIIIII')).toEqual({ kind: 'open' }); // I is not in the join alphabet
    expect(parseDeepLink('not a url')).toEqual({ kind: 'open' });
    expect(partyLink('https://nomad-poker-web.vercel.app/', 'ABCD2345')).toBe('https://nomad-poker-web.vercel.app/?net=ABCD2345');
  });
});
