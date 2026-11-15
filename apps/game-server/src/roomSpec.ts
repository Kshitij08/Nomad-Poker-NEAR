import type { RoomSpec } from '@nomad/table-server/rooms';
import { ChainTableMode, PartyCodes, StakeSessionNames } from '@nomad/table-server/sessions';
import { StakeCatalog } from '@nomad/engine/stakes/stakes';
import type { JoinFailReason } from '@nomad/table-server/protocol';
import { isTournamentSessionName } from '@nomad/db/tournaments';

/** The NEAR house tables: `poker-money-st<stake>` rooms, one per stake (no overflow tables). */
export const NEAR_MONEY_STAKES = [50, 100, 500] as const;
/** A table a player hosts on the escrow: `poker-money-st<stake>-h<8 of a-z0-9>` (its escrow table id). */
const NEAR_HOSTED = /^poker-money-st(\d+)-h[a-z0-9]{8}$/;

export function isNearMoneyRoom(session: string): boolean {
  return (NEAR_MONEY_STAKES as readonly number[]).some((s) => session === `${StakeSessionNames.MoneyRoot}-st${s}`) || isNearHostedRoom(session);
}

export function isNearHostedRoom(session: string): boolean {
  const m = NEAR_HOSTED.exec(session);
  return !!m && (NEAR_MONEY_STAKES as readonly number[]).includes(Number(m[1]));
}

/** A NEAR table's stake (min buy-in in chips), from its room name. */
export function nearRoomStake(session: string): number {
  return Number(/^poker-money-st(\d+)/.exec(session)?.[1] ?? 0);
}

/**
 * Which room a session name means, for the game server. One Durable Object per session name:
 * - Quick Play pools and their overflow tables (`poker-free`, `poker-free-st50-2`) open on first join;
 * - party rooms (8-character codes) must be spawned first, as PokerDedicatedPartySpawner did;
 * - `qa-…` rooms exist only where QA rooms are switched on (staging): Quick Play tables for test harnesses, at the
 *   default stake or at the one a `-st<stake>` suffix names (`qa-soak-1-st100`);
 * - hosted tournaments (`TRN` + 10) are one room each, holding every table of the tournament;
 * - NEAR money tables (`poker-money-st<stake>`, hosted `-h<id>`) open only on a NEAR escrow operator.
 * Every room here is a "child": it closes after idling empty, and the next join opens it again.
 */

export interface RoomSpecOptions {
  /** The party room was spawned (its Durable Object stored the flag). */
  spawned: boolean;
  qaRooms: boolean;
  /** This server is a NEAR escrow's operator: the `poker-money-st<stake>` house tables open (tableHost.ts). */
  nearTables?: boolean;
}

export type RoomSpecResult = { ok: true; spec: RoomSpec } | { ok: false; reason: JoinFailReason; message: string };

const QA_ROOM = /^qa-[a-z0-9-]{1,40}$/;

/** The canonical spelling of a session name (its Durable Object name), or null when it can never be a room. */
export function canonicalSession(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > 64) return null;
  if (StakeSessionNames.isPool(s)) return s.toLowerCase();
  if (PartyCodes.isValid(s.toUpperCase())) return s.toUpperCase();
  if (QA_ROOM.test(s.toLowerCase())) return s.toLowerCase();
  if (isTournamentSessionName(s.toUpperCase())) return s.toUpperCase();
  if (isNearHostedRoom(s.toLowerCase())) return s.toLowerCase();
  return null;
}

export function isQaRoom(session: string): boolean {
  return QA_ROOM.test(session);
}

export function roomSpecFor(session: string, opts: RoomSpecOptions): RoomSpecResult {
  const quick = (stake: number): RoomSpec => ({
    name: session,
    kind: 'quick',
    child: true,
    properties: { [ChainTableMode.KindProperty]: ChainTableMode.KindQuick, [ChainTableMode.StakeProperty]: String(stake) },
  });
  // A hosted NEAR table: whether it exists on the escrow (and with this stake's blinds) the ledger checks at buy-in.
  if (isNearHostedRoom(session)) {
    if (!opts.nearTables) return { ok: false, reason: 'GameNotFound', message: 'NEAR tables are not available here.' };
    return { ok: true, spec: { ...quick(nearRoomStake(session)), maxPlayers: 6 } };
  }
  if (StakeSessionNames.isPool(session)) {
    if (session.startsWith(StakeSessionNames.MoneyRoot)) {
      if (!opts.nearTables || !isNearMoneyRoom(session)) return { ok: false, reason: 'GameNotFound', message: 'That NEAR table is not available.' };
      return { ok: true, spec: { ...quick(StakeSessionNames.parseMinBuyIn(session)), maxPlayers: 6 } };
    }
    return { ok: true, spec: quick(StakeSessionNames.parseMinBuyIn(session)) };
  }
  if (PartyCodes.isValid(session)) {
    if (!opts.spawned) return { ok: false, reason: 'GameNotFound', message: `Room '${session}' was not found.` };
    return { ok: true, spec: { name: session, kind: 'private', child: true, properties: { [ChainTableMode.KindProperty]: ChainTableMode.KindPrivate } } };
  }
  if (isTournamentSessionName(session)) {
    // Whether it exists is the tournament record's to say (the host looks it up when it opens).
    return { ok: true, spec: { name: session, kind: 'tournament', child: true, maxPlayers: 32, properties: { [ChainTableMode.KindProperty]: 'tournament' } } };
  }
  if (isQaRoom(session)) {
    if (!opts.qaRooms) return { ok: false, reason: 'GameNotFound', message: `Room '${session}' was not found.` };
    return { ok: true, spec: quick(qaStake(session)) };
  }
  return { ok: false, reason: 'InvalidArguments', message: 'Bad session name.' };
}

/**
 * A QA room's clock speed: the stage's QA speed, unless the name carries `-x<n>-` (1–20), so a harness can run real
 * time on a stage whose QA rooms are fast (`qa-load-1-x1-st100`: the 9 Nov load test at real speed).
 */
export function qaSpeed(session: string, stageSpeed: number): number {
  const m = /-x(\d{1,2})-/.exec(session + '-');
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 20 ? n : Math.max(1, stageSpeed);
}

/** A QA room's stake: its `-st<stake>` suffix when that is a known tier, else the default. */
export function qaStake(session: string): number {
  const m = /-st(\d+)$/.exec(session);
  const n = m ? Number(m[1]) : NaN;
  return StakeCatalog.isKnown(n) ? n : StakeCatalog.DefaultMinBuyIn;
}
