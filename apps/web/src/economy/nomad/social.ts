/**
 * The economy module's NomadUiHost partials on the menu host (src/menu/host.ts):
 *   - NomadUiHost.Social.cs: the Friends screen (profile column, tabs, rows, add / copy / edit avatar) and the Party
 *     menu (Create / Join by code). Table select (also in .Social.cs) is bound by the menu module.
 *   - The Leaderboard half of NomadUiHost.Tournaments.cs: tabs, pages, rows, your rank.
 * Profile dropdown (Edit Avatar → friends.openAvatarPicker, Rename → account.rename) is the menu module's binding.
 */
import type { AppContext } from '../../app/app';
import type { SpriteData, UNode } from '../../hud/unityUi';
import { formatN0 } from '../../core/util/dotnetMath';
import { LeaderboardKind } from '../../core/leaderboards/freePlayLeaderboardMath';
import { FriendCode } from '../../core/social/friendCode';
import { FriendRelation } from '../../core/social/friendRules';
import { NomadHost, registerNomadPartial } from '../../menu/host';
import { widgetsOf } from '../../menu/ui/tree';
import { PokerClientIdentity } from '../identity';
import { FreePlayLeaderboard, type LeaderboardSnapshot } from '../leaderboards/freePlayLeaderboard';
import { FriendInvites, type FriendInvite } from '../social/friendInvites';
import { friendLabel, PlayFabFriends, type FriendEntry } from '../social/playFabFriends';
import { VirtualEconomy } from '../virtualEconomy';

/** ChainTableMode.PrivateMinBuyIn / PrivateMaxBuyIn (Coins private tables). */
const PrivateMinBuyIn = 500;
const PrivateMaxBuyIn = 1000;
const Online = { r: 0.35, g: 0.9, b: 0.45, a: 1 };
const Offline = { r: 0.55, g: 0.58, b: 0.66, a: 1 };

interface NetParty {
  createParty?(): Promise<void>;
  joinParty?(code: string): Promise<void>;
  cancelSearch?(): void;
}

/** Hooks other partials may take (NomadUiHost.Onchain: OnchainPartyCreate / OnchainPartyJoin). */
export const nomadSocialHooks: { onchainParty?: (create: boolean, code: string) => void } = {};

const isOnline = (f: FriendEntry): boolean => f.lastLogin !== null && (Date.now() - f.lastLogin) / 60_000 < 15;
const signedIn = (ctx: AppContext): boolean => ctx.services.account.signedIn;
const net = (ctx: AppContext): NetParty | undefined => (ctx.services as unknown as { net?: NetParty }).net;

export function registerSocialPartials(): void {
  registerNomadPartial(bindFriends);
  registerNomadPartial(bindParty);
  registerNomadPartial(bindLeaderboard);
}

// ------------------------------------------------------------------------------ Friends

type FriendsTab = 'friends' | 'requests';

function bindFriends(host: NomadHost, ctx: AppContext): void {
  const root = host.screen('Friends');
  if (!root) return;
  let tab: FriendsTab = 'friends';
  const rows = host.rowList(host.find(root, 'Frame/List/Viewport/Content'), 'Row_');

  const editAvatar = () => ctx.services.friends?.openAvatarPicker();
  const copyFriendId = () => {
    const code = FriendCode.format(PokerClientIdentity.playFabId);
    void navigator.clipboard?.writeText(code).catch(() => {});
    host.message('Copied', `Your friend ID ${code} is on the clipboard. Send it to a friend so they can add you.`);
  };
  const addFriend = () =>
    host.message('Add a friend', 'Enter their friend ID or name.', 'Send request', undefined, 'Cancel', undefined, 'Friend ID or name', (id) =>
      void host.run(async () => {
        const r = await PlayFabFriends.sendRequestAsync(id);
        return r.success ? null : r.error;
      }, () => host.message('Request sent', "They'll see it under Requests.")));

  host.bind(root, 'Frame/Tabs/Tab_Friends', () => ((tab = 'friends'), paint()));
  host.bind(root, 'Frame/Tabs/Tab_Requests', () => ((tab = 'requests'), paint()));
  host.bind(root, 'Frame/Tabs/Tab_AddFriend', addFriend);
  host.bind(root, 'Frame/ProfileColumn/Btn_EditAvatar', editAvatar);
  host.bind(root, 'Frame/ProfileColumn/Btn_EditPicture', editAvatar);
  host.bind(root, 'Frame/ProfileColumn/Btn_CopyID', copyFriendId);
  host.bind(root, 'Frame/ProfileColumn/FriendIdField/Btn_CopySmall', copyFriendId);
  PlayFabFriends.changed.on(() => host.isShowing('Friends') && paint());
  FriendInvites.changed.on(() => host.isShowing('Friends') && paint());

  // RefreshFriendsAsync (OnScreenShown "Friends").
  host.onScreenShown('Friends', () => {
    paint();
    void PlayFabFriends.refreshAsync().then(() => {
      void FriendInvites.pollAsync();
      paint();
    });
  });

  function paint(): void {
    const me = PokerClientIdentity.playerName;
    host.setText(root, 'Frame/ProfileColumn/DisplayName', NomadHost.short(me, 18));
    host.setText(root, 'Frame/ProfileColumn/Handle', PokerClientIdentity.isGuest ? 'Guest account' : '@' + me);
    host.setText(root, 'Frame/ProfileColumn/FriendIdField/Value', FriendCode.format(PokerClientIdentity.playFabId));
    host.setAvatar(root, 'Frame/ProfileColumn/Avatar/Art', me);

    const friends: FriendEntry[] = [];
    const requests: FriendEntry[] = [];
    for (const f of PlayFabFriends.all) {
      if (f.relation === FriendRelation.Friend) friends.push(f);
      else if (f.relation === FriendRelation.IncomingRequest) requests.push(f);
    }
    const online = friends.filter(isOnline).length;
    host.setText(root, 'Frame/ProfileColumn/Stat_Friends/Value', String(friends.length));
    host.setText(root, 'Frame/ProfileColumn/Stat_Online/Value', String(online));
    host.setText(root, 'Stat_Friends/Value', String(friends.length));
    host.setText(root, 'Stat_Online/Value', String(online));
    host.setText(root, 'Frame/FriendsCount/Label', tab === 'requests' ? `Requests (${requests.length})` : `Friends (${friends.length})`);
    host.setActive(root, 'Frame/FriendsCount', tab === 'requests' && requests.length > 0);
    host.setText(root, 'Frame/Tabs/Tab_Requests/Badge/Count', String(requests.length));
    host.setActive(root, 'Frame/Tabs/Tab_Requests/Badge', requests.length > 0);
    tint(host.find(root, 'Frame/Tabs/Tab_Friends'), tab === 'friends');
    tint(host.find(root, 'Frame/Tabs/Tab_Requests'), tab === 'requests');

    const list = tab === 'requests' ? requests : friends;
    // List.Sort by IsOnline descending (List<T>.Sort is not stable; ties keep PlayFabFriends' name order here).
    list.sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)));
    rows.fill(list.length, (row, i) => paintRow(row, list[i]!, tab === 'requests'));
    host.emptyNote(host.find(root, 'Frame/List'), tab === 'requests' ? 'No friend requests.' : 'No friends yet.\nTap Add Friend and enter their friend ID or name.', list.length === 0);
  }

  function paintRow(row: UNode, f: FriendEntry, request: boolean): void {
    const online = isOnline(f);
    const invite = FriendInvites.inbox.find((inv) => inv.fromId === f.id) ?? null;
    const label = friendLabel(f);
    host.setText(row, 'Name', NomadHost.short(label, 16));
    host.setText(row, 'Status', request ? 'Wants to be friends' : online ? 'Online' : 'Offline');
    host.setText(row, 'Where', request ? '' : invite ? 'Invited you to a table' : f.lastLogin !== null ? `Last seen ${seenDate(f.lastLogin)}` : '');
    const dot = host.find(row, 'StatusDot');
    if (dot?.image) {
      dot.image.color = online ? Online : Offline;
      dot.render();
    }
    host.setAvatar(row, 'Avatar/Art', label, f.avatar);
    host.setActive(row, 'Btn_More', !request);
    const more = host.find(row, 'Btn_More');
    if (more) {
      const b = host.ensureButton(more);
      b.reset();
      b.addListener(() => host.message(label, 'Remove this friend?', 'Remove', () => void host.run(async () => {
        const r = await PlayFabFriends.removeAsync(f.id);
        return r.success ? null : r.error;
      }), 'Cancel'));
    }
    // The action button is named for its sample state (Btn_Invite / Btn_Join / Btn_Spectate).
    let action: UNode | null = null;
    for (const c of row.children) {
      if (!c.name.startsWith('Btn_') || c.name === 'Btn_More') continue;
      if (!action) action = c;
      else c.setActive(false);
    }
    if (!action) return;
    action.setActive(true);
    const b = host.ensureButton(action);
    b.reset();
    b.setInteractable(true);
    if (request) {
      host.setText(action, 'Label', 'Accept');
      b.addListener(() => void host.run(async () => {
        const r = await PlayFabFriends.acceptAsync(f.id);
        return r.success ? null : r.error;
      }));
    } else if (invite) {
      host.setText(action, 'Label', 'Join');
      b.addListener(() => void host.run(() => FriendInvites.acceptAsync(invite)));
    } else {
      host.setText(action, 'Label', 'Invite');
      b.setInteractable(FriendInvites.currentTable !== null);
      b.addListener(() => void host.run(async () => {
        const r = await FriendInvites.inviteAsync(f);
        return r.success ? null : r.error;
      }, () => host.message('Invite sent', `${label} can join your table from their Friends list.`)));
    }
  }

  // FriendInvites.AcceptAsync joins through the menu connection (the Party screen's join-by-code): the net module's
  // joinParty, unless it installed its own handler.
  if (!FriendInvites.joinHandler) {
    FriendInvites.joinHandler = async (invite: FriendInvite) => {
      const n = net(ctx);
      if (!n?.joinParty) return 'Go back to the main menu to join.';
      if (invite.money) return "That's a real-money table. Join it from the SOL tables.";
      void connect(host, () => n.joinParty!(invite.session), n);
      return null;
    };
  }
}

/** `{LastLogin.ToLocalTime():dd MMM}`. */
function seenDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en-US', { month: 'short' })}`;
}

/** TintTab: a CanvasGroup at full alpha when selected, 0.6 otherwise. */
function tint(t: UNode | null, selected: boolean): void {
  if (!t) return;
  t.groupAlpha = selected ? 1 : 0.6;
  if (t.parent?.activeInHierarchy) t.layout();
}

async function connect(host: NomadHost, go: () => Promise<void>, n: NetParty): Promise<void> {
  host.showConnecting(() => n.cancelSearch?.());
  try {
    await go();
  } catch (e) {
    host.message('Party', e instanceof Error ? e.message : String(e));
  } finally {
    host.closeConnecting();
  }
}

// ------------------------------------------------------------------------------ Party

function bindParty(host: NomadHost, ctx: AppContext): void {
  const party = host.screen('PartyMenu');
  if (!party) return;
  const field = host.find(party, 'Center/Card_Join/CodeField');
  const input = field ? widgetsOf(field).input?.input ?? null : null;
  if (input) {
    input.placeholder = 'Enter session code';
    input.maxLength = 12;
  }
  host.bind(party, 'Center/Card_Create/Btn_Create', () => startParty(true));
  host.bind(party, 'Center/Card_Join/Btn_Join', () => startParty(false));
  // The pedestal above the cards belongs to an illustration that isn't drawn yet (a placeholder): hidden.
  host.setActive(party, 'Center/Pedestal', false);

  function startParty(create: boolean): void {
    if (!signedIn(ctx)) {
      host.show('Login');
      return;
    }
    const n = net(ctx);
    if (!n?.createParty || !n.joinParty) {
      host.message('Party', 'Open the game from the menu scene to play.');
      return;
    }
    const code = (input?.value ?? '').replace(/​/g, '').trim();
    if (!create && code.length === 0) {
      host.message('Join a party', 'Enter the session code your friend shared.');
      return;
    }
    if (!host.onchain && !VirtualEconomy.wallet.canAfford(PrivateMinBuyIn)) {
      host.message('Not enough Coins', `Private tables buy in for ${formatN0(PrivateMinBuyIn)}–${formatN0(PrivateMaxBuyIn)} Coins. You have ${formatN0(VirtualEconomy.wallet.coins)}.`);
      return;
    }
    if (host.onchain && nomadSocialHooks.onchainParty) {
      nomadSocialHooks.onchainParty(create, code);
      return;
    }
    void connect(host, () => (create ? n.createParty!() : n.joinParty!(code.toUpperCase())), n);
  }
}

// ------------------------------------------------------------------------------ Leaderboard (NomadUiHost.Tournaments.cs)

const BoardTabs: readonly [string, LeaderboardKind][] = [
  ['Frame/Tab_Weekly', LeaderboardKind.WeeklyEarnings],
  ['Frame/Tab_Monthly', LeaderboardKind.SeasonEarnings],
  ['Frame/Tab_Hands', LeaderboardKind.HandsWon],
  ['Frame/Tab_Friends', LeaderboardKind.FriendsWeekly],
];

function bindLeaderboard(host: NomadHost, ctx: AppContext): void {
  const root = host.screen('Leaderboard');
  if (!root) return;
  let kind = LeaderboardKind.WeeklyEarnings;
  let page = 0;
  let board: LeaderboardSnapshot | null = null;
  let generation = 0;
  const spriteOf = (path: string): SpriteData | null => host.find(root, path)?.image?.sprite ?? null;
  const tabOn = spriteOf('Frame/Tab_Weekly');
  const tabOff = spriteOf('Frame/Tab_Monthly');

  for (const [path, k] of BoardTabs) host.bind(root, path, () => {
    kind = k;
    page = 0;
    void refresh();
  });
  host.bind(root, 'Frame/Btn_Prev', () => {
    if (page > 0) {
      page--;
      void refresh();
    }
  });
  host.bind(root, 'Frame/Btn_Next', () => {
    if (board?.hasMore) {
      page++;
      void refresh();
    }
  });
  host.bind(root, 'Frame/Coins/Btn_AddCoins', () => host.actions.openDailySpin?.());
  host.onScreenShown('Leaderboard', () => void refresh());
  FreePlayLeaderboard.changed.on(() => host.isShowing('Leaderboard') && paint());

  async function refresh(): Promise<void> {
    paint();
    const mine = ++generation;
    let snap: LeaderboardSnapshot;
    try {
      snap = await FreePlayLeaderboard.fetchAsync(kind, page);
    } catch (e) {
      console.warn('[NomadUi] leaderboard', e);
      return;
    }
    if (mine !== generation) return;
    board = snap;
    paint();
  }

  function paint(): void {
    for (const [path, k] of BoardTabs) {
      const t = host.find(root, path);
      if (t?.image && tabOn && tabOff) {
        t.image.sprite = k === kind ? tabOn : tabOff;
        t.render();
      }
    }
    host.setText(root, 'Frame/Table/H_Coins', FreePlayLeaderboard.scoreColumnFor(kind));
    host.setText(root, 'Frame/Page', `Page ${page + 1}`);
    host.setText(root, 'Frame/ResetInfo', kind === LeaderboardKind.SeasonEarnings ? 'Season standings' : 'Resets every Monday (UTC)');
    const rows = board && board.kind === kind ? board.rows : null;
    for (let i = 1; i <= 10; i++) {
      const row = host.find(root, `Frame/Table/Viewport/Content/Row_${i}`);
      if (!row) continue;
      const on = !!rows && i - 1 < rows.length;
      row.setActive(on);
      if (!on) continue;
      const e = rows![i - 1]!;
      host.setText(row, 'Rank', String(e.rank));
      host.setText(row, 'Name', NomadHost.short(e.displayName, 20));
      host.setText(row, 'Coins', formatN0(e.score));
      host.setActive(row, 'Crown', e.rank <= 3);
      host.setAvatar(row, 'Avatar/Art', e.displayName);
    }
    const you = host.find(root, 'Frame/Row_You');
    if (you) {
      const rank = board ? board.localRank : 0;
      const name = ctx.services.account.displayName;
      host.setText(you, 'Rank', rank > 0 ? String(rank) : '–');
      host.setText(you, 'Name', NomadHost.short(name, 9));
      host.setText(you, 'Coins', formatN0(FreePlayLeaderboard.localScore(kind)));
      host.setAvatar(you, 'Avatar/Art', name);
    }
    const prev = host.find(root, 'Frame/Btn_Prev');
    if (prev) host.ensureButton(prev).setInteractable(page > 0);
    const next = host.find(root, 'Frame/Btn_Next');
    if (next) host.ensureButton(next).setInteractable(!!board?.hasMore);
  }
}
