/**
 * On-chain (SOL) tournaments (Per/Unity/PerTourneyPanel.cs + PerTourneyHostPanel, M11) as data and actions for the
 * Redesign v2 SOL tournaments pages (src/ui2/screens/solTourneys.ts): the list from the private-tables backend,
 * Register / Leave / Cancel (play key: no wallet prompt), a private tournament's code, "Go to your table" once a round
 * runs, and hosting one (one wallet approval).
 */
import { PublicKey } from '@solana/web3.js';
import type { AppContext } from '../../app/app';
import { noPerBackend } from '../per/agent';
import { PerSessionKeys } from '../per/keys';
import { PerRpc } from '../per/rpc';
import type { PerRuntime } from '../per/service';
import type { Status } from '../per/gameWallet';
import type { TourneyParams } from '../per/types';
import { u64 } from './lobby';
import { errMsg } from './perUi';
import { w3 } from '../services';

type Json = Record<string, unknown>;
const int = (v: unknown): number => Number(v ?? 0) | 0;
const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** "2 h 5 min" / "12 min" / "40 s". */
export const span = (s: number): string => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`);
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
export const ordinal = (n: number): string => n + ([11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');

/** PerTourneyHostPanel.CodeBytes: a code as the 16 bytes the program hashes (ASCII, upper case, zero padded). */
export function codeBytes(textIn: string | null | undefined): Uint8Array {
  const b = new Uint8Array(16);
  const s = (textIn ?? '').trim().toUpperCase();
  for (let i = 0; i < Math.min(16, s.length); i++) b[i] = s.charCodeAt(i) & 0x7f;
  return b;
}

/** A 6-character code (no 0, O, 1 or I). */
function newCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (x) => alphabet[x % alphabet.length]).join('');
}

const bytesEq = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

async function fetchTourneys(per: PerRuntime, all: boolean): Promise<Json[]> {
  const base = per.config.perBackendUrl;
  if (!base) noPerBackend();
  const r = await per.http.get(base + '/tournaments' + (all ? '?all=1' : ''));
  if (r.status !== 200) throw new Error(`tournaments: HTTP ${r.status}`);
  const items = (JSON.parse(r.body) as { items?: Json[] }).items;
  return Array.isArray(items) ? items : [];
}

function entrantOf(t: Json, wallet: string): Json | null {
  const list = Array.isArray(t.entrants) ? (t.entrants as Json[]) : [];
  return list.find((e) => str(e.wallet) === wallet) ?? null;
}

/** A SOL tournament as the v2 list shows it. */
export interface SolTourney {
  address: string;
  name: string;
  isPrivate: boolean;
  /** registering · drawing · running · cancelled · finished */
  phase: 'registering' | 'drawing' | 'running' | 'cancelled' | 'finished';
  /** "Starts in 12 min", "Round 2 · level 3", … */
  when: string;
  count: number;
  max: number;
  fee: bigint;
  first: bigint;
  second: bigint;
  host: boolean;
  /** You: not registered, registered, out (finished in `place`). */
  you: 'none' | 'in' | 'out';
  place: number;
  canRegister: boolean;
  /** Your table once your round runs (-1: none). */
  table: number;
  /** Your round has started and your table is ready. */
  ready: boolean;
}

/** The open (and your own) SOL tournaments. Old finished ones stay out of the way. */
export async function readTourneys(ctx: AppContext, per: PerRuntime): Promise<SolTourney[]> {
  const items = await fetchTourneys(per, false);
  const me = w3(ctx).solana.address;
  // Private tournaments aren't listed: add the ones you host or joined, so you can see, leave or cancel them.
  if (me !== null)
    for (const t of await fetchTourneys(per, true))
      if (t.private === true && (str(t.host) === me || entrantOf(t, me) !== null) && !items.some((x) => str(x.address) === str(t.address))) items.push(t);
  const now = Math.floor(Date.now() / 1000);
  const T = per.tourney;
  const out: SolTourney[] = [];
  for (const t of items) {
    const status = int(t.status);
    const en = me ? entrantOf(t, me) : null;
    const host = me !== null && str(t.host) === me;
    if (!host && !en && (status === T.PAID || status === T.CANCELLED) && now - num(t.startTs) > 3600) continue;
    const count = int(t.count), max = int(t.maxPlayers);
    const fee = u64(t.entryFee);
    const { first, second } = T.payouts(fee, Math.max(count, 2), u64(t.hostPrize));
    const startTs = num(t.startTs);
    const roundStarts = num(t.roundStartsTs);
    const phase: SolTourney['phase'] = status === T.REGISTERING ? 'registering' : status === T.DRAWING ? 'drawing' : status === T.RUNNING ? 'running' : status === T.CANCELLED ? 'cancelled' : 'finished';
    const when = phase === 'registering'
      ? (startTs > now ? `Starts in ${span(startTs - now)}` : count < 2 ? 'Starting… fewer than 2 players, so it will be cancelled and refunded' : 'Starting… setting up the tables')
      : phase === 'drawing' ? 'Drawing seats…'
      : phase === 'running' && now < roundStarts ? `Round ${int(t.round)} starts in ${span(roundStarts - now)}`
      : phase === 'running' ? `Round ${int(t.round)} · level ${1 + Math.floor((now - num(t.runningSince)) / Number(T.levelSeconds(int(t.speed))))}`
      : phase === 'cancelled' ? 'Cancelled, entries refunded' : 'Finished';
    const playing = !!en && int(en.state) === T.ENTRANT_PLAYING;
    const table = phase === 'running' && playing && int(en!.table) !== T.NO_TABLE ? int(en!.table) : -1;
    out.push({
      address: str(t.address), name: str(t.name), isPrivate: t.private === true, phase, when, count, max, fee, first, second, host,
      you: !en ? 'none' : int(en.state) === T.ENTRANT_OUT ? 'out' : 'in', place: en ? int(en.place) : 0,
      canRegister: phase === 'registering' && !en && count < max, table, ready: table >= 0 && now >= roundStarts,
    });
  }
  return out;
}

/** Registers for a tournament: the entry fee comes from the game balance (play key, no wallet prompt). */
export async function registerTourney(ctx: AppContext, per: PerRuntime, address: string, code: string | null, st: Status): Promise<void> {
  if (!(await w3(ctx).solana.connect())) throw new Error('Connect a wallet first.');
  const tourney = new PublicKey(address);
  const key = await per.gameWallet.playKey(st);
  // The table key for this tournament: signs your seeds and actions, reads your cards.
  const reader = await PerSessionKeys.forKey(per.gameWallet.address!, tourney);
  st('Registering (the entry fee comes from your game balance; no wallet prompt)…');
  await per.gameWallet.sendAsKey(key, per.tourney.register(tourney, key, reader.publicKey, code === null ? null : codeBytes(code))[1]!);
}

/** Leaves (your fee comes back) or, as its host, cancels (everyone is refunded). Play key, no wallet prompt. */
export async function leaveOrCancelTourney(per: PerRuntime, address: string, cancel: boolean, st: Status): Promise<void> {
  const tourney = new PublicKey(address);
  const key = await per.gameWallet.playKey(st);
  st(cancel ? 'Cancelling (everyone is refunded)…' : 'Leaving (your fee comes back)…');
  await per.gameWallet.sendAsKey(key, (cancel ? per.tourney.cancel(tourney, key) : per.tourney.leave(tourney, key))[1]!);
}

/** A private tournament's code, tried against every private tournament open for registration (its hash is public). */
export async function findTourneyByCode(per: PerRuntime, input: string): Promise<string | null> {
  const code = codeBytes(input);
  const T = per.tourney;
  const rpc = new PerRpc(per.http, per.config.teeUrl);
  for (const t of await fetchTourneys(per, true)) {
    if (t.private !== true || int(t.status) !== T.REGISTERING) continue;
    const address = new PublicKey(str(t.address));
    const onChain = T.decode(await rpc.getAccount(address));
    if (onChain && bytesEq(onChain.codeHash, T.codeHash(address, code))) return address.toBase58();
  }
  return null;
}

/** Seats you at your tournament table and opens it. */
export async function goToTourneyTable(ctx: AppContext, per: PerRuntime, address: string, table: number, st: Status): Promise<void> {
  const params = await per.joinTourney(address, table, st);
  if (params) await ctx.router.navigate('table', params);
}

// ---------------------------------------------------------------- hosting (PerTourneyHostPanel)

export const PLAYERS = [8, 16, 24, 30];
export const FEES = [0n, 1_000_000n, 5_000_000n, 10_000_000n];
export const PRIZES = [0n, 5_000_000n, 10_000_000n];
export const START_MINUTES = [10, 30, 60];

export interface SolTourneyOptions {
  name: string;
  /** per.tourney speed index (SPEED_LABELS). */
  speed: number;
  players: number;
  fee: number;
  prize: number;
  start: number;
  isPrivate: boolean;
}

/** Creates a SOL tournament (one wallet approval) and adds the host's prize. Returns the private code, or null. */
export async function createSolTourney(ctx: AppContext, per: PerRuntime, o: SolTourneyOptions, st: Status): Promise<string | null> {
  const T = per.tourney;
  const sol = per.format.sol;
  if (!(await w3(ctx).solana.connect())) throw new Error('Connect a wallet first.');
  const wallet = per.gameWallet.address!;
  await per.gameWallet.ensureVault(st, 'no tournament was created');
  const key = await per.gameWallet.playKey(st);
  const prize = PRIZES[o.prize]!;
  if (prize > 0n) {
    const balance = (await per.balance(st)) ?? 0n;
    if (balance < prize) throw new Error(`Your game balance is ${sol(balance)} and the prize is ${sol(prize)}. Deposit first, or pick a smaller prize.`);
  }
  const id = per.host.newTableId();
  const address = T.address(wallet, id);
  const code = o.isPrivate ? newCode() : null;
  const p: TourneyParams = {
    name: T.nameBytes(o.name), speed: o.speed, maxPlayers: PLAYERS[o.players]!, entryFee: FEES[o.fee]!,
    startTs: BigInt(Math.floor(Date.now() / 1000) + START_MINUTES[o.start]! * 60 + 30),
    codeHash: code ? T.codeHash(address, codeBytes(code)) : new Uint8Array(32),
  };
  st('Approve creating the tournament in your wallet…');
  await per.gameWallet.l1.sendWithWallet(T.createAndDelegate(wallet, id, p), per.gameWallet.signer);
  if (prize > 0n) {
    st(`Putting in your ${sol(prize)} prize from your game balance (no wallet prompt)…`);
    let last: unknown = null;
    for (let i = 0; i < 10; i++) {
      await per.http.delay(3000); // the rollup picks up the handed-over tournament within seconds
      try {
        await per.gameWallet.sendAsKey(key, T.fund(address, key, prize)[1]!);
        last = null;
        break;
      } catch (e) {
        last = e;
      }
    }
    if (last) {
      console.warn('[PerTourneyHost] fund: ' + errMsg(last));
      throw new Error("Your tournament was created, but your prize couldn't be added yet. It runs without it.");
    }
  }
  return code;
}
