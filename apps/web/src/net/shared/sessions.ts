import { StakeCatalog, type StakeTier } from '@nomad/engine/stakes/stakes';

/**
 * Session naming and table-mode constants: ports of Core/Stakes/StakeSessionNames.cs, the parts of
 * Net/Chain/ChainTableMode.cs the free (Coins) tables use, FusionMenuPartyCodeGenerator and PokerMatchmaking.
 * Shared by the local table server and the client so both read a session name the same way.
 */

export const StakeSessionNames = {
  FreeRoot: 'poker-free',
  MoneyRoot: 'poker-money',

  root(money: boolean): string {
    return money ? StakeSessionNames.MoneyRoot : StakeSessionNames.FreeRoot;
  },

  /** Quick Play pool for a stake: the default 1,000 keeps `poker-free`, others are `poker-free-st50`. */
  primary(money: boolean, minBuyIn: number): string {
    const root = StakeSessionNames.root(money);
    if (minBuyIn <= 0 || minBuyIn === StakeCatalog.DefaultMinBuyIn) return root;
    return `${root}-st${minBuyIn}`;
  },

  /** Overflow table `n` (1-based) of a pool: `poker-free-2`, `poker-free-st50-2`, … */
  overflow(money: boolean, minBuyIn: number, index: number): string {
    return `${StakeSessionNames.primary(money, minBuyIn)}-${index}`;
  },

  tryParse(sessionName: string | null | undefined): { ok: boolean; minBuyIn: number; overflowIndex: number } {
    const fail = { ok: false, minBuyIn: StakeCatalog.DefaultMinBuyIn, overflowIndex: 0 };
    if (!sessionName) return fail;
    let rest = startsRoot(sessionName, StakeSessionNames.FreeRoot) ?? startsRoot(sessionName, StakeSessionNames.MoneyRoot);
    if (rest === null) return fail;
    if (rest.length === 0) return { ok: true, minBuyIn: StakeCatalog.DefaultMinBuyIn, overflowIndex: 0 };
    if (rest[0] !== '-') return fail;
    rest = rest.substring(1);
    if (rest.length >= 2 && (rest[0] === 's' || rest[0] === 'S') && (rest[1] === 't' || rest[1] === 'T')) {
      rest = rest.substring(2);
      const dash = rest.indexOf('-');
      const buy = positive(dash < 0 ? rest : rest.substring(0, dash));
      if (buy === null || !StakeCatalog.isKnown(buy)) return fail;
      if (dash < 0) return { ok: true, minBuyIn: buy, overflowIndex: 0 };
      const idx = positive(rest.substring(dash + 1));
      return idx === null ? { ok: false, minBuyIn: buy, overflowIndex: 0 } : { ok: true, minBuyIn: buy, overflowIndex: idx };
    }
    const idx = positive(rest);
    if (idx === null) return fail;
    return { ok: true, minBuyIn: StakeCatalog.DefaultMinBuyIn, overflowIndex: idx };
  },

  parseMinBuyIn(sessionName: string): number {
    return StakeSessionNames.tryParse(sessionName).minBuyIn;
  },

  isPrimary(sessionName: string): boolean {
    const p = StakeSessionNames.tryParse(sessionName);
    return p.ok && p.overflowIndex === 0;
  },

  isOverflow(sessionName: string): boolean {
    const p = StakeSessionNames.tryParse(sessionName);
    return p.ok && p.overflowIndex > 0;
  },

  isPool(sessionName: string): boolean {
    return StakeSessionNames.tryParse(sessionName).ok;
  },
};

function startsRoot(session: string, root: string): string | null {
  if (session.length < root.length) return null;
  if (session.substring(0, root.length).toLowerCase() !== root.toLowerCase()) return null;
  if (session.length > root.length && session[root.length] !== '-') return null;
  return session.substring(root.length);
}

function positive(raw: string): number | null {
  if (!raw || raw[0] === '0') return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/** The ChainTableMode constants Coins tables use. */
export const ChainTableMode = {
  KindProperty: 'kind',
  KindQuick: 'quick',
  KindPrivate: 'private',
  StakeProperty: 'stake',
  /** Dedicated tables always register in India (Photon region "in"). */
  DedicatedRegion: 'in',
  PrivateMinBuyIn: 500,
  PrivateMaxBuyIn: 1000,
  PrivateSmallBlind: 5,
  PrivateBigBlind: 10,

  /** Snap a requested private buy-in into 500–1,000. An empty request sits at the top. */
  clampPrivateBuyIn(requested: number): number {
    if (requested <= 0 || requested > ChainTableMode.PrivateMaxBuyIn) return ChainTableMode.PrivateMaxBuyIn;
    if (requested < ChainTableMode.PrivateMinBuyIn) return ChainTableMode.PrivateMinBuyIn;
    return requested;
  },

  isQuickPlayPoolSession(name: string): boolean {
    return StakeSessionNames.isPool(name);
  },

  isQuickPlayOverflowSession(name: string): boolean {
    return StakeSessionNames.isOverflow(name);
  },

  /** TournamentLaunch.IsTournamentSession: tournament sessions start with "TRN". */
  isTournamentSession(name: string | null | undefined): boolean {
    return !!name && name.startsWith('TRN');
  },

  /** Stake a table plays, from its `stake` property or its session name. */
  resolveStake(sessionName: string, stakeProperty?: string | null): StakeTier {
    let minBuyIn = StakeCatalog.DefaultMinBuyIn;
    if (stakeProperty != null) {
      const n = Number.parseInt(stakeProperty, 10);
      if (Number.isFinite(n) && StakeCatalog.isKnown(n)) minBuyIn = n;
    } else if (sessionName) minBuyIn = StakeSessionNames.parseMinBuyIn(sessionName);
    return StakeCatalog.get(minBuyIn);
  },

  /** A create / join-by-code room: not a Quick Play pool and not a tournament. */
  isPrivateSession(name: string, kind?: string | null): boolean {
    if (kind) return kind === ChainTableMode.KindPrivate;
    if (!name) return false;
    if (StakeSessionNames.isPool(name)) return false;
    if (ChainTableMode.isTournamentSession(name)) return false;
    return true;
  },
};

/** FusionMenuPartyCodeGenerator (Resources/FusionMenuPartyCodeGenerator.asset: 8 characters, no 0/O). */
export const PartyCodes: {
  ValidCharacters: string;
  Length: number;
  create(length?: number, valid?: string, random?: (bytes: Uint8Array) => void): string;
  isValid(code: string | null | undefined): boolean;
} = {
  ValidCharacters: 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789',
  Length: 8,

  create(length = PartyCodes.Length, valid = PartyCodes.ValidCharacters, random: (bytes: Uint8Array) => void = (b) => crypto.getRandomValues(b)): string {
    length = Math.max(1, Math.min(length, 128));
    const m = Math.floor(255 / valid.length) * valid.length; // highest multiple of the alphabet size in a byte
    let res = '';
    const bytes = new Uint8Array(8);
    while (res.length !== length) {
      random(bytes);
      for (const b of bytes) {
        if (b >= m || res.length === length) continue;
        res += valid[b % valid.length];
      }
    }
    return res;
  },

  isValid(code: string | null | undefined): boolean {
    if (!code || code.length !== PartyCodes.Length) return false;
    for (const c of code) if (!PartyCodes.ValidCharacters.includes(c)) return false;
    return true;
  },
};

/** PokerMatchmaking.AppVersion for the local universe (never the live "1.0"). */
export const LOCAL_APP_VERSION = '1.0-web-local';

/** Fusion session size: PokerMenuConnection.TableSeats (connections, spectators included). */
export const MAX_PLAYERS_PER_SESSION = 8;
