/** Play: Choose your table, Party, Watch; Play for NEAR (nearTables.ts). In On-chain, Tables and Party open Play for NEAR. Atlas: Redesign v2 › Play. */
import { StakeCatalog, formatN0, type StakeTier } from '@nomad/engine';
import { joinFreePlay } from '../../menu/play';
import { StakeTableSkin, type Theme } from '../../menu/stakes';
import { assetUrl } from '../../hud/unityUi';
import { startParty, startWatch } from '../../economy/party';
import { cloudGameServer } from '../../net/serverUrl';
import { btn, esc, act, input } from '../core';
import { ico } from '../icons';
import { ui, host, app, S, onchain, topBar, signedIn, needCoins, getCoinsRoute } from '../ctx';
import type { ScreenDef } from '../install';
import { hostedTables, forgetHostedTable, nearCloseHosted, nearCopyLink, nearHostTable, nearSitAt, rememberHostedTable, tableIdFrom } from '../nearPlay';
import { nearAccountId } from '../ctx';
import { chipsToYocto, yoctoToChips } from '../../near/escrow';
import { formatNear } from '../../near/backing';
import './play.css';

/** The five rooms (Unity TableSelect cards), cheapest first. */
export const ROOMS: { theme: Theme; name: string; color: string }[] = [
  { theme: 'Default', name: 'Nomad', color: '#9945ff' },
  { theme: 'Forest', name: 'Forest', color: '#2e8b57' },
  { theme: 'Town', name: 'Town', color: '#d08a3a' },
  { theme: 'Desert', name: 'Desert', color: '#d6a85c' },
  { theme: 'Neon_City', name: 'Neon City', color: '#ff4fa3' },
];

/**
 * The room art, sharper than the Unity menu export (1541×578 looked soft on the big room cards and upscaled 2-3×
 * on phones). These are the same scenes at 2048×768 (theming/) and 2880×1080 (Nomad, 3d/).
 */
const ROOM_ART: Record<Theme, string> = {
  Default: 'assets/3d/BG.webp',
  Forest: 'assets/theming/Forest/Forest_bg.webp',
  Town: 'assets/theming/Town/Town_bg.webp',
  Desert: 'assets/theming/Desert/Desert_bg.webp',
  Neon_City: 'assets/theming/Neon_City/Neon_City_bg.webp',
};

/** The room's table background art (the scene the table plays in), or null. */
export function roomArt(theme: Theme): string | null {
  const art = ROOM_ART[theme];
  return art ? assetUrl(art) : null;
}

export const bgArt = (theme: Theme, color: string): string => {
  const url = roomArt(theme);
  return `background:${url ? `linear-gradient(180deg,transparent 55%,color-mix(in srgb,var(--v2-shade) 55%,transparent)),url('${esc(url)}') center/cover no-repeat,` : ''}linear-gradient(160deg,${color},var(--v2-bg-top))`;
};

// ------------------------------------------------------------------ Choose your table


/** On-chain, the Coins table screens hand over to Play for NEAR. */
/** On-chain, the rooms on the main menu are the NEAR tables: the Coins table list hands over to them. */
const toRooms = (): void => queueMicrotask(() => ui().show('main'));

const tables: ScreenDef & { theme: Theme } = {
  id: 'tables',
  replaces: ['TableSelect_TownLobby'],
  theme: 'Town',
  open() {
    if (onchain()) return toRooms();
    this.theme = StakeTableSkin.themeFor(host().stakes.resolve().minBuyIn);
  },
  render() {
    const stakes = host().stakes;
    const level = levelOf(this.theme);
    const room = ROOMS[level]!;
    const tier = selectedTier(this.theme);
    const canSit = stakes.canSit(tier);
    const coinsNow = stakes.coins;
    const cards = ROOMS.map((r) => {
      const t = StakeTableSkin.stakesFor(r.theme)[0]!;
      const locked = !StakeTableSkin.canAfford(r.theme, coinsNow);
      const sub = `${t.displayName} · ${t.blindsLabel}`;
      return `<button class="v2-stc${r.theme === this.theme ? ' on' : ''}${locked ? ' locked' : ''}"${act('room', r.theme)} aria-pressed="${r.theme === this.theme}"><div class="v2-stc-art" style="${bgArt(r.theme, r.color)}">${locked ? `<span class="v2-stc-lock">${ico('lock', 1.6)}</span>` : ''}</div><b>${r.name}</b><small>${esc(sub)}</small></button>`;
    }).join('');
    const buyVal = formatN0(canSit ? stakes.selectedBuyInChips : tier.minBuyIn);
    return topBar('Tables') + `<div class="v2-body">
<div class="v2-ts">
  <div class="v2-ts-left">
    <div class="v2-ts-preview" style="${bgArt(room.theme, room.color)}"><div class="v2-ts-felt"></div><div class="v2-ts-cap"><b>${room.name} room</b><div class="v2-sm v2-mut">Your table plays in this room</div></div></div>
    <div class="v2-ts-cards">${cards}</div>
  </div>
  <div class="v2-panel v2-col v2-ts-sel">
    <span class="v2-cap">Selected table</span>
    <b class="v2-h v2-ts-name">${room.name}</b>
    <div class="v2-kv"><span>Stakes</span><b>${tier.displayName} stakes</b></div>
    <div class="v2-kv"><span>Blinds</span><b>${esc(tier.blindsLabel)}</b></div>
    <div class="v2-kv"><span>Minimum buy-in</span><b>${esc(formatN0(tier.minBuyIn))}</b></div>
    <span class="v2-sm v2-mut" style="margin-top:.4em">Your buy-in</span>
    <div class="v2-row">${btn(ico('minus', 1), 'buy-step', { h: 'ghost', v: -1, title: 'Less' })}<div class="v2-field v2-grow v2-num v2-ts-buy">${esc(buyVal)}</div>${btn(ico('plus', 1), 'buy-step', { h: 'ghost', v: 1, title: 'More' })}</div>
    <div class="v2-row">${btn('Min', 'buy-end', { v: 'min', c: 'v2-grow' })}${btn('2×', 'buy-end', { v: 'double', c: 'v2-grow' })}${btn('Max', 'buy-end', { v: 'max', c: 'v2-grow' })}</div>
    ${!canSit ? `<div class="v2-xs v2-badc">You need ${formatN0(tier.minBuyIn)} Coins to sit here.</div>` : ''}
    <div class="v2-grow"></div>
    ${btn(`Join Table ${ico('next', 0.8)}`, 'join', { h: 'gold', c: 'lg w' })}
  </div>
</div></div>`;
  },
  actions: {
    room: (v) => {
      tables.theme = v as Theme;
      StakeTableSkin.selectThemeTable(tables.theme, host().stakes, (t) => S('theme')?.setTheme?.(t));
    },
    'buy-step': (v) => {
      const dir = Number(v);
      const s = host().stakes;
      const tier = s.resolve();
      s.selectedBuyInChips = s.selectedBuyInChips + dir * Math.max(1, tier.bigBlind * 10);
    },
    'buy-end': (v) => {
      const end = v as 'min' | 'max' | 'double';
      const s = host().stakes;
      const t = s.resolve();
      s.selectedBuyInChips = end === 'min' ? s.minBuyInChips(t) : end === 'max' ? s.maxBuyInChips(t) : s.selectedBuyInChips * 2;
    },
    join: () => {
      const h = host();
      if (!signedIn()) return h.show('Login');
      const tier = selectedTier(tables.theme);
      if (!h.stakes.canSit(tier)) {
        ui().openDialog({
          title: 'Not enough Coins',
          body: `${esc(tier.displayName)} tables need ${formatN0(tier.minBuyIn)} Coins to sit. Pick a lower table. ${esc(getCoinsRoute().hint)}`,
          buttons: btn('Not now', 'nec-ok', { h: 'ghost' }) + btn(esc(getCoinsRoute().label), 'nec-get', { h: 'green' }),
          actions: { 'nec-get': () => { ui().closeDialog(); getCoinsRoute().go(); }, 'nec-ok': () => ui().closeDialog() },
        });
        return;
      }
      void joinFreePlay(h, tier, h.stakes.selectedBuyInChips, 'join');
    },
  },
};

export const levelOf = (theme: Theme): number => Math.max(0, ROOMS.findIndex((r) => r.theme === theme));

/** The chosen stake if it plays in this room, else the room's entry stake (NomadUiHost SelectedTableTier). */
export function selectedTier(theme: Theme): StakeTier {
  const stakes = host().stakes;
  const chosen = stakes.selectedMinBuyIn;
  const tier = chosen > 0 ? StakeCatalog.get(chosen) : stakes.resolve();
  return StakeTableSkin.themeFor(tier.minBuyIn) === theme ? tier : StakeTableSkin.stakesFor(theme)[0]!;
}

// ------------------------------------------------------------------ Party

const party: ScreenDef = {
  id: 'party',
  replaces: ['PartyMenu'],
  input: { code: '' },
  open() {
    this.input = { code: '' };
    if (onchain()) void hostedTables.load();
  },
  render() {
    if (onchain()) return nearParty(this.input?.code ?? '');
    return topBar('Play with friends') + `<div class="v2-body">
<div class="v2-party-sub v2-mut">Private tables with friends</div>
<div class="v2-party">
  <div class="v2-panel v2-col v2-party-card">${ico('cards', 7)}<b class="v2-h">Create a party</b><div class="v2-mut">Start a private table and share the code.</div><div class="v2-grow"></div>${btn('Create a table', 'create', { h: 'gold', c: 'w' })}</div>
  <div class="v2-panel v2-col v2-party-card">${ico('friends', 7)}<b class="v2-h">Join a party</b><div class="v2-mut">Join a friend's table with their code.</div>${input('code', this.input?.code ?? '', 'Enter session code', { max: 12, cls: 'v2-party-code' })}<div class="v2-grow"></div><button class="v2-b blue w" data-a="join" data-enter="code">Join table</button></div>
  ${`<div class="v2-panel v2-col v2-party-card">${ico('eye', 7)}<b class="v2-h">Watch a table</b><div class="v2-mut">Spectate live games: public tables, or a private one by its code.</div><div class="v2-grow"></div>${btn('Watch', 'watch', { h: 'violet', c: 'w' })}</div>`}
</div></div>`;
  },
  actions: {
    'nh-host': () => void nearHostTable(),
    'nh-join': () => {
      const id = tableIdFrom(party.input?.code ?? '');
      if (!id) return ui().message('Join a table', 'Paste the invite link (or table id) your friend shared.');
      rememberHostedTable(id);
      void nearSitAt(id);
    },
    'nh-sit': (v) => void nearSitAt(String(v)),
    'nh-link': (v) => void nearCopyLink(String(v)),
    'nh-close': (v) => void nearCloseHosted(String(v)),
    'nh-forget': (v) => {
      forgetHostedTable(String(v));
      void hostedTables.load();
    },
    create: () => {
      if (!signedIn()) return host().show('Login');
      if (needCoins(PARTY_MIN_BUYIN, 'A private table')) return;
      startParty(host(), app(), true, '');
    },
    watch: () => ui().show('watch'),
    join: () => {
      const code = (party.input?.code ?? '').trim();
      if (!code) return ui().message('Join a party', 'Enter the session code your friend shared.');
      if (needCoins(PARTY_MIN_BUYIN, 'Joining a private table')) return;
      startParty(host(), app(), false, code);
    },
  },
};

/** Blinds in NEAR (a chip is 0.001 NEAR), e.g. "0.001 / 0.002 NEAR". */
const nearBlinds = (sb: number, bb: number): string => `${formatNear(chipsToYocto(sb), 3)} / ${formatNear(chipsToYocto(bb), 3)} NEAR`;

/** Play with friends in On-chain: host a NEAR table, join one by its link, and the tables you host or joined. */
function nearParty(code: string): string {
  const me = nearAccountId();
  const rows = hostedTables.list.map(({ t, table, seat }) => {
    const open = !!table && !table.closed;
    const mine = seat && BigInt(seat.locked) > 0n ? yoctoToChips(seat.locked) : 0;
    const iHost = !!table?.host && table.host === me;
    const status = mine ? `<span class="v2-good">your seat: ${formatN0(mine)} chips</span>` : !table ? 'not found on NEAR' : table.closed ? 'closed' : `${table.seated} / ${table.config.seats} seated`;
    const who = table ? (iHost ? 'hosted by you' : `hosted by ${esc(table.host ?? '?')}`) + (table.invite_only ? ' · invite-only' : '') : '';
    return `<div class="v2-card v2-col" style="gap:.45em"><div><b>${esc(t.name.replace('Hosted · ', ''))}</b> <span class="v2-xs v2-mut">${nearBlinds(t.config.small_blind, t.config.big_blind)}</span><div class="v2-xs v2-mut">${who}${who ? ' · ' : ''}${status}</div></div><div class="v2-row v2-wrap" style="gap:.4em">${open || mine ? btn(mine ? 'Sit' : 'Buy in & sit', 'nh-sit', { h: 'gold', c: 'sm', v: t.id }) : ''}${open ? btn('Copy link', 'nh-link', { h: 'violet', c: 'sm', v: t.id }) : ''}${iHost && open ? btn('Close', 'nh-close', { h: 'ghost', c: 'sm', v: t.id }) : ''}${!open && !mine ? btn('Remove', 'nh-forget', { h: 'ghost', c: 'sm', v: t.id }) : ''}</div></div>`;
  }).join('');
  const list = hostedTables.loading && !hostedTables.list.length
    ? '<div class="v2-empty">Loading from NEAR…</div>'
    : rows || '<div class="v2-empty">Tables you host, or join with a link, show here.</div>';
  return topBar('Play with friends') + `<div class="v2-body">
<div class="v2-party-sub v2-mut">Your own NEAR tables: the escrow holds every stake</div>
<div class="v2-party">
  <div class="v2-panel v2-col v2-party-card">${ico('cards', 7)}<b class="v2-h">Host a table</b><div class="v2-mut">Pick the stakes, invite friends by NEAR account or share the link.</div><div class="v2-grow"></div>${btn('Host a table', 'nh-host', { h: 'gold', c: 'w' })}</div>
  <div class="v2-panel v2-col v2-party-card">${ico('friends', 7)}<b class="v2-h">Join a table</b><div class="v2-mut">Paste the invite link a friend shared.</div>${input('code', code, 'Invite link', { max: 200, cls: 'v2-party-code' })}<div class="v2-grow"></div><button class="v2-b blue w" data-a="nh-join" data-enter="code">Join table</button></div>
  <div class="v2-panel v2-col v2-party-card v2-scroll"><b class="v2-h">Your tables</b>${list}</div>
</div></div>`;
}

// ------------------------------------------------------------------ Watch (spectate)

interface LiveTable {
  session: string;
  stake: number;
  seated: number;
  players: number;
  watchers: number;
}

/**
 * Spectating: the public tables being played right now (the game server's /v1/tables/live, busiest first) and a room
 * code box for private tables. Watching never takes a seat or Coins; hole cards stay hidden until a showdown.
 */
const watch: ScreenDef & { tables: LiveTable[] | null; error: string; timer: ReturnType<typeof setInterval> | 0 } = {
  id: 'watch',
  back: 'party',
  input: { code: '' },
  tables: null,
  error: '',
  timer: 0,
  open() {
    this.input = { code: '' };
    this.tables = null;
    this.error = '';
    const load = async () => {
      const base = cloudGameServer(app().params);
      if (!base) {
        this.tables = [];
        this.error = 'The list of live tables needs the online game server. You can still watch a table by its code.';
        ui().render();
        return;
      }
      try {
        const r = await fetch(`${base}/v1/tables/live`);
        const body = (await r.json()) as { tables?: LiveTable[]; error?: string };
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        this.tables = body.tables ?? [];
        this.error = '';
      } catch {
        this.tables ??= [];
        this.error = "Couldn't load the live tables. Check your connection.";
      }
      ui().render();
    };
    void load();
    this.timer = setInterval(() => void load(), 15_000);
  },
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  },
  render() {
    const list = this.tables;
    const rows =
      list === null
        ? `<div class="v2-empty">Loading live tables…</div>`
        : list.length === 0
          ? `<div class="v2-empty">${ico('eye', 6)}${esc(this.error || 'No public tables are being played right now. Check back in a minute.')}</div>`
          : list
              .map((t) => {
                const tier = StakeCatalog.get(t.stake);
                const who = `${t.seated} playing${t.watchers ? ` · ${t.watchers} watching` : ''}`;
                return `<div class="v2-card v2-row v2-watch-row"><div class="v2-grow"><b>${esc(tier.displayName)} table · ${esc(tier.blindsLabel)}</b><div class="v2-xs v2-mut">${esc(who)}</div></div>${btn('Watch', 'w-go', { h: 'gold', c: 'sm', v: t.session })}</div>`;
              })
              .join('');
    return (
      topBar('Watch a table') +
      `<div class="v2-body v2-watch">
  <div class="v2-panel v2-col v2-watch-list"><b class="v2-h">Live public tables</b><div class="v2-col v2-scroll v2-grow" style="gap:.5em">${rows}</div></div>
  <div class="v2-panel v2-col v2-watch-code"><b class="v2-h">Private table</b><div class="v2-mut">Enter the room code a player shared to watch their table.</div>${input('code', this.input?.code ?? '', 'Room code', { max: 12, cls: 'v2-party-code' })}<button class="v2-b blue w" data-a="w-code" data-enter="code">Watch table</button><div class="v2-xs v2-mut">Spectators see the table and the community cards. Players' cards stay hidden until a showdown.</div></div>
</div>`
    );
  },
  actions: {
    'w-go': (v) => startWatch(host(), app(), String(v)),
    'w-code': () => {
      const code = (watch.input?.code ?? '').trim().toUpperCase();
      if (!code) return ui().message('Watch a table', 'Enter the room code of the table you want to watch.');
      startWatch(host(), app(), code);
    },
  },
};

/** Private tables buy in for 500–1,000 Coins (economy/party.ts PrivateMinBuyIn). */
const PARTY_MIN_BUYIN = 500;

export function playScreens(): ScreenDef[] {
  return [tables, party, watch];
}
