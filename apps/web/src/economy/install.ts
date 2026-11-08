/**
 * Installs the economy, accounts and social module (Assets/Scripts/Economy, Game/Economy, Social, Core/Social,
 * Core/Leaderboards, Game/Leaderboards, Analytics).
 *
 * Services (see services.ts): wallet, account (replaces the base LocalAccount), leaderboards, friends, avatars,
 * telemetry, economy. Nomad partials (nomad/social.ts): Friends, PartyMenu, Leaderboard. Screen: 'friends' (FriendsHud's
 * sheet + avatar picker, overlay). The friends invite toast is a persistent layer above the screens.
 *
 * Backend: the Nomad server when the account module has one (ctx.services.nomadApi — it installs first): account,
 * friends, invites, presence, profile and leaderboards are the server's. Without one: offline, a local guest.
 * (PlayFab and its in-browser emulation were removed in Phase 4.)
 */
import type { AppContext } from '../app/app';
import { SocialRoutes, type LeaderboardPage } from '@nomad/contract';
import { EconomyAccount } from './account';
import { PokerFunnel } from './analytics/pokerFunnel';
import { installLocalTelemetrySink, PokerTelemetry } from './analytics/pokerTelemetry';
import { PokerClientIdentity } from './identity';
import { FreePlayLeaderboard } from './leaderboards/freePlayLeaderboard';
import { DisplayNames } from './names';
import { NomadLink } from './nomadLink';
import { TitleChipLedger } from './server/chipLedger';
import { memoryTitle } from './server/titleState';
import { avatarService, economyWallet, friendsService, friendsUi, leaderboardService, type EconomyService } from './services';
import { Friends } from './social/friends';
import { AccountAvatar } from './social/playerAvatar';
import { VirtualEconomy } from './virtualEconomy';
import { FriendsHud } from './ui/friendsHud';
import { registerSocialPartials } from './nomad/social';

export function install(ctx: AppContext): void {
  const session = ctx.services.nomadApi ?? null;
  NomadLink.bind(session);
  const sink = installLocalTelemetrySink(ctx.params.get('telemetry') === '1');
  // PokerFunnel.bootstrap (session_started / session_ended) is run by the menu module's own funnel port (menu/funnel.ts).
  DisplayNames.boot();

  // ---- events onto the app bus
  VirtualEconomy.changed.on(() => ctx.events.emit('wallet:changed'));
  DisplayNames.changed.on((name) => {
    FreePlayLeaderboard.localDisplayName = name || 'You';
    ctx.events.emit('account:changed');
  });
  FreePlayLeaderboard.localDisplayName = PokerClientIdentity.playerName || 'You';
  AccountAvatar.hook();
  void VirtualEconomy.wallet; // VirtualEconomy.Bootstrap: the local wallet exists until the server's replaces it

  // ---- services
  const account = new EconomyAccount(ctx.events);
  ctx.services.account = account;
  ctx.services.wallet = economyWallet;
  ctx.services.leaderboards = leaderboardService;
  ctx.services.friends = friendsService;
  ctx.services.avatars = avatarService;
  ctx.services.telemetry = { telemetry: PokerTelemetry, funnel: PokerFunnel, events: sink.events };
  const economy: EconomyService = {
    mode: session ? 'nomad' : 'offline',
    createChipLedger: () => new TitleChipLedger(memoryTitle()),
  };
  ctx.services.economy = economy;

  if (session) {
    // Leaderboards come from the hands the game server recorded.
    FreePlayLeaderboard.fetchOverride = async (kind, pageIndex) => {
      const p = await NomadLink.call<LeaderboardPage>('GET', `${SocialRoutes.leaderboards}/${kind}?page=${pageIndex}`);
      return {
        kind,
        title: FreePlayLeaderboard.titleFor(kind),
        status: '',
        localRank: p.localRank,
        localScore: p.localScore,
        pageIndex: p.pageIndex,
        pageSize: p.pageSize,
        hasMore: p.hasMore,
        rows: p.rows,
      };
    };
    // Each time a (different) player signs in: mirror their profile, adopt their avatar, load their friends.
    let lastPlayer: string | null = null;
    ctx.events.on('nomad:changed', () => {
      const id = session.me?.player.id ?? null;
      if (!id || id === lastPlayer) return;
      if (lastPlayer) Friends.clear();
      lastPlayer = id;
      account.adoptServerProfile();
      void AccountAvatar.pullAsync();
      void Friends.refreshAsync();
    });
  }

  // ---- UI: FriendsHud (persistent toast + 'friends' sheet)
  const hud = new FriendsHud(ctx);
  friendsUi.openAvatarPicker = () => hud.openAvatarPicker();
  friendsUi.openPanel = () => hud.openPanel();
  ctx.router.register('friends', (c) => hud.screen(c));
  // NomadUiHost.Social (Friends, Party) + the Leaderboard screen, on the menu module's host.
  registerSocialPartials();

  void account.startUpAsync();

  (window as unknown as Record<string, unknown>).__economy = { ctx, account, economy, wallet: economyWallet, friends: friendsService, leaderboards: leaderboardService, telemetry: sink };
}
