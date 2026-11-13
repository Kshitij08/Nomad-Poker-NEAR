/** Social: Friends and Leaderboard. Atlas: Redesign v2 › Social (REV 'friends', 'leaderboard'; CUR 'add-friend'). */
import { formatN0 } from '@nomad/engine/util/dotnetMath';
import { LeaderboardKind } from '@nomad/engine/leaderboards/freePlayLeaderboardMath';
import { FriendCode } from '@nomad/engine/social/friendCode';
import { FriendRelation } from '@nomad/engine/social/friendRules';
import { AvatarCatalog } from '@nomad/engine/social/avatarCatalog';
import { avatarId } from '../../menu/host';
import { PokerClientIdentity } from '../../economy/identity';
import { FreePlayLeaderboard, type LeaderboardSnapshot } from '../../economy/leaderboards/freePlayLeaderboard';
import { FriendInvites } from '../../economy/social/friendInvites';
import { Friends, friendLabel, type FriendEntry } from '../../economy/social/friends';
import { act, btn, esc, input, tabs } from '../core';
import { ico } from '../icons';
import { ui, app, S, onchain, onchainApi, avatar, avatarUrl, level, playerName, accountExtras, topBar, run, prompt, copy, setMode } from '../ctx';
import type { ScreenDef } from '../install';
import './social.css';

const isOnline = (f: FriendEntry): boolean => f.online ?? (f.lastLogin !== null && (Date.now() - f.lastLogin) / 60_000 < 15);

/** Avatar image for any player (their pick, else the catalog's stand-in for the name). */
function avatarFor(name: string, pick = 0): string | null {
  const id = avatarId(pick, name);
  return id ? `${import.meta.env.BASE_URL ?? '/'}assets/ui/Test/UI/Common_UI/Pro_Pic/${id}.webp` : null;
}

function seenDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en-US', { month: 'short' })}`;
}

const myFriendId = (): string => {
  const acc = app().services.account as unknown as { friendId?: string };
  const id = acc.friendId || (PokerClientIdentity.playFabId ? FriendCode.format(PokerClientIdentity.playFabId) : '');
  return id || '—';
};

// ------------------------------------------------------------------ Friends

type FTab = 'friends' | 'requests';

type FriendsScreen = ScreenDef & {
  tab: FTab;
  mode: 'view' | 'edit' | 'rename';
  pick: number;
  showProfile: boolean;
  offs: (() => void)[];
  profileHtml(nFriends: number, nOnline: number, nReq: number): string;
  pickerHtml(): string;
  rowsHtml(): string;
};

const friends: FriendsScreen = {
  id: 'friends',
  replaces: ['Friends'],
  tab: 'friends',
  mode: 'view',
  pick: 0,
  showProfile: false,
  offs: [],
  input: {},
  open(arg) {
    this.tab = 'friends';
    this.mode = 'view';
    this.showProfile = false;
    // ui.show('friends', 'edit'): straight into the picture picker (the profile popover's avatar edit uses it).
    if (arg === 'edit') {
      this.mode = 'edit';
      this.pick = Number(S('avatars')?.current ?? 0);
      this.showProfile = true;
    }
    this.input = { search: '', rename: '' };
    const r = () => ui().render();
    this.offs = [Friends.changed.on(r), FriendInvites.changed.on(r), FriendInvites.tableChanged.on(r)];
    const av = S('avatars');
    if (av?.changed?.on) this.offs.push(av.changed.on(r));
    // Live search: the core skips renders while an input has focus, so the list alone is repainted as you type.
    const onSearch = (e: Event): void => {
      const el = e.target as HTMLInputElement;
      if (el.dataset?.in !== 'search') return;
      (this.input ??= {}).search = el.value;
      const listEl = ui().el.querySelector<HTMLElement>('.v2-fr-list');
      if (listEl) listEl.innerHTML = this.rowsHtml();
    };
    ui().el.addEventListener('input', onSearch);
    this.offs.push(() => ui().el.removeEventListener('input', onSearch));
    void Friends.refreshAsync().then(() => {
      void FriendInvites.pollAsync();
      r();
    });
  },
  close() {
    for (const off of this.offs) off();
    this.offs = [];
  },
  backFirst() {
    if (this.mode === 'view') return false;
    this.mode = 'view';
    return true;
  },
  render() {
    const all = Friends.all;
    const list: FriendEntry[] = [];
    const requests: FriendEntry[] = [];
    for (const f of all) {
      if (f.relation === FriendRelation.Friend) list.push(f);
      else if (f.relation === FriendRelation.IncomingRequest) requests.push(f);
    }
    const online = list.filter(isOnline).length;
    return `${topBar('Friends')}
<div class="v2-body v2-fr ${this.showProfile ? 'v2-fr-open' : ''}">
  <div class="v2-panel v2-fr-left">${this.mode === 'edit' ? this.pickerHtml() : this.profileHtml(list.length, online, requests.length)}</div>
  <div class="v2-panel v2-col v2-fr-right">
    <div class="v2-row v2-fr-head">
      ${tabs([['friends', 'Friends'], ['requests', requests.length ? `Requests (${requests.length})` : 'Requests'], ['add', 'Add friend']], this.tab, 'f-tab', 'v2-fr-tabs')}
      ${input('search', this.input?.search ?? '', 'Search friends', { cls: 'v2-grow v2-fr-search' })}
    </div>
    ${Friends.lastError && !all.length ? `<div class="v2-xs v2-badc">${esc(Friends.lastError)}</div>` : ''}
    <div class="v2-col v2-scroll v2-grow v2-fr-list">${this.rowsHtml()}</div>
  </div>
</div>`;
  },
  rowsHtml() {
    const list: FriendEntry[] = [];
    const requests: FriendEntry[] = [];
    for (const f of Friends.all) {
      if (f.relation === FriendRelation.Friend) list.push(f);
      else if (f.relation === FriendRelation.IncomingRequest) requests.push(f);
    }
    const q = (this.input?.search ?? '').trim().toLowerCase();
    const shown = (this.tab === 'requests' ? requests : list)
      .filter((f) => !q || friendLabel(f).toLowerCase().includes(q))
      .sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)));
    const atTable = FriendInvites.currentTable !== null;

    const rows = shown.length === 0
      ? `<div class="v2-empty">${ico('friends', 6)}${
          this.tab === 'requests' ? 'No friend requests.' : q ? 'No friends match that name.' : 'No friends yet.<br>Tap Add Friend and enter their friend ID or name.'
        }</div>`
      : shown.map((f) => {
          const label = friendLabel(f);
          const on = isOnline(f);
          const invite = FriendInvites.inbox.find((i) => i.fromId === f.id) ?? null;
          if (this.tab === 'requests')
            return `<div class="v2-card v2-row v2-fr-row">${avatar('s', avatarFor(label, f.avatar))}<div class="v2-grow"><b class="v2-ellip">${esc(label)}</b><div class="v2-xs v2-mut">Wants to be friends</div></div>${btn('Accept', 'f-accept', { h: 'gold', c: 'sm', v: f.id })}${btn('Decline', 'f-decline', { h: 'ghost', c: 'sm', v: f.id })}</div>`;
          const where = invite ? 'Invited you to a table' : f.table ? 'At a table' : f.lastLogin !== null ? `Last seen ${seenDate(f.lastLogin)}` : '';
          const action = invite
            ? btn('Join', 'f-join', { h: 'gold', c: 'sm', v: f.id })
            : btn('Invite', 'f-invite', { h: 'blue', c: `sm${atTable ? '' : ' dis'}`, v: f.id, title: atTable ? 'Invite to your table' : 'Enabled only while you are at a table' });
          return `<div class="v2-card v2-row v2-fr-row">${avatar('s', avatarFor(label, f.avatar))}<div class="v2-grow"><div class="v2-row" style="gap:.5em"><b class="v2-ellip" style="font-size:1.05em">${esc(label)}</b><span class="v2-pill ${on ? 'ok' : ''}">${on ? 'Online' : 'Offline'}</span></div><div class="v2-xs v2-mut v2-ellip">${esc(where)}</div></div>${action}<button class="v2-pill v2-more"${act('f-more', f.id)} aria-label="More for ${esc(label)}">${ico('more', 1)}</button></div>`;
        }).join('');
    return rows;
  },
  actions: {
    'f-tab': (v) => {
      if (v === 'add') return addFriend();
      friends.tab = v as FTab;
    },
    'f-profile': () => {
      friends.showProfile = !friends.showProfile;
    },
    'f-edit': () => {
      friends.mode = 'edit';
      friends.pick = Number(S('avatars')?.current ?? 0);
      friends.showProfile = true;
    },
    'f-pick': (v) => {
      friends.pick = Number(v);
    },
    'f-pick-cancel': () => {
      friends.mode = 'view';
    },
    'f-pick-save': () => {
      const av = S('avatars');
      const acc = app().services.account as unknown as { setAvatar?: (n: number) => unknown };
      if (av?.choose) av.choose(friends.pick);
      else acc.setAvatar?.(friends.pick);
      friends.mode = 'view';
      ui().toast('Picture saved');
    },
    'f-rename': () => {
      friends.mode = 'rename';
      friends.input = { ...friends.input, rename: playerName() };
      setTimeout(() => {
        const el = ui().el.querySelector<HTMLInputElement>('[data-in="rename"]');
        el?.focus();
        el?.select();
      }, 0);
    },
    'f-rename-save': () => {
      const el = document.querySelector<HTMLInputElement>('.v2 [data-in="rename"]');
      const name = (el?.value ?? friends.input?.rename ?? '').trim();
      friends.mode = 'view';
      if (!name || name === playerName()) return;
      void run(async () => {
        const acc = accountExtras(app());
        if (acc.rename) return acc.rename(name);
        await app().services.account.setDisplayName(name);
        return null;
      }, () => ui().toast('Name saved'));
    },
    'f-rename-cancel': () => {
      friends.mode = 'view';
    },
    'f-copy': () => (myFriendId() === '—' ? ui().toast("Your friend ID appears once you're connected to the Nomad server") : copy(myFriendId(), 'Friend ID copied')),
    'f-share': () => {
      if (myFriendId() === '—') return ui().toast("Your friend ID appears once you're connected to the Nomad server");
      // No add-friend deep link exists yet: the invite is the friend ID itself.
      copy(`Add me on Nomad Poker! My friend ID is ${myFriendId()}`, 'Invite copied');
    },
    'f-accept': (v) => void run(async () => {
      const r = await Friends.acceptAsync(v);
      return r.success ? null : r.error;
    }),
    'f-decline': (v) => {
      const f = Friends.find(v);
      ui().message('Decline request?', `${esc(f ? friendLabel(f) : 'This player')} won't be added.`, 'Decline', () => void run(async () => {
        const r = await Friends.removeAsync(v);
        return r.success ? null : r.error;
      }), 'Cancel', undefined, 'red');
    },
    'f-more': (v) => {
      const f = Friends.find(v);
      if (!f) return;
      ui().message(esc(friendLabel(f)), 'Remove this friend?', 'Remove', () => void run(async () => {
        const r = await Friends.removeAsync(v);
        return r.success ? null : r.error;
      }), 'Cancel', undefined, 'red');
    },
    'f-join': (v) => {
      const invite = FriendInvites.inbox.find((i) => i.fromId === v);
      if (invite) void run(() => FriendInvites.acceptAsync(invite));
    },
    'f-invite': (v) => {
      const f = Friends.find(v);
      if (!f || !FriendInvites.currentTable) return ui().toast('Sit at a table to invite friends');
      void run(async () => {
        const r = await FriendInvites.inviteAsync(f);
        return r.success ? null : r.error;
      }, () => ui().message('Invite sent', `${esc(friendLabel(f))} can join your table from their Friends list.`));
    },
  },
  profileHtml(nFriends: number, nOnline: number, nReq: number): string {
    const lv = level();
    const nameRow = this.mode === 'rename'
      ? `<div class="v2-row" style="width:100%;margin-top:.6em">${input('rename', this.input?.rename ?? playerName(), 'Your name', { cls: 'v2-grow', max: 24 })}<button class="v2-b gold sm" data-a="f-rename-save" data-enter="rename">Save</button><button class="v2-pill"${act('f-rename-cancel')} aria-label="Cancel">${ico('close', 0.9)}</button></div>`
      : `<div class="v2-row v2-fr-name"><b class="v2-ellip">${esc(playerName())}</b><button class="v2-pill"${act('f-rename')} aria-label="Rename">${ico('edit', 1)}</button></div>`;
    return `<button class="v2-fr-toggle"${act('f-profile')} aria-label="Show profile">${avatar('s')}<b class="v2-grow v2-ellip">${esc(playerName())}</b><span class="v2-xs v2-mut">${esc(myFriendId())}</span>${ico('chev', 1.2)}</button>
<div class="v2-col v2-fr-prof">
  <div class="v2-fr-av">${avatar('', avatarUrl(), 'width:7em;height:7em')}<span class="v2-lvb v2-fr-lv">LV ${lv.level}</span><button class="v2-editb"${act('f-edit')} aria-label="Edit picture">${ico('edit', 1)}</button></div>
  ${nameRow}
  <span class="v2-sm v2-mut">${(accountExtras(app()).isGuest ?? PokerClientIdentity.isGuest) ? 'Guest account' : 'Signed in'}</span>
  <div class="v2-card v2-row" style="width:100%"><div class="v2-grow" style="text-align:left"><small class="v2-cap">Friend ID</small><div class="v2-num" style="font-weight:900">${esc(myFriendId())}</div></div>${btn('Copy', 'f-copy', { h: 'blue', c: 'sm' })}</div>
  ${btn('Share invite link', 'f-share', { h: 'violet', c: 'w' })}
  <div class="v2-row" style="width:100%;gap:.5em">${[[nFriends, 'Friends'], [nOnline, 'Online'], [nReq, 'Requests']].map(([n, l]) => `<div class="v2-card v2-grow v2-col v2-fr-stat"><b>${n}</b><small class="v2-mut">${l}</small></div>`).join('')}</div>
</div>`;
  },
  pickerHtml(): string {
    const n = Number(S('avatars')?.count ?? AvatarCatalog.count);
    const sprite = (i: number): string | null => (S('avatars')?.spriteUrl?.(i) as string | null) ?? null;
    let tiles = '';
    for (let i = 1; i <= n; i++)
      tiles += `<button class="v2-fr-tile${i === this.pick ? ' on' : ''}"${act('f-pick', i)} aria-label="Avatar ${i}">${avatar('', sprite(i), 'width:100%;height:auto;aspect-ratio:1')}</button>`;
    return `<b class="v2-h">Choose your picture</b><div class="v2-fr-grid v2-scroll">${tiles}</div><div class="v2-row" style="width:100%">${btn('Cancel', 'f-pick-cancel', { h: 'ghost', c: 'v2-grow' })}${btn('Save', 'f-pick-save', { h: 'gold', c: 'v2-grow' })}</div>`;
  },
};

function addFriend(): void {
  prompt('Add a friend', 'Enter their friend ID or name.', 'Friend ID or name', '', 'Send request', (id) => {
    if (!id) return;
    void run(async () => {
      const r = await Friends.sendRequestAsync(id);
      return r.success ? null : r.error;
    }, () => ui().message('Request sent', "They'll see it under Requests."));
  }, 40);
}

// ------------------------------------------------------------------ Leaderboard

const KINDS: [string, string, LeaderboardKind][] = [
  ['weekly', 'Weekly', LeaderboardKind.WeeklyEarnings],
  ['monthly', 'Monthly', LeaderboardKind.SeasonEarnings],
  ['hands', 'Hands', LeaderboardKind.HandsWon],
  ['friends', 'Friends', LeaderboardKind.FriendsWeekly],
];
const CROWN = ['#ffc21f', '#d6dde8', '#e09a5a'];

const leaderboard: ScreenDef & { tab: string; board: LeaderboardSnapshot | null; loading: boolean; gen: number; off: (() => void) | null; load(): void } = {
  id: 'leaderboard',
  replaces: ['Leaderboard'],
  tab: 'weekly',
  board: null,
  loading: false,
  gen: 0,
  off: null,
  open() {
    this.tab = 'weekly';
    this.off = FreePlayLeaderboard.changed.on(() => ui().render());
    this.load();
  },
  close() {
    this.off?.();
    this.off = null;
  },
  load() {
    const kind = KINDS.find((k) => k[0] === this.tab)![2];
    const mine = ++this.gen;
    this.loading = true;
    void FreePlayLeaderboard.fetchAsync(kind, 0).then(
      (snap) => {
        if (mine !== this.gen) return;
        this.board = snap;
        this.loading = false;
        ui().render();
      },
      (e) => {
        console.warn('[ui2] leaderboard', e);
        if (mine !== this.gen) return;
        this.loading = false;
        ui().render();
      },
    );
  },
  render() {
    const kind = KINDS.find((k) => k[0] === this.tab)![2];
    const hands = kind === LeaderboardKind.HandsWon;
    // Say what the score is: it's Coins won in the period (not your balance), or hands won.
    const col = hands ? 'Hands won' : 'Coins won';
    let body: string;
    if (onchain()) {
      const addr = onchainApi.walletAddress?.();
      body = !addr
        ? `<div class="v2-empty">${ico('sol', 6)}<b class="v2-h" style="font-size:1.6em;color:var(--v2-ink)">Connect your wallet</b><span>The on-chain leaderboard ranks players by SOL won.<br>Connect a Solana wallet (devnet) to see it and your rank.</span>${btn('Connect Wallet', 'lb-connect', { h: 'gold', c: 'lg' })}</div>`
        : `<div class="v2-empty">${ico('sol', 6)}<b class="v2-h" style="font-size:1.6em;color:var(--v2-ink)">On-chain rankings are coming</b><span>SOL winnings aren't ranked yet. Switch to Demo for the Coins leaderboard.</span>${btn('Show Demo', 'mode', { h: 'violet', v: 'demo' })}</div>`;
    } else {
      const b = this.board && this.board.kind === kind ? this.board : null;
      const rows = b ? b.rows.slice(0, 10) : [];
      const list = rows.length
        ? rows.map((r) => {
            const i = r.rank - 1;
            const g = i < 3 ? ` g${i + 1}` : '';
            const rank = i < 3 ? ico('crown', 1.6, `color:${CROWN[i]}`) : `<b>${r.rank}</b>`;
            return `<div class="v2-lbr${g}${r.isLocal ? ' you' : ''}"><span class="v2-lb-rank">${rank}</span><span class="v2-row" style="gap:.6em;min-width:0">${avatar('xs', r.isLocal ? avatarUrl() : avatarFor(r.displayName))}<span class="v2-ellip">${esc(r.displayName)}</span>${r.isLocal ? '<span class="v2-pill gold">You</span>' : ''}</span><b class="v2-num" style="text-align:right">${formatN0(r.score)}</b></div>`;
          }).join('')
        : `<div class="v2-empty">${ico('podium', 5)}${this.loading ? 'Loading…' : kind === LeaderboardKind.FriendsWeekly ? 'Add friends to see how you rank against them.' : 'No scores yet this period.'}</div>`;
      const rank = b?.localRank ?? 0;
      body = `<div class="v2-lbr hdr"><span>Rank</span><span>Player</span><span style="text-align:right">${esc(col)}</span></div>
<div class="v2-col v2-scroll v2-grow v2-lb-list">${list}</div>
${rows.some((r) => r.isLocal) ? `<div class="v2-lbdiv"></div><div class="v2-lbnote">${kind === LeaderboardKind.SeasonEarnings ? 'Season standings' : 'Resets every Monday (UTC)'}</div>` : `<div class="v2-lbdiv"><span>Your rank</span></div><div class="v2-lbnote">${kind === LeaderboardKind.SeasonEarnings ? 'Season standings' : 'Resets every Monday (UTC)'}</div>
<div class="v2-lbr you"><span class="v2-lb-rank"><b>${rank > 0 ? rank : '–'}</b></span><span class="v2-row" style="gap:.6em;min-width:0">${avatar('xs')}<span class="v2-ellip">${esc(playerName())}</span><span class="v2-pill gold">You</span></span><b class="v2-num" style="text-align:right">${formatN0(FreePlayLeaderboard.localScore(kind))}</b></div>`}`;
    }
    return `${topBar('Leaderboard')}
<div class="v2-body v2-lb">
  ${tabs(KINDS.map(([k, l]) => [k, l] as [string, string]), this.tab, 'lb-tab')}
  <div class="v2-panel v2-col v2-grow v2-lb-panel">${body}</div>
</div>`;
  },
  actions: {
    'lb-tab': (v) => {
      leaderboard.tab = v;
      leaderboard.load();
    },
    'lb-connect': async () => {
      await onchainApi.connectWallet?.();
    },
    mode: (v) => setMode(v),
  },
};

export function socialScreens(): ScreenDef[] {
  return [friends, leaderboard];
}
