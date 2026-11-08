/** Text helpers shared by the tournament UI: TournamentsHud's static formatters and NomadUiHost.Tournaments'. */
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import { isLive, isOpen, isRegistered, type TournamentInfo } from './api/tournamentInfo';

export const N0 = formatN0;

/** TournamentsHud.Clock: "4:05", or "1h 07m" from an hour up. */
export function clock(seconds: number): string {
  if (seconds < 0) seconds = 0;
  seconds = Math.trunc(seconds);
  if (seconds >= 3600) return `${Math.trunc(seconds / 3600)}h ${String(Math.trunc((seconds % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.trunc(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** TournamentsHud.Speed. */
export function speedLong(speed: string): string {
  return speed === 'turbo' ? 'Turbo (5 min)' : speed === 'slow' ? 'Slow (12 min)' : 'Regular (8 min)';
}

/** TournamentsHud.Ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st… */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return n + suffix;
}

/** TournamentsHud.StartsIn. */
export function startsIn(startsAtUnix: number, serverNowUnix: number): string {
  const left = startsAtUnix - serverNowUnix;
  return left > 0 ? `starts in ${clock(left)}` : 'starting…';
}

/** TournamentsHud.Details: the one-line summary under a tournament's name (TMP rich text). */
export function details(t: TournamentInfo, serverNowUnix: number, mine: boolean): string {
  const entry = t.entryFee > 0 ? `Entry ${N0(t.entryFee)}` : 'Free entry';
  const when = t.status === 'registering' ? startsIn(t.startsAtUnix, serverNowUnix)
    : t.status === 'funding' ? "Taking the host's prize…"
      : t.status === 'locked' || t.status === 'running' ? 'Playing now'
        : t.status === 'finished' ? 'Finished'
          : t.status === 'funding_failed' ? 'Not enough chips for the prize'
            : 'Cancelled';
  const you = t.myStatus === 'registered' ? (t.serverReady ? ' · <color=#f2c75a>Your table is ready</color>' : " · <color=#72e08a>You're in</color>")
    : t.myStatus === 'paying' ? ' · Paying the entry fee…'
      : t.myStatus === 'playing' ? " · <color=#f2c75a>You're playing</color>"
        : t.myStatus === 'finished' ? (t.myPlace > 0 ? ` · You finished ${ordinal(t.myPlace)}${t.myPrize > 0 ? `, won ${N0(t.myPrize)}` : ''}` : '')
          : t.myStatus === 'rejected' ? ' · Not enough chips to enter'
            : t.myStatus === 'removed' ? ' · The host removed you'
              : '';
  const code = mine && t.visibility === 'private' && t.joinCode ? ` · Code <b>${t.joinCode}</b>` : '';
  return `1st ${N0(t.firstPrize)} · 2nd ${N0(t.secondPrize)} · ${entry} · ${t.players}/${t.maxPlayers} players · ${speedLong(t.speed)} · ${when}${code}${you}`;
}

// ---- NomadUiHost.Tournaments formatters (the Nomad menu's Tournaments_* screens) ---------------------------

export const speedShort = (s: string): string => (s === 'turbo' ? 'Turbo' : s === 'slow' ? 'Slow' : 'Regular');
export const blindsText = (s: string): string => (s === 'turbo' ? '5 min levels' : s === 'slow' ? '12 min levels' : '8 min levels');
export const payout = (x: TournamentInfo): string => `1st ${N0(x.firstPrize)} · 2nd ${N0(x.secondPrize)}`;
export const tag1 = (x: TournamentInfo): string => (x.entryFee === 0 ? 'Freeroll' : `${N0(x.entryFee)} entry`);
export const tag2 = (x: TournamentInfo): string => (x.visibility === 'private' ? 'Private' : speedShort(x.speed));

/** NomadUiHost.ActionLabel. */
export function actionLabel(x: TournamentInfo): string {
  return isRegistered(x) ? (x.serverReady ? 'JOIN TABLE' : 'REGISTERED') : isOpen(x) ? 'REGISTER' : 'CLOSED';
}

/** NomadUiHost.When: "ddd dd MMM, HH:mm" local time. */
export function when(x: TournamentInfo): string {
  const d = new Date(x.startsAtUnix * 1000);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const mon = d.toLocaleDateString('en-GB', { month: 'short' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day} ${pad(d.getDate())} ${mon}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** NomadUiHost.StartLabel (Host form start options, minutes from now). */
export const startLabel = (minutes: number): string =>
  minutes >= 1440 ? 'Tomorrow, same time' : minutes >= 60 ? `In ${Math.trunc(minutes / 60)} h` : `In ${minutes} min`;

/** Whether the "ready" banner applies (TournamentsHud.PollMineAsync). */
export const isReadyToJoin = (t: TournamentInfo): boolean => t.serverReady && isLive(t) && !!t.sessionName;
