/**
 * The title's legacy CloudScript (playfab/cloudscript/friends.js + economy.js) ported to run against an emulated
 * title (titleState.ts). Same handler names, the same argument shapes, the same `{ ok, error }` results and the
 * same rules (friend tags on both lists, the invite mailbox in read-only data, the ChipGrants protocol shared
 * with the chip ledger). The live title keeps running the real .js; this is what `?online=local` and the tests run.
 */
import { FriendInviteRules } from '@nomad/engine/social/friendRules';
import { PlayFabConfig } from '../config';
import { readGrantLog } from './chipLedger';
import { grantIdempotencyId, welcomeIdempotencyId } from './ids';
import { moveChips, setObject, type TitlePlayer, type TitleStateHandle } from './titleState';

export type CloudResult = Record<string, unknown> & { ok: boolean; error?: string };

export interface CloudContext {
  readonly title: TitleStateHandle;
  readonly currentPlayerId: string;
  readonly now: number; // epoch ms
}

type Handler = (args: Record<string, unknown>, ctx: CloudContext) => CloudResult;

const ok = (fields: Record<string, unknown> = {}): CloudResult => ({ ok: true, ...fields });
const fail = (code: string): CloudResult => ({ ok: false, error: code });

// ---- friends.js ---------------------------------------------------------------------------------------

const TAG_FRIEND = 'friend';
const TAG_IN = 'pending_in';
const TAG_OUT = 'pending_out';
const INVITES_KEY = 'Poker.Social.Invites';
const INVITE_TTL_SECONDS = FriendInviteRules.TtlSeconds;
const MAX_INVITES = 10;
const MAX_SESSION_LENGTH = 64;

interface Invite {
  from: string;
  name: string;
  session: string;
  money: boolean;
  at: number;
}

function normaliseId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.replace(/[-\s]/g, '').toUpperCase();
  return /^[0-9A-F]{16}$/.test(id) ? id : null;
}

function relationOf(tags: readonly string[] | undefined): string | null {
  if (!tags) return null;
  if (tags.includes(TAG_FRIEND)) return TAG_FRIEND;
  if (tags.includes(TAG_IN)) return TAG_IN;
  if (tags.includes(TAG_OUT)) return TAG_OUT;
  return null;
}

function link(ctx: CloudContext, owner: string, other: string, tag: string): void {
  const p = ctx.title.state.players[owner];
  if (!p) throw new Error('AccountNotFound');
  p.friends[other] = { tags: [tag] };
}

function unlink(ctx: CloudContext, owner: string, other: string): void {
  const p = ctx.title.state.players[owner];
  if (p) delete p.friends[other];
}

function readInvites(p: TitlePlayer, nowSec: number): Invite[] {
  const rec = p.readOnlyData[INVITES_KEY];
  if (!rec || !rec.Value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rec.Value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (inv): inv is Invite => !!inv && typeof inv.from === 'string' && typeof inv.at === 'number' && nowSec - inv.at < INVITE_TTL_SECONDS,
  );
}

function writeInvites(p: TitlePlayer, invites: Invite[], now: number): void {
  if (invites.length === 0) delete p.readOnlyData[INVITES_KEY];
  else p.readOnlyData[INVITES_KEY] = { Value: JSON.stringify(invites), LastUpdated: new Date(now).toISOString() };
}

const friendsHandlers: Record<string, Handler> = {
  sendFriendRequest(args, ctx) {
    const me = ctx.currentPlayerId;
    const target = normaliseId(args.friendId);
    if (!target) return fail('invalid_id');
    if (target === me) return fail('self');
    const relation = relationOf(ctx.title.state.players[me]?.friends[target]?.tags);
    if (relation === TAG_FRIEND) return fail('already_friends');
    if (relation === TAG_OUT) return fail('already_requested');
    if (relation === TAG_IN) {
      link(ctx, me, target, TAG_FRIEND);
      link(ctx, target, me, TAG_FRIEND);
      return ok({ relation: TAG_FRIEND });
    }
    if (!ctx.title.state.players[target]) return fail('not_found');
    link(ctx, me, target, TAG_OUT);
    link(ctx, target, me, TAG_IN);
    return ok({ relation: TAG_OUT });
  },

  acceptFriendRequest(args, ctx) {
    const me = ctx.currentPlayerId;
    const target = normaliseId(args.friendId);
    if (!target) return fail('invalid_id');
    const relation = relationOf(ctx.title.state.players[me]?.friends[target]?.tags);
    if (relation === TAG_FRIEND) return ok({ relation: TAG_FRIEND });
    if (relation !== TAG_IN) return fail('no_request');
    link(ctx, me, target, TAG_FRIEND);
    link(ctx, target, me, TAG_FRIEND);
    return ok({ relation: TAG_FRIEND });
  },

  removeFriend(args, ctx) {
    const target = normaliseId(args.friendId);
    if (!target) return fail('invalid_id');
    unlink(ctx, ctx.currentPlayerId, target);
    unlink(ctx, target, ctx.currentPlayerId);
    return ok({});
  },

  sendInvite(args, ctx) {
    const me = ctx.currentPlayerId;
    const target = normaliseId(args.friendId);
    if (!target) return fail('invalid_id');
    const session = typeof args.session === 'string' ? args.session.trim() : '';
    if (!session || session.length > MAX_SESSION_LENGTH) return fail('invalid_session');
    if (relationOf(ctx.title.state.players[me]?.friends[target]?.tags) !== TAG_FRIEND) return fail('not_friends');
    const targetPlayer = ctx.title.state.players[target];
    if (!targetPlayer) return fail('AccountNotFound');
    const nowSec = Math.floor(ctx.now / 1000);
    let invites = readInvites(targetPlayer, nowSec).filter((inv) => inv.from !== me);
    invites.push({ from: me, name: ctx.title.state.players[me]?.displayName ?? '', session, money: args.money === true, at: nowSec });
    if (invites.length > MAX_INVITES) invites = invites.slice(invites.length - MAX_INVITES);
    writeInvites(targetPlayer, invites, ctx.now);
    return ok({});
  },

  dismissInvite(args, ctx) {
    const from = normaliseId(args.fromId);
    if (!from) return fail('invalid_id');
    const me = ctx.title.state.players[ctx.currentPlayerId];
    if (!me) return fail('AccountNotFound');
    writeInvites(me, readInvites(me, Math.floor(ctx.now / 1000)).filter((inv) => inv.from !== from), ctx.now);
    return ok({});
  },
};

// ---- economy.js ---------------------------------------------------------------------------------------

const GRANTS_OBJECT = 'ChipGrants';
const GRANT_LOG_LIMIT = 200;
const GRANT_MAX_AGE_DAYS = 7;

function levelUpAmounts(maxLevel: number): number[] {
  const amounts: number[] = [];
  for (let level = 2; level <= maxLevel; level++) {
    const coins = 100 + (level - 1) * 25;
    amounts.push(level % 10 === 0 ? coins * 2 : coins);
  }
  return amounts;
}

/** economy.js RULES: the amounts each catalog really pays, and the per-UTC-day cap per source. */
export const GRANT_RULES: Readonly<Record<string, { amounts: readonly number[]; perDay: number }>> = {
  daily_spin: { amounts: [250, 500, 1000, 2000, 5000, 10000, 25000], perDay: 1 },
  login_reward: { amounts: [500, 750, 1000, 2500], perDay: 1 },
  mission: { amounts: [500, 750, 400, 300, 1000, 2500, 3000, 2000], perDay: 8 },
  level_up: { amounts: levelUpAmounts(500), perDay: 20 },
};

interface ParsedKey {
  source: string;
  player: string;
  day: string;
  kind: string;
  amount: string;
  item: string;
}

export function parseGrantKey(key: string): ParsedKey | null {
  const parts = String(key || '').split(':');
  if (parts.length !== 6) return null;
  const [source, player, day, kind, amount, item] = parts as [string, string, string, string, string, string];
  return { source, player, day, kind, amount, item };
}

/** Null when the grant may be paid, else the error code. */
export function checkGrant(parsed: ParsedKey | null, chips: number, reason: string, currentPlayerId: string, now: number): string | null {
  if (!parsed || parsed.source !== reason || !Object.prototype.hasOwnProperty.call(GRANT_RULES, parsed.source)) return 'invalid_grant';
  if (parsed.player.toUpperCase() !== String(currentPlayerId).toUpperCase()) return 'invalid_grant';
  if (parsed.kind !== 'Coins' || parsed.item !== '' || String(chips) !== parsed.amount) return 'invalid_grant';
  if (!GRANT_RULES[parsed.source]!.amounts.includes(chips)) return 'invalid_grant';
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed.day);
  if (!day) return 'invalid_grant';
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const age = Math.round((today - Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!)) / 86400000);
  if (age < -1) return 'invalid_grant';
  if (age > GRANT_MAX_AGE_DAYS) return 'too_old';
  return null;
}

function paidThatDay(keys: readonly string[], parsed: ParsedKey): number {
  const prefix = `${parsed.source}:${parsed.player}:${parsed.day}:`.toUpperCase();
  return keys.filter((k) => String(k).toUpperCase().indexOf(prefix) === 0).length;
}

/** Steps 2 and 3 of the welcome: claim the flag by compare-and-set, then pay with the shared IdempotencyId. */
function welcome(ctx: CloudContext, p: TitlePlayer): CloudResult {
  const version = p.profileVersion;
  const grants = readGrantLog(p);
  if (grants.welcomed) return ok({ granted: false, reason: 'already_welcomed' });
  grants.welcomed = true;
  if (!setObject(p, GRANTS_OBJECT, grants, version)) return ok({ granted: false, reason: 'claimed_elsewhere' });
  moveChips(p, PlayFabConfig.StartingBalance, welcomeIdempotencyId(ctx.currentPlayerId));
  return ok({ granted: true, chips: PlayFabConfig.StartingBalance });
}

const economyHandlers: Record<string, Handler> = {
  grantStartingChips(_args, ctx) {
    const p = ctx.title.state.players[ctx.currentPlayerId];
    if (!p) return fail('no_title_player');
    return welcome(ctx, p);
  },

  claimRetentionGrant(args, ctx) {
    const key = typeof args.key === 'string' ? args.key : '';
    const chips = typeof args.chips === 'number' ? args.chips : NaN;
    const reason = typeof args.reason === 'string' ? args.reason : '';
    const parsed = parseGrantKey(key);
    const refused = checkGrant(parsed, chips, reason, ctx.currentPlayerId, ctx.now);
    if (refused) return fail(refused);

    const p = ctx.title.state.players[ctx.currentPlayerId];
    if (!p) return fail('no_title_player');
    if (p.chips === null) {
      const welcomed = welcome(ctx, p);
      if (!welcomed.ok) return welcomed;
    }
    const version = p.profileVersion;
    const grants = readGrantLog(p);
    if (grants.keys.includes(key)) return ok({ granted: false, balance: Math.max(p.chips ?? -1, 0) });
    if (paidThatDay(grants.keys, parsed!) >= GRANT_RULES[parsed!.source]!.perDay) return fail('daily_limit');

    grants.keys.push(key);
    if (grants.keys.length > GRANT_LOG_LIMIT) grants.keys = grants.keys.slice(grants.keys.length - GRANT_LOG_LIMIT);
    if (!setObject(p, GRANTS_OBJECT, grants, version)) return fail('busy');
    if (!moveChips(p, chips, grantIdempotencyId(ctx.currentPlayerId, key))) {
      grants.keys.splice(grants.keys.indexOf(key), 1);
      setObject(p, GRANTS_OBJECT, grants, null);
      return fail('grant_failed');
    }
    return ok({ granted: true, balance: p.chips });
  },
};

const HANDLERS: Record<string, Handler> = { ...friendsHandlers, ...economyHandlers };

/** Null = no such handler (PlayFab: CloudScriptNotFound). Persists the title after the handler ran. */
export function runCloudScript(ctx: CloudContext, functionName: string, args: unknown): CloudResult | null {
  const handler = HANDLERS[functionName];
  if (!handler) return null;
  let result: CloudResult;
  try {
    result = handler((args && typeof args === 'object' ? args : {}) as Record<string, unknown>, ctx);
  } catch (e) {
    result = fail(e instanceof Error && /^[A-Za-z]+$/.test(e.message) ? e.message : 'server_error');
  }
  ctx.title.save();
  return result;
}
