/** Lobby: Main menu (with the profile popover) and Settings. Atlas: Redesign v2 › Lobby. */
import { quickPlay, openDailySpin, settingsAccountExtras } from '../../menu/screens/mainMenu';
import { PokerAudio } from '../../menu/audio';
import { btn, esc, fmt, slider, out, act } from '../core';
import { ico, card, chipArt } from '../icons';
import {
  ui, host, app, S, onchain, onchainApi, avatar, level, coinCap, modeSeg, setMode, playerName, accountExtras,
  canSpin, prompt, run, openUrl, signedIn, needCoins,
} from '../ctx';
import type { ScreenDef } from '../install';
import './lobby.css';

const DISCORD_URL = 'https://discord.gg/vzsnDU5zyM';
const TWITTER_URL = 'https://x.com/PlayNomadPoker';

/** Opens a Unity screen name through the host (a v2 screen when it has one). */
export const unity = (name: string): void => host().show(name);

function dockItem(icon: string, label: string, sub: string, a: string, v: string, badge = ''): string {
  return `<button class="v2-dk"${act(a, v)} aria-label="${esc(label)}"><span class="v2-dk-i">${ico(icon, 2.9)}${badge}</span><b>${esc(label)}</b><small>${esc(sub)}</small></button>`;
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
  },
  backFirst() {
    if (!this.profile) return false;
    this.profile = false;
    return true;
  },
  render() {
    const chain = onchain();
    const lv = level();
    const tier = host().stakes.resolve();
    const st0 = chain ? onchainApi.tableStakes?.(0) : null;
    const [wSub, wDot] = weeklySub();
    const miss = claimableMissions();
    const dot = '<i class="v2-dot"></i>';
    const tile = (a: string, v: string, cls: string, title: string, sub: string, art: string) =>
      `<button class="v2-mtile ${cls}"${act(a, v)}><div class="v2-mart">${art}</div><div class="v2-mlbl"><b>${title}</b><span>${esc(sub)}</span></div></button>`;
    const addr = onchainApi.walletAddress?.();
    return `
<div class="v2-mm-top">
  <div class="v2-rplayer">
    <button class="v2-row v2-pl"${act('profile')} aria-label="Profile">${avatar('', undefined, 'width:3.6em;height:3.6em')}<div class="v2-grow"><b class="v2-ellip v2-pl-name">${esc(playerName())}</b><div class="v2-xs v2-mut v2-ellip">${chain && addr ? `${esc(addr.slice(0, 4))}…${esc(addr.slice(-4))} · devnet` : (accountExtras(app()).isGuest ?? true) ? 'Guest · online' : 'Signed in · online'}</div></div></button>
    <button class="v2-row"${act('unity', 'LevelRewards')} aria-label="Level and missions"><span class="v2-lvb">LV ${lv.level}</span><div class="v2-bar"><i style="width:${Math.round(lv.p * 100)}%"></i></div>${lv.next ? `<span class="v2-xs v2-num">${fmt(lv.into)} / ${fmt(lv.next)} XP</span>` : ''}</button>
  </div>
  <div class="v2-rlogo" aria-label="Nomad Poker">NOMAD<br><span>POKER</span></div>
  <div class="v2-row v2-mm-right">${coinCap()}${modeSeg()}<button class="v2-ib"${act('settings')} aria-label="Settings">${ico('gear', 2.1)}</button></div>
</div>
<div class="v2-mtiles">
  ${tile('unity', 'TableSelect_TownLobby', 't-gold', 'TABLES', chain ? 'SOL public & private tables' : 'Pick your stakes', `<div class="v2-mfelt"></div><div class="v2-mcards">${card('A♠') + card('K♥') + card('Q♦')}</div>${chipArt('#2f6bff', 1.4, 1.4)}${chipArt('#ff4f7a', 14.5, 10.5, 2.6, 30)}`)}
  ${tile('quick', '', 't-blue', 'QUICK PLAY', chain ? `SOL ${(st0?.label ?? 'Micro').split(' ')[0]} · ${st0?.blinds ?? ''}` : `${tier.displayName} · ${tier.smallBlind} / ${tier.bigBlind} · instant seat`, `<div class="v2-mart-c">${ico('bolt', 9)}</div>${chipArt('#ffc21f', 2, 9.5, 2.8, -20)}${chipArt('#8048f5', 14, 1.6, 3)}`)}
  ${tile('unity', 'PartyMenu', 't-violet', 'PARTY', chain ? 'Host a private SOL table' : 'Private table with friends', `<div class="v2-mart-c">${ico('friends', 8.5)}</div><div class="v2-mjack">${card('J♣')}</div>${chipArt('#22c468', 1.6, 2, 2.8)}`)}
</div>
<div class="v2-rdock">
  <div class="v2-dg"><span class="v2-dgl">REWARDS</span>
    ${dockItem('spin', 'Daily Spin', canSpin(app()) ? 'Ready' : 'Tomorrow', 'spin', '', canSpin(app()) ? dot : '')}
    ${dockItem('cal', 'Weekly', wSub, 'weekly', '', wDot ? dot : '')}
    ${dockItem('clip', 'Missions', miss ? `${miss} to claim` : 'In progress', 'unity', 'LevelRewards', miss ? `<i class="v2-cnt">${miss}</i>` : '')}
  </div>
  <div class="v2-dg"><span class="v2-dgl">COMMUNITY</span>
    ${dockItem('friends', 'Friends', friendsSub(), 'unity', 'Friends', Number(S('friends')?.incomingCount ?? 0) ? dot : '')}
    ${dockItem('robot', 'Agents', agentSub(), 'unity', 'Agents_Overview')}
    ${dockItem('podium', 'Leaderboard', 'Weekly', 'unity', 'Leaderboard')}
    ${dockItem('trophy', 'Tournaments', 'Browse', 'unity', 'Tournaments_Browse')}
  </div>
  <div class="v2-dg v2-shopg">${dockItem('bag', 'Shop', chain ? 'SOL items' : 'Coins & more', 'go', 'shop')}</div>
</div>
${this.profile ? profilePanel() : ''}`;
  },
  actions: {
    unity: (v) => unity(v),
    quick: () => {
      const h = host();
      if (signedIn() && !onchain() && needCoins(h.stakes.resolve().minBuyIn, 'Quick Play')) return;
      quickPlay(h);
    },
    spin: () => openDailySpin(host()),
    weekly: () => host().actions.openWeeklyRewards?.(),
    settings: () => openSettings(),
    mode: (v) => setMode(v),
    profile: () => {
      main.profile = !main.profile;
    },
    'profile-close': () => {
      main.profile = false;
    },
    'pf-avatar': () => {
      main.profile = false;
      const f = S('friends');
      if (f?.openAvatarPicker) f.openAvatarPicker();
      else ui().message('Avatar', "The avatar picker isn't loaded.");
    },
    'pf-rename': () => renameDialog(),
    'pf-deposit': () => {
      if (!onchainApi.walletAddress?.()) return void onchainApi.connectWallet?.();
      return void onchainApi.deposit?.();
    },
    'pf-withdraw': () => void onchainApi.withdraw?.(),
    'pf-wallet': () => onchainApi.copyWallet?.(),
    'pf-balance': () => void onchainApi.refreshSol?.(),
  },
};

function profilePanel(): string {
  const addr = onchainApi.walletAddress?.() ?? null;
  return `<div class="v2-pop-dim"${act('profile-close')}></div>
<div class="v2-profile v2-panel" role="dialog" aria-label="Profile">
  <div class="v2-row" style="gap:1em">
    <button class="v2-pf-av"${act('pf-avatar')} aria-label="Change your picture">${avatar('', undefined, 'width:5em;height:5em')}<span class="v2-editb">✎</span></button>
    <div class="v2-grow"><div class="v2-row"><b class="v2-ellip" style="font-size:1.3em">${esc(playerName())}</b><button class="v2-pill"${act('pf-rename')} aria-label="Rename">✎</button></div>
    <div class="v2-xs v2-mut">${(accountExtras(app()).isGuest ?? true) ? 'Guest account' : 'Signed in'}</div></div>
  </div>
  <div class="v2-cap" style="margin-top:.9em">Play mode</div>
  ${modeSeg()}
  <div class="v2-cap" style="margin-top:.9em">Wallet (SOL · devnet)</div>
  <button class="v2-card v2-row" style="width:100%;text-align:left"${act('pf-wallet')}>${addr ? `${esc(addr.slice(0, 4))}…${esc(addr.slice(-4))}` : 'Not connected'}<span class="v2-grow"></span><span class="v2-xs v2-mut">${addr ? 'Copy' : 'Connect'}</span></button>
  ${addr ? `<button class="v2-card" style="width:100%;text-align:left;margin-top:.4em"${act('pf-balance')}><span class="v2-xs v2-mut">Game balance</span><div>${esc(onchainApi.balanceText?.() ?? '')}</div></button>` : ''}
  <div class="v2-row" style="margin-top:.8em">${btn(addr ? 'Deposit' : 'Connect wallet', 'pf-deposit', { h: 'gold', c: 'v2-grow' })}${addr ? btn('Withdraw', 'pf-withdraw', { h: 'ghost', c: 'v2-grow' }) : ''}</div>
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
  const h = host();
  if (signedIn() && (acc.isGuest ?? true)) {
    if (acc.signInWithGoogle) rows.push(['Save with Google', () => void acc.signInWithGoogle!()]);
    if (acc.addRecoveryLogin)
      rows.push(['Save with email', () => prompt('Save your account', 'We send a one-time sign-in link to this email.', 'Email', '', 'Save', (email) => {
        if (email) void run(() => acc.addRecoveryLogin!(email, ''), () => ui().message('Account saved', 'Sign in with this email on any device: your Coins and progress come with you.'));
      }, 80)]);
  }
  if (signedIn() && acc.signInAsGuest)
    rows.push(['Sign out', () => ui().message('Sign out?', (acc.isGuest ?? true) ? "This is a guest account: without Google or an email saved, you can't get back into it from another device." : 'You can sign back in any time.', 'Sign out', () => void app().services.account.signOut(), 'Cancel', undefined, 'red')]);
  for (const extra of settingsAccountExtras) extra(h, rows);
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
      `<div class="v2-row v2-set-row v2-wrap"><span class="v2-set-l">Community</span>${btn('Discord', 'set-discord', { h: 'violet', c: 'sm' })}${btn('X', 'set-x', { h: 'ghost', c: 'sm' })}</div>` +
      (rows.length ? `<div class="v2-row v2-set-row v2-wrap"><span class="v2-set-l">Account</span>${rows.map(([l], i) => btn(esc(l), `set-acc${i}`, { h: /sign out|disconnect/i.test(l) ? 'red' : 'blue', c: 'sm' })).join('')}</div>` : ''),
    buttons: btn('Close', 'set-close', { h: 'gold' }),
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
  // The SOL capsule on any top bar opens the profile popover (wallet, balance, Deposit / Withdraw).
  ui().globalActions['profile-open'] = () => {
    if (ui().currentId !== 'main') ui().show('main');
    main.profile = true;
  };
  return [main];
}
