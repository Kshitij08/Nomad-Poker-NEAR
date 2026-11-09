import type { RoomSpec } from '@nomad/table-server/rooms';
import { ChainTableMode, PartyCodes, StakeSessionNames } from '@nomad/table-server/sessions';
import { StakeCatalog } from '@nomad/engine/stakes/stakes';
import type { JoinFailReason } from '@nomad/table-server/protocol';
import { isTournamentSessionName } from '@nomad/db/tournaments';

/**
 * Which room a session name means, for the game server. One Durable Object per session name:
 * - Quick Play pools and their overflow tables (`poker-free`, `poker-free-st50-2`) open on first join;
 * - party rooms (8-character codes) must be spawned first, as PokerDedicatedPartySpawner did;
 * - `qa-…` rooms exist only where QA rooms are switched on (staging): Quick Play tables for test harnesses, at the
 *   default stake or at the one a `-st<stake>` suffix names (`qa-soak-1-st100`);
 * - hosted tournaments (`TRN` + 10) are one room each, holding every table of the tournament;
 * - money pools stay off until on-chain tables move over (Phase 6).
 * Every room here is a "child": it closes after idling empty, and the next join opens it again.
 */

export interface RoomSpecOptions {
  /** The party room was spawned (its Durable Object stored the flag). */
  spawned: boolean;
  qaRooms: boolean;
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
  if (StakeSessionNames.isPool(session)) {
    if (session.startsWith(StakeSessionNames.MoneyRoot)) return { ok: false, reason: 'GameNotFound', message: 'Money tables are not available yet.' };
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

/** A QA room's stake: its `-st<stake>` suffix when that is a known tier, else the default. */
export function qaStake(session: string): number {
  const m = /-st(\d+)$/.exec(session);
  const n = m ? Number(m[1]) : NaN;
  return StakeCatalog.isKnown(n) ? n : StakeCatalog.DefaultMinBuyIn;
}
