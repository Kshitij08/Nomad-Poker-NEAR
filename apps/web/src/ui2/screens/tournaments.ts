/**
 * Tournaments (atlas: Redesign v2 › Tournaments): Browse, My Tournaments, Host, Join by Code, with the Register and
 * Share dialogs. Same data and rules as the Unity screens (tournaments/menu/nomadTournaments.ts): register / join,
 * leave / cancel, host form options, join by code. Coins tournaments only; SOL tournaments are solTourneys.ts.
 */
import { NomadHost } from '../../menu/host';
import { isDemo, isMine as isMineOf, isOpen, isRegistered, type MineResult, type TournamentInfo } from '../../tournaments/api/tournamentInfo';
import { N0, blindsText, payout, speedShort, startLabel } from '../../tournaments/format';
import { HOST_FEES, HOST_MAX, HOST_PRIZES, HOST_SPEEDS, HOST_STARTS } from '../../tournaments/menu/nomadTournaments';
import { BlindSchedule } from '@nomad/engine/tournament/blindSchedule';
import { btn, chips, esc, input, tabs, act, seg } from '../core';
import { ico } from '../icons';
import { ui, host, S, onchain, topBar, setMode, signedIn, coins, copy, openUrl, run } from '../ctx';
import type { ScreenDef } from '../install';
import './tournaments.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = (): any => S('tournaments');

type Filter = 'all' | 'turbo' | 'regular' | 'slow';
type Sort = 'entry' | 'prize' | 'soon';
type MineTab = 'joined' | 'hosting' | 'past';

const T = {
  list: null as TournamentInfo[] | null,
  listErr: '',
  listBusy: false,
  mine: null as MineResult | null,
  mineErr: '',
  mineBusy: false,
  filter: 'all' as Filter,
  sort: 'entry' as Sort,
  sortOpen: false,
  expanded: '' as string,
  mineTab: 'joined' as MineTab,
  // host form
  hStart: 1,
  hFee: 2,
  hMax: 1,
  hPrize: 0,
  hSpeed: 0,
  hPrivate: false,
  hName: '',
  // join by code
  code: '',
  found: null as TournamentInfo | null,
  codeBusy: false,
};

const SORTS: [Sort, string][] = [['entry', 'Lowest entry'], ['prize', 'Biggest prize'], ['soon', 'Starting soon']];

// ------------------------------------------------------------------ data

async function loadList(): Promise<void> {
  const s = svc();
  if (!s) return;
  T.listBusy = true;
  ui().render();
  const r = await s.list('upcoming');
  T.listBusy = false;
  T.listErr = r.error ?? '';
  if (!r.error) T.list = r.value?.tournaments ?? [];
  ui().render();
}

async function loadMine(): Promise<void> {
  const s = svc();
  if (!s) return;
  T.mineBusy = true;
  ui().render();
  const r = await s.mine();
  T.mineBusy = false;
  T.mineErr = r.error ?? '';
  if (!r.error) T.mine = r.value;
  ui().render();
}

const isMine = (x: TournamentInfo): boolean => isMineOf(x, svc()?.api?.currentPlayerId ?? '');
const past = (x: TournamentInfo): boolean => x.status === 'finished' || x.status === 'cancelled' || x.status === 'paid';
const until = (x: TournamentInfo): string => NomadHost.until(x.startsAtUnix).replace(/^Starts in /, '');
const coinsText = (n: number): string => (n === 0 ? 'Free' : N0(n));

function findAny(id: string): TournamentInfo | null {
  const all = [...(T.list ?? []), ...(T.mine?.entries ?? []), ...(T.mine?.hosted ?? []), ...(T.found ? [T.found] : [])];
  return all.find((x) => x.id === id) ?? null;
}

function mineList(): TournamentInfo[] {
  const m = T.mine;
  if (!m) return [];
  if (T.mineTab === 'hosting') return (m.hosted ?? []).filter((x) => !past(x));
  if (T.mineTab === 'joined') return (m.entries ?? []).filter((x) => !past(x));
  const list = (m.entries ?? []).filter(past);
  for (const x of m.hosted ?? []) if (past(x) && !list.some((y) => y.id === x.id)) list.push(x);
  return list;
}

function browseList(): TournamentInfo[] {
  let l = [...(T.list ?? [])];
  if (T.filter !== 'all') l = l.filter((x) => x.speed === T.filter);
  if (T.sort === 'entry') l.sort((a, b) => a.entryFee - b.entryFee || a.startsAtUnix - b.startsAtUnix);
  else if (T.sort === 'prize') l.sort((a, b) => b.prizePool - a.prizePool);
  else l.sort((a, b) => a.startsAtUnix - b.startsAtUnix);
  return l;
}

// ------------------------------------------------------------------ flows (as NomadTournaments)

function registerOrJoin(x: TournamentInfo | null): void {
  if (!x) return;
  if (!signedIn()) return host().show('Login');
  if (isRegistered(x)) {
    if (!x.serverReady) return ui().message(esc(x.name), `You're registered. ${esc(NomadHost.until(x.startsAtUnix))}; come back then.`);
    void run(() => svc().join(x));
    return;
  }
  if (!isOpen(x)) return ui().message(esc(x.name), 'Registration is closed.');
  const fee = x.entryFee === 0 ? "It's free to enter." : `Entry fee: ${N0(x.entryFee)} Coins.`;
  ui().message(esc(x.name), `${fee} Register?`, 'Register', () =>
    void run(async () => (await svc().register(x.id)).error, () => {
      void loadList();
      void loadMine();
      ui().toast(`Registered for ${x.name} · ${NomadHost.until(x.startsAtUnix)}`, 2600);
    }), 'Cancel', undefined);
}

function leaveOrCancel(x: TournamentInfo | null): void {
  if (!x) return;
  if (!isMine(x) && x.serverReady) return registerOrJoin(x);
  if (isMine(x))
    ui().message(esc(x.name), 'Cancel this tournament? Everyone who registered gets their entry fee back.', 'Cancel it',
      () => void run(async () => (await svc().cancel(x.id)).error, () => void loadMine()), 'Keep it', undefined, 'red');
  else
    ui().message(esc(x.name), 'Leave this tournament? Your entry fee comes back.', 'Leave',
      () => void run(async () => (await svc().unregister(x.id)).error, () => void loadMine()), 'Stay', undefined, 'red');
}

function shareLink(x: TournamentInfo): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'https://nomad-poker-web.vercel.app';
  return x.visibility === 'private' && x.joinCode ? `${origin}/?trn=${encodeURIComponent(x.joinCode)}` : origin;
}

function openShare(x: TournamentInfo): void {
  const link = shareLink(x);
  const text = `Join me in ${x.name} on Nomad Poker${x.visibility === 'private' && x.joinCode ? ` (code ${x.joinCode})` : ''}`;
  const enc = encodeURIComponent;
  const targets: [string, string][] = [
    ['X', `https://x.com/intent/post?text=${enc(text)}&url=${enc(link)}`],
    ['Discord', 'https://discord.com/app'],
    ['Telegram', `https://t.me/share/url?url=${enc(link)}&text=${enc(text)}`],
    ['WhatsApp', `https://wa.me/?text=${enc(`${text} ${link}`)}`],
  ];
  ui().openDialog({
    title: `Share ${esc(x.name)}`,
    wide: true,
    body: `<div class="v2-row"><div class="v2-field v2-grow v2-num v2-ellip">${esc(link)}</div>${btn('Copy', 'sh-copy', { h: 'blue' })}</div>
      ${x.visibility === 'private' && x.joinCode ? `<div class="v2-sm v2-mut" style="margin-top:.6em">Private tournament: the link carries the join code <b class="v2-goldc">${esc(x.joinCode)}</b>.</div>` : ''}
      <div class="v2-row v2-wrap" style="margin-top:1em;gap:.6em">${targets.map(([l], i) => btn(l, 'sh-to', { h: 'ghost', c: 'v2-grow', v: i })).join('')}</div>`,
    buttons: btn('Close', 'sh-close', { h: 'ghost' }),
    actions: {
      'sh-copy': () => copy(`${text}: ${link}`, 'Link copied'),
      'sh-to': (v) => {
        const [label, url] = targets[Number(v)]!;
        // Discord has no share URL: copy the message, then open Discord to paste it.
        if (label === 'Discord') copy(`${text}: ${link}`, 'Copied: paste it in Discord');
        openUrl(url);
      },
      'sh-close': () => ui().closeDialog(),
    },
  });
}

function createTournament(confirmed = false): void {
  if (!signedIn()) return host().show('Login');
  const name = T.hName.trim();
  if (name.length === 0) return ui().message('Host a tournament', 'Give your tournament a name.');
  if (name.length > 40) return ui().message('Host a tournament', 'Keep the name to 40 characters.');
  const prize = HOST_PRIZES[T.hPrize]!;
  if (prize > coins()) return ui().message('Not enough Coins', `Your prize of ${N0(prize)} Coins is more than you have.`);
  if (prize > 0 && !confirmed)
    return ui().message('Host a tournament', `Creating ${esc(name)} takes your ${N0(prize)} Coins prize from your balance now. It goes to the winners.`, 'Create', () => createTournament(true), 'Cancel');
  const startMinutes = HOST_STARTS[T.hStart]!;
  const req = {
    name, hostPrize: prize, entryFee: HOST_FEES[T.hFee]!, maxPlayers: HOST_MAX[T.hMax]!, speed: HOST_SPEEDS[T.hSpeed]!,
    visibility: T.hPrivate ? 'private' : 'public', startsAtUnix: (svc()?.api?.serverNowUnix ?? Math.floor(Date.now() / 1000)) + startMinutes * 60,
  };
  let made: TournamentInfo | null = null;
  void run(async () => {
    const r = await svc().create(req);
    made = r.value;
    return r.error;
  }, () => {
    const m = made as TournamentInfo | null;
    const isPrivate = !!m && m.visibility === 'private' && !!m.joinCode;
    if (isPrivate) void navigator.clipboard?.writeText(m!.joinCode).catch(() => {});
    const code = isPrivate ? ` Its code is <b class="v2-goldc">${esc(m!.joinCode)}</b> (copied); share it with your players.` : '';
    T.hName = '';
    T.mineTab = 'hosting';
    ui().show('t-mine', undefined, false);
    ui().message('Tournament created', `${esc(name)} ${esc(startLabel(startMinutes).toLowerCase())}.${code}`);
  });
}

function findByCode(): void {
  const code = T.code.replace(/\s+/g, '').toUpperCase();
  if (code.length === 0) return ui().message('Join by code', 'Enter the code the host shared.');
  T.codeBusy = true;
  T.found = null;
  void run(async () => {
    const r = await svc().byCode(code);
    T.codeBusy = false;
    if (r.error !== null) return r.code === 'not_found' || !r.error ? 'No tournament has that code.' : r.error;
    T.found = r.value;
    T.expanded = r.value?.id ?? '';
    return null;
  }, undefined, 'Join by code').finally(() => {
    T.codeBusy = false;
    ui().render();
  });
}

// ------------------------------------------------------------------ markup

const SPEED_CLS: Record<string, string> = { turbo: 'blue', regular: 'violet', slow: 'teal' };
const FORMAT: Record<string, string> = { single: 'One table', two_tables: 'Two tables · top 2 advance', four_tables: 'Four tables · top 2 advance' };

function money(n: number): string {
  return n === 0 ? '<b class="v2-good">Free</b>' : `<b>${ico('coin', 1.2)} ${N0(n)}</b>`;
}
/** Prize amounts: 0 is "—", not "Free" (that word is for entry fees). */
function prizeMoney(n: number): string {
  return n === 0 ? '<b class="v2-mut">—</b>' : `<b>${ico('coin', 1.2)} ${N0(n)}</b>`;
}
/** The first blind levels (the same schedule every speed; the speed sets the level length). */
const BLIND_STEPS = [1, 2, 3].map((l) => {
  const b = BlindSchedule.forLevel(l);
  return `${N0(b.smallBlind)}/${N0(b.bigBlind)}`;
}).join(' → ');
const REASONS: Record<string, string> = { not_enough_players: 'not enough players', host_cancelled: 'the host cancelled', cancelled_by_host: 'the host cancelled' };
const reasonText = (r: string): string => REASONS[r] ?? r.replace(/_/g, ' ');

function tRow(x: TournamentInfo, o: { action?: string; pill?: string } = {}): string {
  const exp = T.expanded === x.id;
  const fill = x.maxPlayers > 0 ? Math.round((x.players / x.maxPlayers) * 100) : 0;
  const action = o.action ?? (() => {
    if (isRegistered(x)) return x.serverReady ? btn('Join table', 't-reg', { h: 'gold', v: x.id }) : btn('Registered', 't-reg', { h: 'ghost', v: x.id });
    return isOpen(x) ? btn('Register', 't-reg', { h: 'gold', v: x.id }) : btn('Closed', 't-reg', { h: 'ghost', dis: true, v: x.id });
  })();
  const d = new Date(x.startsAtUnix * 1000);
  const date = `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return `<div class="v2-trow${exp ? ' exp' : ''}">
  <div class="v2-tr1"><b class="v2-tn v2-ellip">${esc(x.name)}</b><span class="v2-rtag ${SPEED_CLS[x.speed] ?? 'violet'}">${speedShort(x.speed)}</span>${x.entryFee === 0 ? '<span class="v2-rtag">Freeroll</span>' : ''}${x.visibility === 'private' ? '<span class="v2-rtag">Private</span>' : ''}${o.pill ?? ''}
    <span class="v2-grow"></span><span class="v2-tdate">${ico('cal2', 1.3)} ${esc(date)}</span>
    <button class="v2-ticon"${act('t-share', x.id)} aria-label="Share ${esc(x.name)}">${ico('share', 1.25)}</button>
    <button class="v2-ticon"${act('t-exp', x.id)} aria-label="${exp ? 'Hide' : 'Show'} details" aria-expanded="${exp}">${ico(exp ? 'chevup' : 'chev', 1.3)}</button></div>
  <div class="v2-tr2">
    <div class="v2-tc"><small>ENTRY FEE</small>${money(x.entryFee)}</div>
    <div class="v2-tc"><small>PRIZE POOL</small>${prizeMoney(x.prizePool)}</div>
    <div class="v2-tc"><small>PLAYERS</small><b>${x.players} / ${x.maxPlayers}</b><div class="v2-bar v2-tbar"><i style="width:${fill}%"></i></div></div>
    ${past(x) ? `<div class="v2-tc"><small>STATUS</small><b>${x.status === 'cancelled' ? 'Cancelled' : 'Finished'}</b></div>` : `<div class="v2-tc"><small>STARTS IN</small><b>${esc(x.status === 'running' || x.status === 'locked' ? 'Playing now' : until(x))}</b></div>`}
    <div class="v2-tc"><small>BLINDS</small><b>${blindsText(x.speed)}</b></div>
    <div class="v2-tact">${action}</div>
  </div>
  ${exp ? `<div class="v2-tr3">
    <div class="v2-tc"><small>PRIZE DISTRIBUTION</small><b>${esc(payout(x))}</b></div>
    <div class="v2-tc"><small>STARTING CHIPS</small><b>5,000 every round</b></div>
    <div class="v2-tc"><small>BLIND LEVELS</small><b>${BLIND_STEPS} → …</b></div>
    <div class="v2-tc"><small>FORMAT</small><b>${esc(FORMAT[x.format] ?? `${x.maxPlayers > 8 ? '8-seat tables · top 2 advance' : 'One table'}`)}</b></div>
    <div class="v2-tc"><small>HOST</small><b>${esc(x.hostName || 'Nomad')}</b></div>
  </div>` : ''}
</div>`;
}

function head(on: string): string {
  const chain = onchain();
  return topBar('Tournaments') + tabs([['t-browse', 'Browse', 'tourn-browse'], ['t-mine', 'My tournaments', 'trophy'], ['t-host', 'Host', 'tourn-host'], ['t-code', 'Join by code', 'tourn-code']], on, 'tab', 'v2-ttabs') +
    // Offline the list is the practice backend's example data (some already "registered" or "hosted"): say so.
    (!chain && T.list?.length && T.list.every(isDemo) ? `<div class="v2-card v2-row v2-tnote">${ico('trophy', 1.8)}<span class="v2-grow">Practice tournaments: example events to try the flow while the tournament server is offline.</span></div>` : '') +
    (chain ? `<div class="v2-card v2-row v2-tnote">${ico('sol', 1.8)}<span class="v2-grow">These are Coins tournaments. SOL tournaments, paid from your game balance, have their own list.</span>${btn('SOL tournaments', 't-sol', { h: 'violet', c: 'sm' })}</div>` : '');
}

const empty = (icon: string, text: string): string => `<div class="v2-empty">${ico(icon, 6)}<span>${text}</span></div>`;
const loading = (): string => `<div class="v2-empty"><span>Loading tournaments…</span></div>`;
const errorBox = (err: string, a: string): string => `<div class="v2-empty"><span>${esc(err)}</span>${btn('Try again', a, { h: 'blue' })}</div>`;

const common: Record<string, (v: string) => void | Promise<void>> = {
  mode: (v) => setMode(v),
  't-reg': (v) => registerOrJoin(findAny(v)),
  't-share': (v) => {
    const x = findAny(v);
    if (x) openShare(x);
  },
  't-exp': (v) => {
    T.expanded = T.expanded === v ? '' : v;
  },
  't-sol': () => ui().show('sol-tourneys'),
};

// ------------------------------------------------------------------ screens

const browse: ScreenDef = {
  id: 't-browse',
  replaces: ['Tournaments_Browse'],
  open() {
    T.sortOpen = false;
    void loadList();
  },
  backFirst() {
    if (!T.sortOpen) return false;
    T.sortOpen = false;
    return true;
  },
  render() {
    const l = browseList();
    const body = !svc() ? empty('trophy', "Tournaments aren't available right now. Try again later.")
      : T.listErr && !T.list ? errorBox(T.listErr, 't-reload')
        : !T.list ? loading()
          : l.length === 0 ? empty('trophy', T.filter === 'all' ? 'No tournaments are open right now.<br>Host one, or join a private one by code.' : `No ${speedShort(T.filter)} tournaments right now.`)
            : l.map((x) => tRow(x)).join('');
    const sortLabel = SORTS.find(([k]) => k === T.sort)![1];
    return `${head('t-browse')}
<div class="v2-panel v2-tpanel">
  <div class="v2-row v2-wrap v2-thead"><b class="v2-h v2-grow">Browse tournaments</b>
    <div class="v2-row v2-tchips">${chips([['all', 'All'], ['turbo', 'Turbo'], ['regular', 'Regular'], ['slow', 'Slow']], T.filter, 't-filter')}</div>
    <div class="v2-tsortw"><button class="v2-chip v2-tsort"${act('t-sort')} aria-haspopup="listbox" aria-expanded="${T.sortOpen}">${sortLabel} ${ico('chev', 1)}</button>
    ${T.sortOpen ? `<div class="v2-tsortm" role="listbox">${SORTS.map(([k, lb]) => `<button class="v2-chip${k === T.sort ? ' on' : ''}" role="option"${act('t-sortby', k)}>${lb}</button>`).join('')}</div>` : ''}</div>
  </div>
  <div class="v2-tlist v2-scroll">${body}</div>
</div>`;
  },
  actions: {
    ...common,
    't-reload': () => void loadList(),
    't-filter': (v) => {
      T.filter = v as Filter;
    },
    't-sort': () => {
      T.sortOpen = !T.sortOpen;
    },
    't-sortby': (v) => {
      T.sort = v as Sort;
      T.sortOpen = false;
    },
  },
};

const mine: ScreenDef = {
  id: 't-mine',
  replaces: ['Tournaments_MyTournaments'],
  open() {
    void loadMine();
  },
  render() {
    const l = mineList();
    const rowFor = (x: TournamentInfo): string => {
      const mineX = isMine(x);
      let action: string;
      let pill: string;
      if (T.mineTab === 'past') {
        action = btn('Results', 't-results', { h: 'ghost', v: x.id });
        pill = x.status === 'cancelled' ? '<span class="v2-pill">Cancelled</span>' : x.myPlace > 0 ? `<span class="v2-pill gold">Finished #${x.myPlace}${x.myPrize > 0 ? ` · won ${N0(x.myPrize)}` : ''}</span>` : '<span class="v2-pill">Finished</span>';
      } else if (mineX) {
        action = btn('Cancel', 't-leave', { h: 'red', v: x.id });
        pill = `<span class="v2-pill gold">Hosting${x.visibility === 'private' && x.joinCode ? ` · code ${esc(x.joinCode)}` : ''}</span>`;
      } else if (x.serverReady) {
        action = btn('Join table', 't-reg', { h: 'gold', v: x.id });
        pill = '<span class="v2-pill ok">Table ready</span>';
      } else {
        action = btn('Leave', 't-leave', { h: 'red', v: x.id });
        pill = `<span class="v2-pill">${x.status === 'running' ? 'Playing now' : 'Registered'}</span>`;
      }
      return tRow(x, { action, pill });
    };
    const body = !svc() ? empty('trophy', "Tournaments aren't available right now. Try again later.")
      : T.mineErr && !T.mine ? errorBox(T.mineErr, 't-reload')
        : !T.mine ? loading()
          : l.length === 0 ? empty('trophy', T.mineTab === 'hosting' ? "You aren't hosting a tournament.<br>Host one from the Host tab." : T.mineTab === 'past' ? 'No past tournaments yet.' : 'Nothing here yet.<br>Tournaments you join show up here.')
            : l.map(rowFor).join('');
    return `${head('t-mine')}
<div class="v2-panel v2-tpanel">
  <div class="v2-row v2-wrap v2-thead"><b class="v2-h v2-grow">My tournaments</b>${seg([['joined', 'Joined'], ['hosting', 'Hosting'], ['past', 'Past']], T.mineTab, 't-mtab')}</div>
  <div class="v2-tlist v2-scroll">${body}</div>
</div>`;
  },
  actions: {
    ...common,
    't-reload': () => void loadMine(),
    't-mtab': (v) => {
      T.mineTab = v as MineTab;
    },
    't-leave': (v) => leaveOrCancel(findAny(v)),
    't-results': (v) => {
      const x = findAny(v);
      if (!x) return;
      const body = x.status === 'cancelled' ? `Cancelled${x.cancelReason ? `: ${esc(reasonText(x.cancelReason))}` : ''}.`
        : `${esc(payout(x))}.${x.myPlace > 0 ? `<br>You finished #${x.myPlace}${x.myPrize > 0 ? ` and won <b>${N0(x.myPrize)}</b> Coins` : ''}.` : ''}`;
      ui().message(esc(x.name), body);
    },
  },
};

function optRow(label: string, items: string[], on: number, a: string): string {
  return `<div class="v2-hrow"><span class="v2-hl">${label}</span><div class="v2-row v2-wrap v2-hopts">${items.map((x, i) => `<button class="v2-chip${i === on ? ' on' : ''}"${act(a, i)}>${x}</button>`).join('')}</div></div>`;
}

/** Speeds shown Turbo / Regular / Slow (indices into HOST_SPEEDS). */
const SPEED_ORDER = (['turbo', 'regular', 'slow'] as string[]).map((sp) => (HOST_SPEEDS as readonly string[]).indexOf(sp)).filter((i) => i >= 0);
function optRowIdx(label: string, items: [number, string][], on: number, a: string): string {
  return `<div class="v2-hrow"><span class="v2-hl">${label}</span><div class="v2-row v2-wrap v2-hopts">${items.map(([i, x]) => `<button class="v2-chip${i === on ? ' on' : ''}"${act(a, i)}>${x}</button>`).join('')}</div></div>`;
}

const hostScreen: ScreenDef = {
  id: 't-host',
  replaces: ['Tournaments_Host'],
  render() {
    const fee = HOST_FEES[T.hFee]!;
    const prize = HOST_PRIZES[T.hPrize]!;
    const max = HOST_MAX[T.hMax]!;
    const speed = HOST_SPEEDS[T.hSpeed]!;
    const name = T.hName.trim();
    return `${head('t-host')}
<div class="v2-thost v2-scroll">
  <div class="v2-panel v2-col v2-hform v2-scroll"><b class="v2-h">Host a tournament</b>
    <div class="v2-hrow"><span class="v2-hl">Name</span>${input('tname', T.hName, 'Name your tournament', { cls: 'v2-grow', max: 40 })}</div>
    ${optRow('Starts', HOST_STARTS.map((m) => startLabel(m).replace('Tomorrow, same time', 'Tomorrow')), T.hStart, 'h-start')}
    ${optRow('Entry fee', HOST_FEES.map((f) => coinsText(f)), T.hFee, 'h-fee')}
    ${optRow('Max players', HOST_MAX.map(String), T.hMax, 'h-max')}
    ${optRow('Your prize', HOST_PRIZES.map((p) => (p === 0 ? 'None' : `+${N0(p)}`)), T.hPrize, 'h-prize')}
    ${optRowIdx('Speed', SPEED_ORDER.map((i) => [i, `${speedShort(HOST_SPEEDS[i]!)} · ${blindsText(HOST_SPEEDS[i]!).replace(' levels', '')}`] as [number, string]), T.hSpeed, 'h-speed')}
    ${optRow('Visibility', ['Public', 'Private (code)'], T.hPrivate ? 1 : 0, 'h-vis')}
  </div>
  <div class="v2-panel v2-col v2-hsum"><b class="v2-h">Summary</b>
    <div class="v2-kv"><span>Name</span><b class="v2-ellip" data-tname-out>${esc(name || 'Your tournament')}</b></div>
    <div class="v2-kv"><span>Starts</span><b>${esc(startLabel(HOST_STARTS[T.hStart]!))}</b></div>
    <div class="v2-kv"><span>Entry</span><b>${fee === 0 ? 'Free' : `${N0(fee)} Coins`}</b></div>
    <div class="v2-kv"><span>Players</span><b>up to ${max}</b></div>
    <div class="v2-kv"><span>Prize if full</span><b>${N0(prize + fee * max)} Coins</b></div>
    <div class="v2-kv"><span>Payout</span><b>1st 60% · 2nd 40%</b></div>
    <div class="v2-kv"><span>Speed</span><b>${speedShort(speed)} · ${blindsText(speed)}</b></div>
    <div class="v2-kv"><span>Visibility</span><b>${T.hPrivate ? 'Private (code)' : 'Public'}</b></div>
    <div class="v2-grow"></div>
    ${prize > 0 ? `<div class="v2-xs v2-mut">Your ${N0(prize)} Coins prize is taken from your balance.</div>` : ''}
    <div class="v2-hcta-d">${btn('Create Tournament', 'h-create', { h: 'gold', c: 'lg w' })}</div>
  </div>
  <div class="v2-hcta-p">${btn('Create Tournament', 'h-create', { h: 'gold', c: 'lg w' })}</div>
</div>`;
  },
  actions: {
    ...common,
    'h-start': (v) => void (T.hStart = Number(v)),
    'h-fee': (v) => void (T.hFee = Number(v)),
    'h-max': (v) => void (T.hMax = Number(v)),
    'h-prize': (v) => void (T.hPrize = Number(v)),
    'h-speed': (v) => void (T.hSpeed = Number(v)),
    'h-vis': (v) => void (T.hPrivate = v === '1'),
    'h-create': () => {
      T.hName = hostScreen.input?.tname ?? T.hName;
      createTournament();
    },
  },
};

const CODE_LEN = 6;
const codeScreen: ScreenDef = {
  id: 't-code',
  replaces: ['Tournaments_JoinByCode'],
  open(arg) {
    T.found = null;
    // A shared tournament link opens here with its code filled in and looked up (never registers by itself).
    if (typeof arg === 'string' && arg) {
      T.code = arg.replace(/s+/g, '').toUpperCase().slice(0, CODE_LEN);
      findByCode();
    }
  },
  render() {
    const chars = T.code.toUpperCase().padEnd(CODE_LEN, ' ').slice(0, CODE_LEN).split('');
    const x = T.found;
    return `${head('t-code')}
<div class="v2-panel v2-col v2-tcode">
  <b class="v2-h" style="font-size:1.6em">Join a private tournament</b>
  <span class="v2-mut">Enter the invite code shared by the tournament host.</span>
  <div class="v2-row v2-codew">
    <label class="v2-codebox" aria-label="Tournament code">
      ${chars.map((c, i) => `<span class="v2-codec${i === Math.min(T.code.length, CODE_LEN - 1) ? ' cur' : ''}" data-codec="${i}">${esc(c.trim())}</span>`).join('')}
      ${input('tcode', T.code, '', { cls: 'v2-codein', max: CODE_LEN })}
    </label>
    <button class="v2-b blue"${act('c-find')} data-enter="tcode"${T.codeBusy ? ' disabled' : ''}>${T.codeBusy ? 'Finding…' : 'Find'}</button>
  </div>
  ${x ? `<div class="v2-tfound">${tRow(x)}</div>` : ''}
</div>`;
  },
  actions: {
    ...common,
    'c-find': () => {
      T.code = (codeScreen.input?.tcode ?? T.code).toUpperCase();
      findByCode();
    },
  },
};

// Live updates while typing (the screen does not re-render while an input has focus).
let listening = false;
function listenInputs(): void {
  if (listening) return;
  listening = true;
  // The sort menu closes on a click anywhere outside it.
  ui().el.addEventListener('pointerdown', (e) => {
    if (!T.sortOpen) return;
    if ((e.target as HTMLElement).closest('.v2-tsortw')) return;
    T.sortOpen = false;
    ui().render();
  });
  ui().el.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset?.in === 'tcode') {
      const v = el.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, CODE_LEN);
      if (el.value !== v) el.value = v;
      T.code = v;
      ui().el.querySelectorAll<HTMLElement>('[data-codec]').forEach((c) => {
        const i = Number(c.dataset.codec);
        c.textContent = v[i] ?? '';
        c.classList.toggle('cur', i === Math.min(v.length, CODE_LEN - 1));
      });
    } else if (el.dataset?.in === 'tname') {
      T.hName = el.value;
      const o = ui().el.querySelector<HTMLElement>('[data-tname-out]');
      if (o) o.textContent = el.value.trim() || 'Your tournament';
    }
  });
}

export function tournamentScreens(): ScreenDef[] {
  for (const s of [browse, mine, hostScreen, codeScreen]) {
    s.back = 'main';
    const open = s.open?.bind(s);
    s.open = (arg?: unknown) => {
      listenInputs();
      T.expanded = s === codeScreen ? T.expanded : '';
      open?.(arg);
    };
  }
  return [browse, mine, hostScreen, codeScreen];
}
