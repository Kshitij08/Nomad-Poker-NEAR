import type { AppContext } from '../app/app';
import { tableLeaveHooks } from '../menu/table/nomadTableHud';
import { PRACTICE_SESSION } from './offline/practiceSession';
import { addTableChrome } from '../table/tableScreen';
import { tournamentOverlayChrome } from './overlay/tournamentOverlay';
import { TournamentsPanelScreen } from './hud/tournamentsPanel';
import { TournamentsService } from './service';
import { registerNomadPartial } from '../menu/host';
import { nomadTournamentsPartial } from './menu/nomadTournaments';
import { endpointParam } from '../app/flags';

/**
 * Installs the tournaments module:
 * - ctx.services.tournaments (TournamentsService): browse / mine / host / code / register against the demo data
 *   (or the backend's /api/tournaments when `?tournaments=live&tournamentBackend=<url>` — off by default), the
 *   live TournamentClientState, joining, and the offline practice tournament;
 * - screen 'tournaments' (overlay): the Tournaments panel (TournamentsHud), with a Practice tab;
 * - table chrome: the in-table tournament overlay (TournamentTableOverlay), visible only at a tournament table;
 * - the Nomad menu partial (NomadUiHost.Tournaments): Tournaments_Browse / MyTournaments / Host / JoinByCode and the
 *   Leaderboard, bound to this service.
 * Debug: `?practice=5|8|16` jumps straight into a practice tournament.
 */
export function install(ctx: AppContext): void {
  // With the Nomad API, tournaments are live there (hosted, registered and paid through the ledger; the game server runs
  // them). Without it, demo data, unless the old backend is explicitly configured.
  const nomad = ctx.services.nomadApi ?? null;
  const live = !!nomad || ctx.params.get('tournaments') === 'live';
  const service = new TournamentsService(ctx, {
    live,
    nomad,
    backendUrl: endpointParam(ctx.params, 'tournamentBackend') ?? '',
    sessionTicket: () => sessionTicketOf(ctx),
    // Who "you" are in a tournament: the Nomad API names players by Friend ID.
    playFabId: () => (nomad ? nomad.me?.player.friendCode ?? null : live ? ctx.services.account?.playerId ?? null : null),
  });
  ctx.services.tournaments = service;
  ctx.router.register('tournaments', (c) => new TournamentsPanelScreen(c));
  addTableChrome(tournamentOverlayChrome(service.state));
  // The menu's Leave confirm words a tournament table differently: practice and net tournament tables begin a
  // tournament session (cleared on leaving). Chained so the PER (SOL) tournament check still applies.
  const prevLeaveHook = tableLeaveHooks.isTournament;
  tableLeaveHooks.isTournament = (host) => service.state.session !== null || (prevLeaveHook?.(host) ?? false);
  const prevLeaveText = tableLeaveHooks.leaveText;
  tableLeaveHooks.leaveText = (host) =>
    service.state.session === PRACTICE_SESSION
      ? { title: 'Leave the practice tournament?', body: 'This practice run ends here and nothing carries over. You can start another from Tournaments.' }
      : (prevLeaveText?.(host) ?? null);
  // NomadUiHost.Tournaments: the Nomad menu's Tournaments_* screens and the Leaderboard.
  registerNomadPartial(nomadTournamentsPartial);
  if (live) service.startPolling();

  const practice = Number.parseInt(ctx.params.get('practice') ?? '', 10);
  if (practice >= 2) setTimeout(() => void service.startPractice(practice), 0);
}

/** The PlayFab session ticket, if the account service exposes one (the PlayFab account port may add it). */
function sessionTicketOf(ctx: AppContext): string | null {
  const account = ctx.services.account as unknown as { sessionTicket?: string | null; playFabSessionTicket?: string | null } | undefined;
  return account?.sessionTicket ?? account?.playFabSessionTicket ?? null;
}
