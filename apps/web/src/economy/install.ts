/**
 * Installs the economy, accounts and social module (Assets/Scripts/Economy, Game/Economy, Social, Core/Social,
 * Core/Leaderboards, Game/Leaderboards, Analytics).
 *
 * Services (see services.ts): wallet, account (replaces the base LocalAccount), progress, leaderboards, friends,
 * avatars, telemetry, economy. Nomad partials (nomad/social.ts): Friends, PartyMenu, Leaderboard. Screens: 'friends' (FriendsHud's sheet + avatar picker, overlay) and 'login-playfab'
 * (PlayFabLoginUI's panel, overlay). The friends invite toast is a persistent layer above the screens.
 *
 * Backend: offline by default; `?online=local` runs the PlayFab code against an in-browser emulated title;
 * `?online=1` (+ ALLOW_LIVE_PLAYFAB) talks to the real title. See config.ts.
 */
import type { AppContext } from '../app/app';
import { EconomyAccount } from './account';
import { PokerFunnel } from './analytics/pokerFunnel';
import { installLocalTelemetrySink, PokerTelemetry } from './analytics/pokerTelemetry';
import { backendMode, PlayFabConfig } from './config';
import { PokerClientIdentity } from './identity';
import { FreePlayLeaderboard } from './leaderboards/freePlayLeaderboard';
import { PlayFabAuth } from './playfab/auth';
import { FetchTransport, PlayFabClient } from './playfab/client';
import { PlayFabEconomyBridge } from './playfab/economyBridge';
import { browserTitle, LocalTitleTransport, seedLocalDemo } from './playfab/localTitle';
import { PlayFabPlayerProgress } from './playfab/playerProgress';
import { configurePlayFab } from './playfab/runtime';
import { PlayFabWallet } from './playfab/wallet';
import { RetentionGrantQueue } from './retentionGrantQueue';
import { TitleChipLedger } from './server/chipLedger';
import { memoryTitle, type TitleStateHandle } from './server/titleState';
import {
  avatarService, economyWallet, friendsService, friendsUi, leaderboardService, progressService,
  type EconomyService,
} from './services';
import { PlayFabAvatar } from './social/playerAvatar';
import { FreePlayBank, VirtualEconomy } from './virtualEconomy';
import { FriendsHud } from './ui/friendsHud';
import { PlayFabLoginPanel } from './ui/loginPanel';
import { registerSocialPartials } from './nomad/social';

export function install(ctx: AppContext): void {
  const mode = backendMode(ctx.params);
  const sink = installLocalTelemetrySink(ctx.params.get('telemetry') === '1');
  // PokerFunnel.bootstrap (session_started / session_ended) is run by the menu module's own funnel port (menu/funnel.ts).
  PlayFabAuth.bootDisplayName();

  // ---- PlayFab client for the chosen backend
  let title: TitleStateHandle | null = null;
  if (mode === 'local') {
    title = browserTitle();
    configurePlayFab(new PlayFabClient(PlayFabConfig.TitleId, new LocalTitleTransport(title)));
  } else if (mode === 'live') {
    configurePlayFab(new PlayFabClient(PlayFabConfig.TitleId, new FetchTransport(PlayFabConfig.TitleId)));
  } else configurePlayFab(null);

  // ---- events onto the app bus
  VirtualEconomy.changed.on(() => ctx.events.emit('wallet:changed'));
  PlayFabPlayerProgress.changed.on(() => ctx.events.emit('progress:loaded'));
  PlayFabEconomyBridge.attached.on(() => {
    void PlayFabAvatar.pullAsync();
    ctx.events.emit('economy:attached');
  });
  PlayFabEconomyBridge.detached.on(() => ctx.events.emit('progress:loaded'));
  PlayFabAuth.displayNameChanged.on((name) => {
    FreePlayLeaderboard.localDisplayName = name || 'You';
    ctx.events.emit('account:changed');
  });
  FreePlayLeaderboard.localDisplayName = PokerClientIdentity.playerName || 'You';
  PlayFabAvatar.hook();
  void VirtualEconomy.wallet; // VirtualEconomy.Bootstrap: the local wallet exists from the start

  // ---- services
  const account = new EconomyAccount(mode, ctx.events);
  ctx.services.account = account;
  ctx.services.wallet = economyWallet;
  ctx.services.progress = progressService;
  ctx.services.leaderboards = leaderboardService;
  ctx.services.friends = friendsService;
  ctx.services.avatars = avatarService;
  ctx.services.telemetry = { telemetry: PokerTelemetry, funnel: PokerFunnel, events: sink.events };
  const economy: EconomyService = {
    mode,
    grantQueue: RetentionGrantQueue,
    freePlayBank: FreePlayBank,
    requestFlushPendingGrants: () => PlayFabEconomyBridge.requestFlushPendingGrants(),
    markAtTable: () => PlayFabWallet.markAtTable(PokerClientIdentity.playFabId),
    clearAtTable: () => PlayFabWallet.clearAtTable(),
    createChipLedger: () => new TitleChipLedger(title ?? memoryTitle()),
    seedLocalDemo: async () => {
      if (!title || !PokerClientIdentity.playFabId) {
        console.warn('[Economy] seedLocalDemo needs ?online=local and a signed-in player.');
        return;
      }
      seedLocalDemo(title, PokerClientIdentity.playFabId);
      await friendsService.refresh();
      await friendsService.pollInvites();
    },
  };
  ctx.services.economy = economy;

  // ---- UI: FriendsHud (persistent toast + 'friends' sheet) and PlayFabLoginUI ('login-playfab')
  const hud = new FriendsHud(ctx);
  friendsUi.openAvatarPicker = () => hud.openAvatarPicker();
  friendsUi.openPanel = () => hud.openPanel();
  ctx.router.register('friends', (c) => hud.screen(c));
  ctx.router.register('login-playfab', (c) => new PlayFabLoginPanel(c, account));
  // NomadUiHost.Social (Friends, Party) + the Leaderboard screen, on the menu module's host.
  registerSocialPartials();

  // PlayFabLoginUI.OnEnable → StartUpAsync: quiet sign-in when Keep me signed in was ticked.
  void account.startUpAsync().then(async () => {
    if (mode === 'local' && ctx.params.get('seed') === '1') await economy.seedLocalDemo();
  });

  (window as unknown as Record<string, unknown>).__economy = { ctx, account, economy, wallet: economyWallet, friends: friendsService, leaderboards: leaderboardService, telemetry: sink, title };
}
