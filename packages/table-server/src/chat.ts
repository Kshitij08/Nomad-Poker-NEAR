/**
 * Ports of Core/Chat/PokerChatRateLimiter.cs and Core/Chat/PokerChatText.cs (+ PokerChatSettings constants). DOM-free:
 * the table server uses the limiter for reactions/voice/avatars, the client for chat and the reaction tray.
 */

/**
 * A token bucket: a short burst, then a drip. Takes the current time (seconds) as a parameter so it is testable
 * without waiting. Defaults are chat's (3 tokens, one per 1.5 s).
 */
export class PokerChatRateLimiter {
  private tokens: number;
  private lastRefill = 0;
  private started = false;

  constructor(private readonly capacity = 3, private readonly refillSeconds = 1.5) {
    if (capacity < 1) throw new RangeError('capacity');
    if (refillSeconds <= 0) throw new RangeError('refillSeconds');
    this.tokens = capacity;
  }

  /** Whole tokens available right now. */
  get available(): number {
    return Math.floor(this.tokens);
  }

  /** Spends a token if there is one. False means the caller must not send. */
  tryConsume(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Zero when a send is allowed; otherwise how long until the next token lands. */
  secondsUntilNextToken(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return (1 - this.tokens) * this.refillSeconds;
  }

  /** Back to a full bucket (a new table). */
  reset(): void {
    this.tokens = this.capacity;
    this.started = false;
  }

  private refill(now: number): void {
    // The first call establishes the baseline, so a large starting clock does not refill instantly.
    if (!this.started) {
      this.started = true;
      this.lastRefill = now;
      return;
    }
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return; // a clock that went backwards must not grant tokens
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.refillSeconds);
  }
}

/** PokerChatSettings. */
export const PokerChatSettings = {
  HistoryCount: 20,
  LogCapacity: 60,
  PaletteSize: 6,
};

export interface ChatPayload {
  name: string;
  body: string;
}

const NO_PARSE_CLOSE = '</noparse>';

/** Port of PokerChatText: sanitizing, wire format, channel naming and the sender colour hash. */
export const PokerChatText = {
  MaxLength: 200,

  /** One line, collapsed whitespace, no control characters, no `</noparse>` escape, at most MaxLength. */
  sanitize(raw: string | null | undefined): string {
    if (!raw) return '';
    let out = '';
    let lastWasSpace = true; // leading whitespace is a run to collapse away
    for (const c of raw) {
      const code = c.charCodeAt(0);
      const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      const ch = c === '\r' || c === '\n' || c === '\t' || isControl ? ' ' : c;
      if (ch === ' ') {
        if (lastWasSpace) continue;
        lastWasSpace = true;
      } else lastWasSpace = false;
      out += ch;
    }
    out = out.replace(/ +$/, '');
    let text = stripNoParseClose(out);
    if (text.length > PokerChatText.MaxLength) text = text.substring(0, PokerChatText.MaxLength).trimEnd();
    return text;
  },

  encode(name: string | null | undefined, body: string | null | undefined): [string, string] {
    return [name ?? '', body ?? ''];
  },

  decode(message: unknown, senderUserId: string | null | undefined): ChatPayload {
    const fallback = PokerChatText.fallbackName(senderUserId);
    if (Array.isArray(message)) {
      if (message.length >= 2) return { name: sanitizeName(String(message[0] ?? ''), fallback), body: PokerChatText.sanitize(String(message[1] ?? '')) };
      if (message.length === 1) return { name: fallback, body: PokerChatText.sanitize(String(message[0] ?? '')) };
    }
    if (typeof message === 'string') return { name: fallback, body: PokerChatText.sanitize(message) };
    if (message == null) return { name: fallback, body: '' };
    return { name: fallback, body: PokerChatText.sanitize(String(message)) };
  },

  fallbackName(userId: string | null | undefined): string {
    if (!userId) return 'Player';
    return 'Player ' + (userId.length <= 4 ? userId : userId.substring(0, 4));
  },

  channelName(appVersion: string, region: string, session: string): string {
    return `poker.${segment(appVersion, '0', true)}.${segment(region, 'unknown', true)}.${segment(session, 'none', true)}`;
  },

  voiceChannelName(appVersion: string, region: string, session: string): string {
    return `poker-${segment(appVersion, '0', false)}-${segment(region, 'unknown', false)}-${segment(session, 'none', false)}`;
  },

  /** FNV-1a over UTF-16 code units, mod paletteSize (uint arithmetic like the C#). */
  colorIndex(userId: string | null | undefined, paletteSize: number): number {
    if (paletteSize <= 1 || !userId) return 0;
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < userId.length; i++) {
      hash ^= userId.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash % paletteSize;
  },
};

function sanitizeName(name: string, fallback: string): string {
  let clean = PokerChatText.sanitize(name);
  if (clean.length > 32) clean = clean.substring(0, 32).trimEnd();
  return clean || fallback;
}

function stripNoParseClose(text: string): string {
  let lower = text.toLowerCase();
  let index = lower.indexOf(NO_PARSE_CLOSE);
  while (index >= 0) {
    text = text.substring(0, index) + text.substring(index + NO_PARSE_CLOSE.length);
    lower = text.toLowerCase();
    const resume = Math.max(0, index - (NO_PARSE_CLOSE.length - 1));
    index = lower.indexOf(NO_PARSE_CLOSE, resume);
  }
  return text;
}

function segment(s: string | null | undefined, fallback: string, allowUnderscore: boolean): string {
  if (!s || !s.trim()) return fallback;
  const replacement = allowUnderscore ? '_' : '-';
  let out = '';
  for (const c of s) {
    const lower = c.toLowerCase();
    const keep = (lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9') || lower === '-' || (lower === '_' && allowUnderscore);
    out += keep ? lower : replacement;
  }
  return out;
}
