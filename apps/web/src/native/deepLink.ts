/**
 * Deep links into the store apps and the web (Phase 8): what a shared link asks for. Pure, so it is tested without a
 * device. Recognised forms (any host for https links; the app's own scheme `nomadpoker://`):
 *   …/join/<PARTYCODE>      a party table (8 letters/digits)       → { kind: 'party', code }
 *   …/t/<JOINCODE>          a tournament by its 6-letter code      → { kind: 'tournament', code }
 *   …?net=<PARTYCODE>       the web's existing join flag           → { kind: 'party', code }
 *   …?trn=<JOINCODE>                                               → { kind: 'tournament', code }
 *   anything else                                                  → { kind: 'open' } (just open the app)
 */
export type DeepLink = { kind: 'party'; code: string } | { kind: 'tournament'; code: string } | { kind: 'open' };

const PARTY = /^[A-Z0-9]{8}$/;
const TOURNAMENT = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export function parseDeepLink(raw: string): DeepLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'open' };
  }
  // nomadpoker://join/ABCD2345 parses with host "join"; https links carry it in the path.
  const parts = [url.protocol === 'https:' || url.protocol === 'http:' ? '' : url.host, ...url.pathname.split('/')].filter(Boolean).map(decodeURIComponent);
  const party = (c: string | undefined): DeepLink | null => (c && PARTY.test(c.toUpperCase()) ? { kind: 'party', code: c.toUpperCase() } : null);
  const trn = (c: string | undefined): DeepLink | null => (c && TOURNAMENT.test(c.toUpperCase()) ? { kind: 'tournament', code: c.toUpperCase() } : null);
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!.toLowerCase();
    if (key === 'join') return party(parts[i + 1]) ?? { kind: 'open' };
    if (key === 't' || key === 'tournament') return trn(parts[i + 1]) ?? { kind: 'open' };
  }
  return party(url.searchParams.get('net') ?? undefined) ?? trn(url.searchParams.get('trn') ?? undefined) ?? { kind: 'open' };
}

/** The https link a player shares for a party table (the store apps open it; the web joins it via ?net=). */
export function partyLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/?net=${encodeURIComponent(code)}`;
}
