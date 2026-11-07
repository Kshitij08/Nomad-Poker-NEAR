/**
 * Port of NomadUiHost.Menu.cs: Login, MainMenu (top bar, centre buttons, side tabs, bottom bar), the profile dropdown,
 * Settings, Quick Play and the weekly rewards entry. The ONCHAIN parts (SOL capsule, deposit / withdraw, My SOL tables)
 * are the web3 partial's (NomadUiHost.Onchain.cs): it sets host.onchain / host.solShort and rebinds those buttons.
 */
import type { UNode } from '../../hud/unityUi';
import { formatN0, TEST_SCENE_TABLE_SETTINGS, type StakeTier } from '../../core';
import type { TableScreenParams } from '../../table/tableScreen';
import { NomadHost, fittedSize } from '../host';
import { accountExtras, canClaimLogin, canSpin, progressionOf, svc } from '../deps';
import { instantiate } from '../ui/canvas';
import { nodeData, widgetsOf } from '../ui/tree';
import { fitText } from '../dialogs';
import { PokerFunnel } from '../funnel';

const DISCORD_URL = 'https://discord.gg/vzsnDU5zyM';
const TWITTER_URL = 'https://x.com/PlayNomadPoker';

export function bindMenu(host: NomadHost): void {
  bindLogin(host);
  bindMainMenu(host);
  host.addPainter(() => paintLogin(host));
  host.addPainter(() => paintTopBars(host));
  host.addPainter(() => weeklyPrompt(host));
  host.addPainter(() => paintMainMenu(host));
  host.handlePersistent('OpenLoginRewards', () => openWeeklyRewards(host));
  host.onScreenShown('MainMenu', () => {
    // The side panels' rows leave the menu with the panel still expanded: back on the menu, start collapsed.
    host.setActive('MainMenu', 'SideTabs_Expanded', false);
    host.setActive('MainMenu', 'SideTabs_Collapsed', true);
  });
}

// ------------------------------------------------------------------------------ Login

function bindLogin(host: NomadHost): void {
  const root = host.screen('Login');
  if (!root) return;
  const acc = () => accountExtras(host.ctx);
  // Guest signs in first; the main menu comes up once the account is ready (OnAccountChanged).
  host.bind(root, 'Panel/Btn_Guest', () => {
    if (host.signedIn) host.show('MainMenu');
    else void acc().signInAsGuest?.();
  }, true);
  host.bind(root, 'Panel/Btn_Google', () => {
    const a = acc();
    if (a.signInWithGoogle) void a.signInWithGoogle();
    else host.message('Google sign-in', 'Google sign-in needs the online account service, which is off in this build. Play as Guest instead.');
  });
  // Email: a form in the Nomad look, signing in the same way.
  host.bind(root, 'Panel/Btn_Email', () =>
    host.dialogs.form('Sign in with email', ['Email', 'Password'], [false, true], 'Sign in', (v) => {
      const a = acc();
      if (!a.signInWithEmail) {
        host.message('Sign in with email', 'Email sign-in needs the online account service, which is off in this build. Play as Guest instead.');
        return;
      }
      host.busy('Signing in', 'Signing in with your email…');
      void host.run(() => a.signInWithEmail!(v[0] ?? '', v[1] ?? ''), () => host.closeMessage());
    }),
  );
  const keep = host.find(root, 'Panel/KeepSignedIn');
  const toggle = keep ? widgetsOf(keep).toggle : undefined;
  if (toggle) {
    toggle.setIsOnWithoutNotify(acc().keepSignedIn ?? toggle.isOn);
    toggle.listeners.push((on) => acc().setKeepSignedIn?.(on));
    acc().setKeepSignedIn?.(toggle.isOn);
  }
}

function paintLogin(host: NomadHost): void {
  const root = host.screen('Login');
  if (!root?.activeSelf) return;
  const a = accountExtras(host.ctx);
  const status = a.busy ? 'Signing in…' : a.lastError ? a.lastError : host.signedIn ? `Signed in as ${host.ctx.services.account.displayName}` : 'Not signed in';
  host.setText(root, 'Panel/Status', status);
}

// ------------------------------------------------------------------------------ top bars

/** The coin balance on every screen's top bar (ONCHAIN shows $ on the Tables and Agents screens). */
function paintTopBars(host: NomadHost): void {
  const demoCoins = formatN0(coins(host));
  for (const name of host.screenNames) {
    const root = host.screen(name);
    const solScreen = name === 'TableSelect_TownLobby' || name.startsWith('Agents');
    const value = host.onchain && solScreen ? host.solShort : demoCoins;
    host.setText(root, 'TopBar/Coins/Value', value);
    host.setText(root, 'TopBar/Coins', value, true);
    host.setText(root, 'Content/TopBar/Coins/Value', value);
    host.setText(root, 'Frame/Coins/Value', value);
  }
}

const coins = (host: NomadHost) => host.stakes.coins;

let weeklyPrompted = false;
/** Once a session, the weekly rewards screen comes up by itself when today's reward can be claimed. */
function weeklyPrompt(host: NomadHost): void {
  if (weeklyPrompted || !host.signedIn || !host.isShowing('MainMenu') || host.dialogs.isOpen) return;
  if (!canClaimLogin(host.ctx)) return;
  weeklyPrompted = true;
  openWeeklyRewards(host);
}

// ------------------------------------------------------------------------------ MainMenu

function bindMainMenu(host: NomadHost): void {
  const root = host.screen('MainMenu');
  if (!root) return;
  host.bind(root, 'Center/Btn_QuickPlay', () => quickPlay(host));
  host.bind(root, 'TopBar/Stat_High', () => host.show('TableSelect_TownLobby'));
  // DEMO: Coins open the daily spin (ONCHAIN: the web3 partial rebinds this capsule).
  host.bind(root, 'TopBar/Stat_Coins', () => {
    if (!host.onchain) openDailySpin(host);
  });
  host.bind(root, 'TopBar/Stat_Level', () => host.show('LevelRewards'));
  host.bind(root, 'BottomBar/Btn_Discord', () => window.open(DISCORD_URL, '_blank', 'noopener'));
  host.bind(root, 'BottomBar/Btn_X', () => window.open(TWITTER_URL, '_blank', 'noopener'));
  host.bind(root, 'BottomBar/Btn_Settings', () => openSettings(host));
  // Daily spin: the art pointed this at a sample result screen; it opens the slot machine.
  host.bind(root, 'SideTabs_Expanded/Panel_Rewards/Row_DailySpin', () => openDailySpin(host), true);
  // Weekly: the art's call to RetentionMenuHud has no target in the scene; open the weekly rewards screen.
  host.bind(root, 'SideTabs_Expanded/Panel_Rewards/Row_Weekly', () => openWeeklyRewards(host), true);
  addTournamentsRow(host, root);
  bindProfileDropdown(host, root);
}

/** OpenDailySpin (NomadUiHost.Agents.cs): the lucky slot screen. A partial may take it over (host.actions). */
export function openDailySpin(host: NomadHost): void {
  if (host.actions.openDailySpin) return host.actions.openDailySpin();
  if (!host.signedIn) return host.show('Login');
  host.show('LuckySlot_Win');
}

/** The art team's WeeklyRewards_Screen (retention module), or a note when it isn't there. */
export function openWeeklyRewards(host: NomadHost): void {
  if (host.actions.openWeeklyRewards) return host.actions.openWeeklyRewards();
  const r = svc(host.ctx, 'retention');
  if (r?.openWeeklyRewards) r.openWeeklyRewards();
  else if (host.ctx.router.has('weekly-reward')) void host.ctx.router.push('weekly-reward');
  else host.message('Weekly rewards', "The rewards screen isn't loaded.");
}

/** Settings in the Nomad look: volumes, and the account buttons (save a guest account, sign out). */
export function openSettings(host: NomadHost): void {
  const acc = accountExtras(host.ctx);
  const account: [string, () => void][] = [];
  if (host.signedIn && (acc.isGuest ?? true)) {
    if (acc.signInWithGoogle) account.push(['Save with Google', () => {
      host.dialogs.close();
      void acc.signInWithGoogle!();
    }]);
    if (acc.addRecoveryLogin) account.push(['Save with email', () => saveWithEmail(host)]);
  }
  if (host.signedIn && acc.signInAsGuest)
    account.push(['Sign out', () =>
      host.message('Sign out?', (acc.isGuest ?? true) ? "This is a guest account: without Google or an email saved, you can't get back into it from another device." : 'You can sign back in any time.',
        'Sign out', () => void host.ctx.services.account.signOut(), 'Cancel')]);
  for (const extra of settingsAccountExtras) extra(host, account);
  host.dialogs.settings(undefined, account);
}

/** Other partials add Settings account buttons (web3: "Disconnect wallet"). */
export const settingsAccountExtras: ((host: NomadHost, rows: [string, () => void][]) => void)[] = [];

function saveWithEmail(host: NomadHost): void {
  host.dialogs.form('Save your account', ['Email', 'Password (6+ characters)'], [false, true], 'Save', (v) =>
    void host.run(() => accountExtras(host.ctx).addRecoveryLogin!((v[0] ?? '').trim(), v[1] ?? ''), () =>
      host.message('Account saved', 'Sign in with this email on any device: your Coins and progress come with you.')),
  );
}

/** The art has no way into Tournaments from the main menu: a Tournaments row under Community (a Leaderboard copy). */
function addTournamentsRow(host: NomadHost, root: UNode): void {
  const community = host.find(root, 'SideTabs_Expanded/Panel_Community');
  const leaderboard = host.find(community, 'Row_Leaderboard');
  if (!community || !leaderboard || host.find(community, 'Row_Tournaments')) return;
  const friends = host.find(community, 'Row_Friends');
  let step = friends ? Math.abs(friends.anchoredPosition[1] - leaderboard.anchoredPosition[1]) / 2 : 56;
  if (step < 1) step = 56;
  const data = nodeData(leaderboard);
  if (!data) return;
  const row = instantiate(leaderboard, { ...data, name: 'Row_Tournaments' }, community);
  row.anchoredPosition = [leaderboard.anchoredPosition[0], leaderboard.anchoredPosition[1] - step];
  host.setText(row, 'Label', 'Tournaments');
  const b = widgetsOf(row).button;
  if (b) {
    b.disablePersistent();
    b.addListener(() => host.show('Tournaments_Browse'));
  }
  // Grow the panel downward by one row: its title and rows stay put; its BG (stretched) follows the new size.
  const oldH = community.sizeDelta[1];
  const py = community.pivot[1];
  community.sizeDelta = [community.sizeDelta[0], oldH + step];
  community.anchoredPosition = [community.anchoredPosition[0], community.anchoredPosition[1] - step * (1 - py)];
  const pivotShift = -step * (1 - py); // the panel's pivot moved by this in its parent
  for (const k of community.children) {
    if (k.name === 'BG') continue;
    // Keep each child's world position: undo the pivot move and the change in its anchor reference.
    const ay = k.anchorMin[1] + (k.anchorMax[1] - k.anchorMin[1]) * k.pivot[1];
    k.anchoredPosition = [k.anchoredPosition[0], k.anchoredPosition[1] - pivotShift - (ay - py) * step];
  }
}

/** Quick Play: DEMO is the Coins Quick Play at the selected stake. Offline: the single-player table at that stake. */
function quickPlay(host: NomadHost): void {
  if (!host.signedIn) {
    host.show('Login');
    return;
  }
  for (const h of quickPlayOverrides) if (h(host)) return;
  const tier = host.stakes.resolve();
  void joinFreePlay(host, tier, host.stakes.selectedBuyInChips, 'quick');
}

/** ONCHAIN Quick Play (web3 partial): return true when handled. */
export const quickPlayOverrides: ((host: NomadHost) => boolean)[] = [];

/**
 * Sits at a Coins table: the net module's Quick Play / FreePlayJoin when it is installed (with the Connecting cover,
 * Disconnect cancels, a minute with no table says so), else the offline single-player table at this stake.
 */
export async function joinFreePlay(host: NomadHost, tier: StakeTier, buyIn: number, how: 'quick' | 'join'): Promise<void> {
  const net = svc(host.ctx, 'net');
  const go = how === 'quick' ? net?.quickPlay : net?.freePlayJoin;
  if (go) {
    host.showConnecting(() => net?.cancelSearch?.());
    const timeout = window.setTimeout(() => {
      host.closeConnecting();
      net?.cancelSearch?.();
      if (host.isShowing('MainMenu')) host.message('Quick Play', `No table at ${tier.displayName} stakes answered. Try again, or pick another stake in Tables.`);
    }, 60_000);
    try {
      await go.call(net, { tier, buyIn });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Web addition: only when NO table server answered (NetConnectError.unreachable), offer the offline table at
      // the same stake. Any other join error is shown the way Unity shows it.
      if ((e as { unreachable?: boolean }).unreachable)
        host.message('Quick Play', message + '\n\nPlay against bots offline at this stake instead?', 'Play offline', () => void offlineTable(host, tier, buyIn), 'Cancel');
      else host.message('Quick Play', message);
    } finally {
      window.clearTimeout(timeout);
      host.closeConnecting();
    }
    return;
  }
  await offlineTable(host, tier, buyIn);
}

/** Offline Free Play (PokerGameController): this stake's blinds, the buy-in as the stack. */
export async function offlineTable(host: NomadHost, tier: StakeTier, buyIn: number): Promise<void> {
  PokerFunnel.beginTable(`offline-${tier.minBuyIn}`, tier.minBuyIn, buyIn, false);
  const params: TableScreenParams = {
    settings: {
      ...TEST_SCENE_TABLE_SETTINGS,
      smallBlind: tier.smallBlind,
      bigBlind: tier.bigBlind,
      startingStack: buyIn,
      playerName: host.ctx.services.account.displayName,
    },
    onLeave: () => PokerFunnel.endTable(),
  };
  await host.ctx.router.navigate('table', params);
}

let capsulesFitted = false;
/** The top bar's capsules: caption and value fill the capsule right of the icon, shrinking to fit. */
function fitCapsules(host: NomadHost, root: UNode): void {
  if (capsulesFitted) return;
  capsulesFitted = true;
  for (const cap of ['TopBar/Stat_Coins', 'TopBar/Stat_High']) {
    const c = host.find(root, cap);
    const icon = host.find(c, 'Icon');
    if (!c || !icon) continue;
    const cw = c.w || c.sizeDelta[0];
    const iw = icon.w || icon.sizeDelta[0];
    const left = icon.anchoredPosition[0] + iw * 0.5 + 6 + cw * 0.5;
    for (const [part, a0, a1] of [['Caption', 0.52, 0.92], ['Value', 0.08, 0.52]] as const) {
      const t = host.find(c, part);
      if (!t) continue;
      t.anchorMin = [0, a0];
      t.anchorMax = [1, a1];
      t.sizeDelta = [-left - 12, 0];
      t.anchoredPosition = [left + t.sizeDelta[0] * t.pivot[0], 0];
      if (t.text) {
        t.text.alignH = 'left';
        t.text.alignV = 'middle';
        t.text.wrap = false;
        fitText(t, t.text.max, 10);
      }
    }
    if (c.activeInHierarchy) c.layout();
  }
}

let sideLabelsEven = false;
/** Each side panel's row labels at one size: the smallest that fits all of them. */
function evenSideLabels(host: NomadHost, root: UNode): void {
  const expanded = host.find(root, 'SideTabs_Expanded');
  if (sideLabelsEven || !expanded?.activeInHierarchy) return;
  sideLabelsEven = true;
  for (const panelName of ['Panel_Rewards', 'Panel_Community']) {
    const panel = host.find(expanded, panelName);
    if (!panel) continue;
    const labels = panel.children.filter((r) => r.name.startsWith('Row_')).map((r) => host.find(r, 'Label')).filter((t): t is UNode => !!t?.text);
    let size = Infinity;
    for (const t of labels) size = Math.min(size, fittedSize(t));
    if (!Number.isFinite(size)) continue;
    for (const t of labels) {
      t.text!.autoSize = false;
      t.text!.fontSize = size;
      t.invalidateText();
      t.layout();
    }
  }
}

function paintMainMenu(host: NomadHost): void {
  const root = host.screen('MainMenu');
  if (!root) return;
  if (root.activeSelf) fitCapsules(host, root);
  evenSideLabels(host, root);
  const chain = host.onchain;
  host.setText(root, 'TopBar/Stat_Coins/Caption', chain ? 'SOL' : 'COINS');
  host.setText(root, 'TopBar/Stat_Coins/Value', chain ? host.solShort : formatN0(coins(host)));
  const prog = progressionOf(host.ctx);
  host.setText(root, 'TopBar/Stat_Level/Caption', `LV ${prog?.level ?? 1}`);
  host.setFill(root, 'TopBar/Stat_Level/XPBar/Fill', prog?.levelProgress01 ?? 0);
  // "STAKES" over the selected tier's name; tapping it opens table select.
  const tier = host.stakes.resolve();
  host.setText(root, 'TopBar/Stat_High/Caption', 'STAKES');
  host.setText(root, 'TopBar/Stat_High/Value', tier.displayName);
  const name = host.ctx.services.account.displayName;
  host.setText(root, 'TopBar/PlayerCapsule/Name', NomadHost.short(name, 14));
  host.setAvatar(root, 'TopBar/PlayerCapsule/Avatar/Art', name);
  solTablesButton(host, root)?.setActive(chain);
  host.setActive(root, 'SideTabs_Expanded/Panel_Rewards/Row_DailySpin/NotifyDot', canSpin(host.ctx));
  host.setActive(root, 'SideTabs_Expanded/Panel_Rewards/Row_Weekly/NotifyDot', canClaimLogin(host.ctx));
  paintProfile(host, root);
}

// ------------------------------------------------------------------------------ ProfileDropdown

function bindProfileDropdown(host: NomadHost, menu: UNode): void {
  const dd = host.find(menu, 'ProfileDropdown');
  if (!dd) return;
  host.bind(dd, 'Panel/Btn_EditAvatar', () => {
    const f = svc(host.ctx, 'friends');
    if (f?.openAvatarPicker) f.openAvatarPicker();
    else host.message('Avatar', "The avatar picker isn't loaded.");
  });
  host.bind(dd, 'Panel/Btn_Rename', () =>
    host.message('Change your name', 'Pick the name other players see.', 'Save', undefined, 'Cancel', undefined, 'Your name', (name) =>
      void host.run(async () => {
        const acc = accountExtras(host.ctx);
        if (acc.rename) return acc.rename(name);
        await host.ctx.services.account.setDisplayName(name); // MenuRenameBridge → PlayFabAuth.RenameAsync offline
        return null;
      }), host.ctx.services.account.displayName),
  );
  // Deposit / Withdraw / wallet / SOL balance: NomadUiHost.Onchain.cs (web3 partial binds these).
}

/** ONCHAIN: a fourth button for the private tables lobby; the web3 partial binds its click. */
function solTablesButton(host: NomadHost, menu: UNode): UNode | null {
  const existing = host.find(menu, 'Center/Btn_SolTables');
  if (existing) return existing;
  const party = host.find(menu, 'Center/Btn_PartyMenu');
  const data = party && nodeData(party);
  if (!party?.parent || !data) return null;
  const b = instantiate(party, { ...data, name: 'Btn_SolTables' }, party.parent);
  const q = host.find(menu, 'Center/Btn_QuickPlay');
  const step = q ? q.anchoredPosition[1] - party.anchoredPosition[1] : 107.4;
  b.anchoredPosition = [party.anchoredPosition[0], party.anchoredPosition[1] - step];
  const btn = host.ensureButton(b);
  btn.reset();
  btn.addListener(() => {
    if (!host.signedIn) host.show('Login');
    else for (const fn of solTablesHandlers) fn(host);
  });
  for (const t of b.walk()) if (t.text) t.setText('MY SOL TABLES');
  host.fitTexts(b);
  return b;
}

/** PerEntry.OpenLobby (web3 partial). */
export const solTablesHandlers: ((host: NomadHost) => void)[] = [];

/** Name and avatar in the dropdown (the wallet / SOL lines are the web3 partial's). */
function paintProfile(host: NomadHost, menu: UNode): void {
  const dd = host.find(menu, 'ProfileDropdown');
  if (!dd?.activeInHierarchy) return;
  const name = host.ctx.services.account.displayName;
  host.setText(dd, 'Panel/Name', NomadHost.short(name, 16));
  host.setAvatar(dd, 'Panel/Avatar/Art', name);
  if (!host.onchain && !host.ctx.services.account.walletAddress) {
    host.setText(dd, 'Panel/WalletTitle', 'WALLET (SOL)');
    host.setText(dd, 'Panel/SolBalance', 'Not connected');
    host.setActive(dd, 'Panel/Btn_Withdraw', false);
    // No wallet yet: one button connects it ("Connect wallet" was cut off in the half-width button).
    host.setText(dd, 'Panel/Btn_Deposit/Label', 'Connect');
  }
}
