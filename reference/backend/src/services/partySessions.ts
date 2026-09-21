/**
 * In-memory queue of Fusion rooms the dedicated VPS should host:
 * - Party Create: generated private codes (`kind=private`)
 * - Quick Play overflow: `poker-free-2`, `poker-free-st50-2`, `poker-money-3`, … (`kind=quick`)
 *   when the long-lived primary table for that stake is full.
 *
 * The Unity dedicated process claims a pending row, spawns a child with that
 * -session name, then marks ready so clients can join as GameMode.Client.
 *
 * Ephemeral: a Railway restart drops pending creates (the client times out).
 */

export type PartyMode = "free" | "chain";
export type PartyStatus = "pending" | "claimed" | "ready" | "failed";
export type PartyKind = "private" | "quick";

export interface PartyRoom {
  session: string;
  mode: PartyMode;
  kind: PartyKind;
  status: PartyStatus;
  full?: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  creatorPubkey?: string;
}

const rooms = new Map<string, PartyRoom>();

const CLAIM_STALE_MS = 90_000;
const ROOM_TTL_MS = 15 * 60_000;
const MAX_ROOMS = Number(process.env.POKER_MAX_PARTY_ROOMS ?? 8);
const MAX_OVERFLOW_INDEX = 20;

const SESSION_RE = /^[A-Z0-9]{4,16}$/;
const OVERFLOW_RE = /^(poker-free|poker-money)(-st[1-9][0-9]*)?-[1-9][0-9]*$/i;
const RESERVED = new Set(["POKERFREE", "POKERMONEY", "POKER-FREE", "POKER-MONEY"]);

export function normalizePartySession(raw: string): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function isOverflowSessionName(raw: string): boolean {
  return OVERFLOW_RE.test(String(raw ?? "").trim());
}

export function isPartySessionName(raw: string): boolean {
  const session = normalizePartySession(raw);
  if (!SESSION_RE.test(session)) return false;
  if (RESERVED.has(session)) return false;
  return true;
}

export function isTrackedSessionName(raw: string): boolean {
  return isPartySessionName(raw) || isOverflowSessionName(raw);
}

function roomKey(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (isOverflowSessionName(trimmed)) return trimmed.toLowerCase();
  return normalizePartySession(trimmed);
}

function gc(now = Date.now()): void {
  for (const [key, room] of rooms) {
    if (room.status === "claimed" && room.claimedAt && now - room.claimedAt > CLAIM_STALE_MS) {
      room.status = "pending";
      room.claimedAt = undefined;
      room.updatedAt = now;
    }

    // Keep an open (not full) ready overflow so later Quick Play clients reuse it
    // instead of spawning poker-free-3 while -2 still has seats.
    if (room.status === "ready" && room.kind === "quick" && !room.full) continue;

    if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(key);
  }
}

function activeCountUnlocked(): number {
  let n = 0;
  for (const room of rooms.values()) {
    if (room.status === "pending" || room.status === "claimed" || room.status === "ready") n += 1;
  }
  return n;
}

function throwIfAtCap(): void {
  if (activeCountUnlocked() >= MAX_ROOMS) {
    throw Object.assign(new Error("Too many extra tables right now. Try again in a minute."), {
      status: 503,
    });
  }
}

export function startParty(
  sessionRaw: string,
  mode: PartyMode,
  creatorPubkey?: string
): PartyRoom {
  gc();
  const session = normalizePartySession(sessionRaw);
  if (!isPartySessionName(session)) {
    throw Object.assign(new Error("Invalid party session code"), { status: 400 });
  }

  const existing = rooms.get(session);
  if (existing && existing.status !== "failed") {
    if (existing.mode !== mode) {
      throw Object.assign(new Error("That code is already in use in the other lobby"), {
        status: 409,
      });
    }
    return existing;
  }

  throwIfAtCap();

  const room: PartyRoom = {
    session,
    mode,
    kind: "private",
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creatorPubkey,
  };
  rooms.set(session, room);
  return room;
}

export function requestOverflow(mode: PartyMode, fullSession?: string, stake?: number): PartyRoom {
  gc();

  if (fullSession) {
    const full = rooms.get(roomKey(fullSession));
    if (full && full.kind === "quick" && full.mode === mode) {
      full.full = true;
      full.updatedAt = Date.now();
    }
  }

  const prefix = overflowPrefix(mode, stake, fullSession);

  let reusable: PartyRoom | undefined;
  for (const room of rooms.values()) {
    if (room.mode !== mode || room.kind !== "quick" || room.full) continue;
    if (!sessionMatchesPrefix(room.session, prefix)) continue;
    if (room.status === "pending" || room.status === "claimed" || room.status === "ready") {
      if (!reusable || room.createdAt < reusable.createdAt) reusable = room;
    }
  }
  if (reusable) return reusable;

  throwIfAtCap();

  let session: string | undefined;
  for (let n = 2; n <= MAX_OVERFLOW_INDEX; n++) {
    const name = `${prefix}-${n}`;
    const existing = rooms.get(name);
    if (!existing || existing.status === "failed") {
      session = name;
      break;
    }
  }
  if (!session) {
    throw Object.assign(new Error("All Quick Play tables are full. Try again in a minute."), {
      status: 503,
    });
  }

  const room: PartyRoom = {
    session,
    mode,
    kind: "quick",
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(session, room);
  return room;
}

function overflowPrefix(mode: PartyMode, stake?: number, fullSession?: string): string {
  const root = mode === "chain" ? "poker-money" : "poker-free";
  const fromName = parseStakeFromSession(fullSession);
  const buyIn = Number(stake) > 0 ? Number(stake) : fromName;
  if (buyIn > 0 && buyIn !== 1000) return `${root}-st${buyIn}`;
  return root;
}

function parseStakeFromSession(session?: string): number {
  const match = String(session ?? "").trim().match(/-st([1-9][0-9]*)(?:-|$)/i);
  if (!match) return 0;
  return Number(match[1]) || 0;
}

function sessionMatchesPrefix(session: string, prefix: string): boolean {
  const name = String(session ?? "").toLowerCase();
  const p = prefix.toLowerCase();
  if (name === p) return true;
  if (!name.startsWith(`${p}-`)) return false;
  return /^[1-9][0-9]*$/.test(name.slice(p.length + 1));
}

export function getParty(sessionRaw: string): PartyRoom | undefined {
  gc();
  return rooms.get(roomKey(sessionRaw));
}

export function claimNext(mode: PartyMode): PartyRoom | null {
  gc();
  let best: PartyRoom | null = null;
  for (const room of rooms.values()) {
    if (room.mode !== mode || room.status !== "pending") continue;
    if (!best || room.createdAt < best.createdAt) best = room;
  }
  if (!best) return null;
  best.status = "claimed";
  best.claimedAt = Date.now();
  best.updatedAt = Date.now();
  return best;
}

export function markReady(sessionRaw: string, ok: boolean, error?: string): PartyRoom | null {
  gc();
  const room = rooms.get(roomKey(sessionRaw));
  if (!room) return null;
  room.status = ok ? "ready" : "failed";
  room.error = ok ? undefined : error || "Dedicated server failed to start the table";
  room.updatedAt = Date.now();
  return room;
}

export function toPublic(room: PartyRoom) {
  return {
    session: room.session,
    status: room.status,
    mode: room.mode,
    kind: room.kind,
    error: room.error ?? "",
  };
}
