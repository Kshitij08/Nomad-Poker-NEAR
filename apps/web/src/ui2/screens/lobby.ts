/** Lobby: Main menu (with the profile popover) and Settings. Atlas: Redesign v2 › Lobby. */
import { openDailySpin } from '../../menu/play';
import { PokerAudio } from '../../menu/audio';
import { btn, esc, fmt, slider, out, act } from '../core';
import { ico, preloadArt } from '../icons';
import {
  ui, host, app, S, onchain, nearAccountId, avatar, level, coinCap, modeSeg, setMode, playerName, accountExtras,
  canSpin, prompt, run, openUrl, signedIn,
} from '../ctx';
import type { ScreenDef } from '../install';
import { roomStage, roomActions, syncRoom, installRoomGestures } from './rooms';
import { connectNear } from '../ctx';
import { nearBalance, refreshNearBalance } from '../../near/balance';
import { formatNear } from '../../near/backing';
import { nearBackup, playingLocal } from '../nearAccount';
import './lobby.css';

const DISCORD_URL = 'https://discord.gg/vzsnDU5zyM';
const TWITTER_URL = 'https://x.com/PlayNomadPoker';

// The main menu's art icons load while the sign-in screen is up, so the dock doesn't pop in.
preloadArt(['spin', 'cal', 'clip', 'friends', 'robot', 'podium', 'trophy', 'bag', 'gear', 'coin', 'lock']);

/** Opens a Unity screen name through the host (a v2 screen when it has one). */
export const unity = (name: string): void => host().show(name);

function dockItem(icon: string, label: string, sub: string, a: string, v: string, badge = ''): string {
  // The status ("Ready", "2 to claim"…) is spoken, not shown: the dock shows the label and its badge only.
  return `<button class="v2-dk"${act(a, v)} aria-label="${esc(sub ? `${label}, ${sub}` : label)}"><span class="v2-dk-i">${ico(icon, 2.9)}${badge}</span><b>${esc(label)}</b></button>`;
}

function claimableMissions(): number {
  try {
    return (S('retention')?.missionRows?.('all') ?? []).filter((r: { canClaim: boolean }) => r.canClaim).length;
  } catch {
    return 0;
  }
}

function weeklySub(): [string, boolean] {
  try {
    const p = S('retention')?.engagement?.previewLogin?.();
    if (!p) return ['Login streak', false];
    return [p.canClaim ? `Day ${p.day} ready` : `Day ${Math.max(1, (p.day ?? 1) - 1)} done`, !!p.canClaim];
  } catch {
    return ['Login streak', false];
  }
}

function friendsSub(): string {
  const f = S('friends');
  const all = (f?.all ?? []) as { relation: number; online?: boolean; lastLogin: number | null }[];
  const friends = all.filter((x) => x.relation === 0 || (x as { relation: unknown }).relation === 'Friend');
  const online = friends.filter((x) => x.online ?? (x.lastLogin !== null && Date.now() - x.lastLogin < 15 * 60_000)).length;
  const req = Number(f?.incomingCount ?? 0);
  return req ? `${req} request${req > 1 ? 's' : ''}` : friends.length ? `${online} online` : 'Add friends';
}

function agentSub(): string {
  try {
    const st = S('agents')?.status?.();
    return st?.pill === 'Playing' ? '1 playing' : st?.pill === 'Stopping' ? 'Stopping' : 'Idle';
  } catch {
    return 'AFK play';
  }
}

// ------------------------------------------------------------------ main menu

const main: ScreenDef & { profile: boolean } = {
  id: 'main',
  replaces: ['MainMenu'],
  profile: false,
  open() {
    this.profile = false;
    syncRoom();
  },
  backFirst() {
    if (!this.profile) return false;
    this.profile = false;
    return true;
  },
  render() {
    const chain = onchain();
    const lv = level();
    const [wSub, wDot] = weeklySub();
    const miss = claimableMissions();
    const dot = '<i class="v2-dot"></i>';
    const addr = nearAccountId();
    return `
<div class="v2-mm-top">
  <div class="v2-rplayer" title="${esc(chain && addr ? addr : (accountExtras(app()).isGuest ?? true) ? 'Guest account' : 'Signed in')}">
    <button class="v2-pl"${act('profile')} aria-label="Profile">${avatar('', undefined, 'width:100%;height:100%')}</button>
    <div class="v2-pl-txt">
      <button class="v2-pl-nameb"${act('profile')} aria-label="Profile"><b class="v2-ellip v2-pl-name">${esc(playerName())}</b></button>
      <button class="v2-row v2-pl-lv"${act('unity', 'LevelRewards')} aria-label="Level and missions"><span class="v2-lvb">LV ${lv.level}</span><div class="v2-bar"><i style="width:${Math.round(lv.p * 100)}%"></i></div>${lv.next ? `<span class="v2-xs v2-num">${fmt(lv.into)} / ${fmt(lv.next)}</span>` : ''}</button>
    </div>
  </div>
  <h1 class="v2-rlogo"><img src="/assets/menu/galaxy/nomad_poker_logo_flat.webp" alt="Nomad Poker" draggable="false"></h1>
  <div class="v2-mm-right">${coinCap()}${modeSeg()}<button class="v2-ib"${act('settings')} aria-label="Settings">${ico('gear', 2.1)}</button></div>
</div>
${roomStage()}
<div class="v2-rdock">
  <div class="v2-dg"><span class="v2-dgl">Rewards</span>
    ${dockItem('spin', 'Daily spin', canSpin(app()) ? 'Ready' : 'Tomorrow', 'spin', '', canSpin(app()) ? dot : '')}
    ${dockItem('cal', 'Weekly', wSub, 'weekly', '', wDot ? dot : '')}
    ${dockItem('clip', 'Missions', miss ? `${miss} to claim` : 'In progress', 'unity', 'LevelRewards', miss ? `<i class="v2-cnt">${miss}</i>` : '')}
  </div>
  <div class="v2-dg"><span class="v2-dgl">Community</span>
    ${dockItem('friends', 'Friends', friendsSub(), 'unity', 'Friends', Number(S('friends')?.incomingCount ?? 0) ? dot : '')}
    ${chain ? dockItem('robot', 'Agents', 'Back a pro', 'go', 'ag-back') : dockItem('robot', 'Agents', agentSub(), 'unity', 'Agents_Overview')}
    ${dockItem('podium', 'Leaderboard', 'Weekly', 'unity', 'Leaderboard')}
    ${dockItem('trophy', 'Tournaments', 'Browse', 'unity', 'Tournaments_Browse')}
  </div>
  <div class="v2-dg v2-shopg">${dockItem('bag', 'Shop', 'Coins & more', 'go', 'shop')}</div>
</div>
${this.profile ? profilePanel() : ''}`;
  },
  actions: {
    unity: (v) => unity(v),
    ...roomActions,
    spin: () => openDailySpin(host()),
    weekly: () => host().actions.openWeeklyRewards?.(),
    settings: () => openSettings(),
    mode: (v) => setMode(v),
    profile: () => {
      main.profile = !main.profile;
      const addr = nearAccountId();
      if (main.profile && addr) {
        void refreshNearBalance(addr, () => ui().render());
        void playingLocal(addr).then((v) => {
          profileLocal = v;
          ui().render();
        });
      }
    },
    'profile-close': () => {
      main.profile = false;
    },
    // One picture picker for the game: the v2 Friends picker (the legacy FriendsHud sheet is never opened from here).
    'pf-avatar': () => {
      main.profile = false;
      ui().show('friends', 'edit');
    },
    'pf-rename': () => renameDialog(),
    'pf-near-signin': () => {
      main.profile = false;
      void connectNear();
    },
    'pf-backup': () => void nearBackup(),
  },
};

/** The profile's NEAR account was made for this player (its key is in this browser): offer a backup. */
let profileLocal = false;

function profilePanel(): string {
  const addr = nearAccountId();
  const yocto = nearBalance(addr);
  return `<div class="v2-pop-dim"${act('profile-close')}></div>
<div class="v2-profile v2-panel" role="dialog" aria-label="Profile">
  <div class="v2-row" style="gap:1em">
    <button class="v2-pf-av"${act('pf-avatar')} aria-label="Change your picture">${avatar('', undefined, 'width:5em;height:5em')}<span class="v2-editb">${ico('edit', 1)}</span></button>
    <div class="v2-grow"><div class="v2-row"><b class="v2-ellip" style="font-size:1.3em">${esc(playerName())}</b><button class="v2-pill"${act('pf-rename')} aria-label="Rename">${ico('edit', 1)}</button></div>
    <div class="v2-xs v2-mut">${(accountExtras(app()).isGuest ?? true) ? 'Guest account' : 'Signed in'}</div></div>
  </div>
  <div class="v2-cap" style="margin-top:.9em">Play mode</div>
  ${modeSeg()}
  <div class="v2-cap" style="margin-top:.9em">NEAR account (testnet)</div>
  <div class="v2-card v2-row" style="gap:.5em">${ico('near', 1.4)}<span class="v2-ellip v2-grow">${addr ? esc(addr) : 'Not signed in with NEAR'}</span></div>
  ${addr ? `<div class="v2-row" style="margin-top:.5em"><span class="v2-grow v2-sm v2-mut">Game balance</span><b class="v2-num">${yocto === null ? '—' : esc(formatNear(yocto))} NEAR</b></div>` : ''}
  <div class="v2-row" style="margin-top:.8em">${addr ? btn(`${ico('plus', 0.9)} Deposit`, 'near-deposit', { h: 'gold', c: 'v2-grow' }) + btn('Withdraw', 'near-withdraw', { h: 'ghost', c: 'v2-grow' }) : btn('Continue with NEAR', 'pf-near-signin', { h: 'gold', c: 'v2-grow' })}</div>
  ${addr && profileLocal ? `<div class="v2-row" style="margin-top:.4em">${btn('Back up my NEAR key', 'pf-backup', { h: 'ghost', c: 'sm v2-grow' })}</div>` : ''}
</div>`;
}

function renameDialog(): void {
  prompt('Change your name', 'Pick the name other players see.', 'Your name', playerName(), 'Save', (name) => {
    if (!name) return;
    void run(async () => {
      const acc = accountExtras(app());
      if (acc.rename) return acc.rename(name);
      await app().services.account.setDisplayName(name);
      return null;
    });
  }, 24);
}

// ------------------------------------------------------------------ settings

/** Settings (v2): Music / Sound effects sliders, Community links, account buttons. */
export function openSettings(): void {
  const acc = accountExtras(app());
  const rows: [string, () => void][] = [];
  if (signedIn() && (acc.isGuest ?? true)) {
    if (acc.signInWithNear) rows.push(['Save with NEAR', () => void acc.signInWithNear!()]);
    if (acc.signInWithGoogle) rows.push(['Save with Google', () => void acc.signInWithGoogle!()]);
    if (acc.addRecoveryLogin)
      rows.push(['Save with email', () => prompt('Save your account', 'We send a one-time sign-in link to this email.', 'Email', '', 'Save', (email) => {
        if (email) void run(() => acc.addRecoveryLogin!(email, ''), () => ui().message('Account saved', 'Sign in with this email on any device: your Coins and progress come with you.'));
      }, 80)]);
  }
  if (signedIn() && acc.signInAsGuest) {
    const saves = rows.slice(); // the Save with Google / email rows (guests only)
    rows.push(['Sign out', () => {
      const signOut = () => void app().services.account.signOut();
      if (!(acc.isGuest ?? true)) return ui().message('Sign out?', 'You can sign back in any time.', 'Sign out', signOut, 'Cancel', undefined, 'red');
      // A guest who signs out can't come back: offer the saves first.
      const a: Record<string, () => void> = { 'so-cancel': () => ui().closeDialog(), 'so-out': () => { ui().closeDialog(); signOut(); } };
      saves.forEach(([, fn], i) => (a[`so-save${i}`] = () => { ui().closeDialog(); fn(); }));
      ui().openDialog({
        title: 'Sign out?',
        body: "You'll lose this guest account, with its Coins and progress. Save it with NEAR, Google or email first to keep them.",
        buttons: `<div class="v2-btn-grid">${saves.map(([l], i) => btn(esc(l), `so-save${i}`, { h: 'blue' })).join('')}${btn('Cancel', 'so-cancel', { h: 'ghost' })}${btn('Sign out', 'so-out', { h: 'red' })}</div>`,
        actions: a,
      });
    }]);
  }
  const actions: Record<string, () => void> = {
    'set-close': () => ui().closeDialog(),
    'set-discord': () => openUrl(DISCORD_URL),
    'set-x': () => openUrl(TWITTER_URL),
  };
  rows.forEach(([, fn], i) => (actions[`set-acc${i}`] = () => {
    ui().closeDialog();
    fn();
  }));
  const vol = (label: string, key: string, v: number) =>
    `<div class="v2-row v2-set-row"><span class="v2-set-l">${label}</span><div class="v2-grow">${slider(key, v * 100, label)}</div><b class="v2-set-v">${out(key, v * 100)}</b></div>`;
  ui().openDialog({
    title: 'Settings',
    wide: true,
    body: () => vol('Music', 'set-music', PokerAudio.musicVolume) + vol('Sound effects', 'set-sfx', PokerAudio.sfxVolume) +
      `<div class="v2-row v2-set-row v2-wrap"><span class="v2-set-l">Community</span>${btn('Discord', 'set-discord', { h: 'violet', c: 'sm' })}${btn(`${ico('xlogo', 0.95)} X (Twitter)`, 'set-x', { h: 'ghost', c: 'sm', title: 'Nomad Poker on X' })}</div>` +
      (rows.length ? `<div class="v2-row v2-set-row v2-wrap"><span class="v2-set-l">Account</span>${rows.map(([l], i) => btn(esc(l), `set-acc${i}`, { h: /sign out|disconnect/i.test(l) ? 'red' : 'blue', c: 'sm' })).join('')}</div>` : ''),
    buttons: btn('Close', 'set-close', { h: 'ghost' }),
    actions,
  });
}

/** Slider keys of the settings dialog; the screen under it routes them here. */
export function settingsSlide(key: string, v: number): boolean {
  if (key === 'set-music') PokerAudio.musicVolume = v / 100;
  else if (key === 'set-sfx') PokerAudio.sfxVolume = v / 100;
  else return false;
  return true;
}
main.slide = (k, v) => void settingsSlide(k, v);

export function lobbyScreens(): ScreenDef[] {
  installRoomGestures();
  // The profile popover from any top bar (play mode, NEAR account).
  ui().globalActions['profile-open'] = () => {
    if (ui().currentId !== 'main') ui().show('main');
    main.profile = true;
  };
  return [main];
}
