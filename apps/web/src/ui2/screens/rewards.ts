/** Rewards: Weekly rewards (login streak) and Level & missions. Atlas: Redesign v2 › Rewards. */
import { LevelRewardCatalog, LoginRewardCatalog, loginRewardSummary, MissionKind, MissionProgressMath, type LoginDayReward } from '@nomad/engine/retention';
import { nomadGrants } from '../../retention/retentionService';
import { RewardKind } from '../../app/services';
import { btn, esc, fmt, tabs } from '../core';
import { ico, coinStack } from '../icons';
import { ui, app, S, topBar, avatar, sfx } from '../ctx';
import { PokerSound } from '@nomad/engine';
import type { ScreenDef } from '../install';
import './rewards.css';

const DAY_MS = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function retention(): any {
  return S('retention');
}

// ------------------------------------------------------------------ weekly rewards

type DayState = 'claimed' | 'claim' | 'locked';

/** Same rules as the Unity WeeklyRewardsScreen.refresh(). */
function dayStates(): { states: DayState[]; streak: number; shields: number; note: string } {
  const r = retention();
  const states: DayState[] = [];
  if (!r) return { states: Array(7).fill('locked'), streak: 0, shields: 0, note: '' };
  const st = r.engagement.load();
  const p = r.engagement.previewLogin();
  for (let day = 1; day <= 7; day++) {
    let done: boolean;
    let current: boolean;
    if (p.reset && p.canClaim) {
      done = false;
      current = day === p.day;
    } else if (!p.canClaim) {
      done = day <= st.streakDay;
      current = day === st.streakDay;
    } else {
      done = day < p.day;
      current = day === p.day;
    }
    states.push(current && p.canClaim ? 'claim' : done ? 'claimed' : 'locked');
  }
  const note = p.canClaim && p.tokenConsumed ? "A Streak Shield will cover yesterday's miss." : p.canClaim && p.reset ? 'Streak reset: starting a new 7-day track.' : 'Log in daily to claim your rewards and keep your streak going!';
  const shields = Number(r.wallet?.streakTokens ?? app().services.wallet?.streakTokens ?? 0);
  return { states, streak: Number(st.streakDay ?? 0), shields, note };
}

function rewardArt(d: LoginDayReward, size: number): string {
  if (d.primary.kind === RewardKind.Xp) return ico('xp', size * 1.25);
  const n = d.primary.amount >= 2500 ? 3 : d.primary.amount >= 750 ? 2 : 1;
  return coinStack(n, size);
}

const weekly: ScreenDef & { busy: boolean } = {
  id: 'weekly',
  busy: false,
  render() {
    const { states, streak, shields, note } = dayStates();
    const days = LoginRewardCatalog.Days;
    const statePill = (s: DayState) =>
      s === 'claimed' ? `<span class="v2-pill ok">${ico('check', 1)} Claimed</span>` : s === 'claim' ? btn('Claim', 'claim', { h: 'green', c: 'w', dis: this.busy }) : `<span class="v2-pill">${ico('lock', 1)} Locked</span>`;
    const left = days.slice(0, 6).map((d, i) => `
      <div class="v2-panel v2-day${states[i] === 'claim' ? ' today' : ''}">
        <b class="v2-day-t">${esc(d.title)}</b>
        <div class="v2-day-art">${rewardArt(d, 4.4)}<b>${esc(loginRewardSummary(d))}</b></div>
        ${statePill(states[i]!)}
      </div>`).join('');
    const d7 = days[6]!;
    const s7 = states[6]!;
    const until = states.findIndex((s) => s === 'claim' || s === 'locked');
    const daysLeft = s7 === 'locked' && until >= 0 ? (states[until] === 'claim' ? 6 - until : 7 - until) : 0;
    return `${topBar('Weekly')}
<div class="v2-wk-sub"><span class="v2-mut">${esc(note)}</span><span class="v2-pill">${ico('flame', 1.1)} Streak ${streak} day${streak === 1 ? '' : 's'}</span><span class="v2-pill">${ico('shield', 1.2)} Shield ×${shields}</span></div>
<div class="v2-body v2-scroll v2-wk">
  <div class="v2-wk-grid">${left}</div>
  <div class="v2-panel v2-grand${s7 === 'claim' ? ' today' : ''}">
    <b class="v2-h" style="font-size:1.8em">${esc(d7.title)}</b><span class="v2-pill gold v2-upper">Grand prize</span>
    <div class="v2-grand-art">${ico('chest', 10)}</div>
    <b style="font-size:1.4em">${esc(loginRewardSummary(d7).split(' + ')[0] ?? '')}</b>
    ${d7.secondary ? `<b style="font-size:1.1em;color:var(--v2-xp-ink)">+ ${esc(loginRewardSummary(d7).split(' + ').slice(1).join(' + '))}</b>` : ''}
    ${s7 === 'claim' ? btn('Claim', 'claim', { h: 'green', c: 'w', dis: this.busy }) : s7 === 'claimed' ? `<span class="v2-pill ok">${ico('check', 1)} Claimed</span>` : `<span class="v2-pill">${ico('lock', 1)} ${daysLeft > 0 ? `Unlocks in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : 'Locked'}</span>`}
  </div>
</div>`;
  },
  actions: {
    claim: async () => {
      const r = retention();
      if (!r || weekly.busy) return;
      weekly.busy = true;
      ui().render();
      try {
        const res = await r.engagement.claimLogin();
        if (res?.canClaim) {
          const d = LoginRewardCatalog.Days[(res.day ?? 1) - 1];
          sfx(PokerSound.ChipsToWinner);
          ui().toast(`Reward claimed · ${d ? loginRewardSummary(d) : 'your reward'} added`, 2600);
        } else if (res?.error) ui().message('Weekly rewards', esc(res.error));
      } catch (e) {
        ui().message('Weekly rewards', esc(e instanceof Error ? e.message : String(e)));
      } finally {
        weekly.busy = false;
      }
    },
  },
};

// ------------------------------------------------------------------ level & missions

interface MissionRow {
  def: { id: string; title: string; kind: number };
  progress: number;
  target: number;
  done: boolean;
  claimed: boolean;
  canClaim: boolean;
  reward: string;
}

function resetIn(weeklyTab: boolean): string {
  const now = Date.now();
  const today = Math.floor(now / DAY_MS);
  const end = weeklyTab ? (MissionProgressMath.weekFromDay(today) + 1) * 7 * DAY_MS : (today + 1) * DAY_MS;
  let s = Math.max(0, Math.floor((end - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  // Minute precision: the screen's markup changes once a minute, so hover / pressed states stay stable.
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}

/** "650 Coins + 5 Gems + Gold frame": the frame shows by name, not its cosmetic id. */
function milestoneText(grants: ReturnType<typeof LevelRewardCatalog.rewardsForLevel>): string {
  const cos = grants.filter((g) => g.kind === RewardKind.Cosmetic);
  const rest = nomadGrants(grants.filter((g) => g.kind !== RewardKind.Cosmetic));
  return cos.length ? `${rest} + Gold frame` : rest;
}

/** The next milestone after the next level: every 10th level brings a frame (LevelRewardCatalog). */
function milestoneCard(lv: number): string {
  const n = (Math.floor((lv + 1) / 10) + 1) * 10;
  const grants = LevelRewardCatalog.rewardsForLevel(n);
  if (!grants.length) return '';
  return `<div class="v2-card v2-row v2-lv-mile">${avatar('', undefined, 'width:3.2em;height:3.2em;box-shadow:0 0 0 .25em var(--v2-gold)')}<div class="v2-grow"><span class="v2-cap">Milestone · Level ${n}</span><div style="font-weight:800">${esc(milestoneText(grants))}</div></div></div>`;
}

/** Icon per mission kind. */
const MISSION_ICONS: Record<number, string> = {
  [MissionKind.PlayHands]: 'mission-shuffle',
  [MissionKind.WeeklyHands]: 'mission-shuffle',
  [MissionKind.WinHands]: 'mission-hothand',
  [MissionKind.PlayTables]: 'mission-tables',
  [MissionKind.WinPairOrBetter]: 'mission-pair',
  [MissionKind.WinTwoPairOrBetter]: 'mission-pair',
  [MissionKind.PlayWithFriend]: 'friends',
};

const level: ScreenDef & { tab: string; busy: boolean } = {
  id: 'level',
  replaces: ['LevelRewards'],
  tab: 'daily',
  busy: false,
  open() {
    this.tab = 'daily';
  },
  render() {
    const r = retention();
    const m = r?.levelRewardsModel?.() ?? { level: 1, xpText: '', progress01: 0, toNextText: '', nextLevelText: 'Level 2', nextRewardText: '', hint: 'Play hands and finish missions to earn XP.', track: [] };
    const rows: MissionRow[] = r?.missionRows?.(this.tab) ?? [];
    const claimable = rows.filter((x) => x.canClaim).length;
    const track = [...m.track].reverse().map((t: { level: number; label: string; reward: string; reached: boolean }) => {
      const cls = t.level < m.level ? 'done' : t.level === m.level ? 'now' : '';
      return `<div class="v2-vnode ${cls}"><span class="v2-vdot">${t.level < m.level ? ico('check', 1.6) : t.level}</span><div class="v2-grow"><b>${esc(t.label)}</b><small class="v2-ellip">${esc(t.reward || 'Start')}</small></div></div>`;
    }).join('');
    const nowIdx = m.track.findIndex((t: { level: number }) => t.level === m.level);
    const trackDone = m.track.length > 1 && nowIdx >= 0 ? Math.round((nowIdx / (m.track.length - 1)) * 100) : 0;
    const mission = (x: MissionRow) => `
      <div class="v2-card v2-row v2-mis">${ico(MISSION_ICONS[x.def.kind] ?? 'clip', 2.4)}
        <div class="v2-grow"><b class="v2-mis-t">${esc(x.def.title)}</b>
          <div class="v2-row v2-sm"><div class="v2-bar"><i style="width:${x.target > 0 ? Math.min(100, (x.progress / x.target) * 100) : 0}%"></i></div><b class="v2-num">${fmt(x.progress)}/${fmt(x.target)}</b></div>
          <div class="v2-xs v2-goldc">${esc(x.reward)}</div></div>
        ${x.claimed ? '<span class="v2-pill ok">Claimed</span>' : x.canClaim ? btn('Claim', 'claim', { h: 'green', c: 'sm', v: x.def.id, dis: this.busy }) : '<span class="v2-pill">In progress</span>'}
      </div>`;
    return `${topBar('Missions')}
<div class="v2-body v2-lv">
  <div class="v2-panel v2-lv-hero">
    <div class="v2-lv-badge">${ico('level', 8.5)}<b>${m.level}</b></div>
    <b class="v2-h" style="font-size:1.8em">Level ${m.level}</b>
    <div class="v2-bar" style="height:.8em;width:100%;flex:none"><i style="width:${Math.round(m.progress01 * 100)}%"></i></div>
    <b class="v2-num">${esc(m.xpText)}</b><span class="v2-sm v2-mut">${esc(m.toNextText)}</span>
    <div class="v2-card v2-col" style="width:100%;align-items:center;gap:.3em"><span class="v2-cap">Next reward · ${esc(m.nextLevelText)}</span>${coinStack(3, 2.8)}<b style="font-size:1.2em;text-align:center">${esc(m.nextRewardText)}</b></div>
    ${milestoneCard(m.level)}
    <span class="v2-grow"></span><span class="v2-xs v2-mut">${esc(m.hint)}</span>
  </div>
  <div class="v2-panel v2-lv-track"><b class="v2-h" style="text-align:center">Level track</b><div class="v2-vtrack" style="--done:${trackDone}%">${track}</div></div>
  <div class="v2-panel v2-col v2-lv-miss">
    <div class="v2-row v2-wrap"><b class="v2-h v2-grow">Missions</b><div class="v2-lv-tabs">${tabs([['daily', 'Daily'], ['weekly', 'Weekly']], this.tab, 'tab')}</div></div>
    <div class="v2-row"><span class="v2-sm v2-mut v2-grow">Resets in <span class="v2-num">${resetIn(this.tab === 'weekly')}</span></span>${btn('Claim all', 'claim-all', { h: 'green', c: 'sm', dis: !claimable || this.busy })}</div>
    <div class="v2-col v2-scroll v2-lv-list">${rows.length ? rows.map(mission).join('') : '<div class="v2-empty">No missions right now.</div>'}</div>
  </div>
</div>`;
  },
  actions: {
    tab: (v) => {
      level.tab = v;
    },
    claim: async (id) => {
      const r = retention();
      if (!r || level.busy) return;
      level.busy = true;
      try {
        const res = await r.progression.claimMission(id);
        if (!res.ok) ui().message('Missions', esc(res.message || 'Not yet.'));
        else {
          sfx(PokerSound.ChipsToWinner);
          ui().toast(res.message || 'Mission complete: reward added.');
        }
      } finally {
        level.busy = false;
      }
    },
    'claim-all': async () => {
      const r = retention();
      if (!r || level.busy) return;
      level.busy = true;
      let n = 0;
      let err = '';
      try {
        for (const row of (r.missionRows(level.tab) as MissionRow[]).filter((x) => x.canClaim)) {
          const res = await r.progression.claimMission(row.def.id);
          if (res.ok) n++;
          else err = res.message || err;
        }
      } finally {
        level.busy = false;
      }
      if (err && !n) ui().message('Missions', esc(err));
      else ui().toast(n ? `${n} mission reward${n === 1 ? '' : 's'} claimed` : 'Nothing to claim yet');
    },
  },
};

export function rewardScreens(): ScreenDef[] {
  return [weekly, level];
}
