/** Play: Choose your table, Party, Host a SOL table. Atlas: Redesign v2 › Play. */
import { StakeCatalog, formatN0, type StakeTier } from '@nomad/engine';
import { joinFreePlay } from '../../menu/screens/mainMenu';
import { StakeTableSkin, type Theme } from '../../menu/stakes';
import { MENU_DATA } from '../../menu/data';
import { assetUrl } from '../../hud/unityUi';
import { startParty } from '../../economy/nomad/social';
import { STAKES as SOL_STAKES, sol, stakeMinBuyIn, stakeMaxBuyIn } from '../../web3/per/money';
import { w3 } from '../../web3/services';
import { btn, esc, act, tabs, chips, input } from '../core';
import { ico } from '../icons';
import { ui, host, app, S, onchain, onchainApi, topBar, signedIn, needCoins } from '../ctx';
import type { ScreenDef } from '../install';
import './play.css';

/** The five rooms (Unity TableSelect cards), cheapest first; index = SOL stake level. */
const ROOMS: { theme: Theme; name: string; color: string }[] = [
  { theme: 'Default', name: 'Solana', color: '#9945ff' },
  { theme: 'Forest', name: 'Forest', color: '#2e8b57' },
  { theme: 'Town', name: 'Town', color: '#d08a3a' },
  { theme: 'Desert', name: 'Desert', color: '#d6a85c' },
  { theme: 'Neon_City', name: 'Neon City', color: '#ff4fa3' },
];

/** The room's table background art (the scene the table plays in), or null. */
function roomArt(theme: Theme): string | null {
  try {
    const pack = MENU_DATA.themes.find((t) => t.theme === theme);
    const sp = pack?.tableBackground ? MENU_DATA.sprites[pack.tableBackground] : null;
    return sp?.file ? assetUrl(sp.file) : null;
  } catch {
    return null;
  }
}

const bgArt = (theme: Theme, color: string): string => {
  const url = roomArt(theme);
  return `background:${url ? `linear-gradient(180deg,rgba(26,15,74,0) 40%,rgba(26,15,74,.85)),url('${esc(url)}') center/cover no-repeat,` : ''}linear-gradient(160deg,${color},#1a0f4a)`;
};

// ------------------------------------------------------------------ Choose your table

interface PrivRow {
  address: string;
  blinds: string;
  host: string;
  seated: string;
  access: string;
  buyIn: string;
  mine: boolean;
  join: () => Promise<void>;
}

const tables: ScreenDef & {
  theme: Theme;
  tab: 'pub' | 'priv';
  priv: { loading: boolean; rows: PrivRow[]; error: string | null; loaded: boolean };
} = {
  id: 'tables',
  replaces: ['TableSelect_TownLobby'],
  theme: 'Town',
  tab: 'pub',
  priv: { loading: false, rows: [], error: null, loaded: false },
  input: { code: '' },
  open() {
    this.theme = StakeTableSkin.themeFor(host().stakes.resolve().minBuyIn);
    this.tab = 'pub';
    this.priv.loaded = false;
  },
  render() {
    const chain = onchain();
    const tabsHtml = chain ? `<div class="v2-ts-tabs">${tabs([['pub', 'Public tables'], ['priv', 'Private tables']], this.tab, 'ts-tab')}</div>` : '';
    if (chain && this.tab === 'priv') return topBar('CHOOSE YOUR TABLE') + `<div class="v2-body">${tabsHtml}${privatePanel(this)}</div>`;
    const stakes = host().stakes;
    const level = levelOf(this.theme);
    const room = ROOMS[level]!;
    const tier = selectedTier(this.theme);
    const canSit = stakes.canSit(tier);
    const solInfo = chain ? onchainApi.tableStakes?.(level) : null;
    const coinsNow = stakes.coins;
    const cards = ROOMS.map((r, i) => {
      const t = StakeTableSkin.stakesFor(r.theme)[0]!;
      const locked = !chain && !StakeTableSkin.canAfford(r.theme, coinsNow);
      const sub = chain ? onchainApi.tableStakes?.(i).blinds ?? '' : `${t.displayName} · ${t.blindsLabel}`;
      return `<button class="v2-stc${r.theme === this.theme ? ' on' : ''}${locked ? ' locked' : ''}"${act('room', r.theme)} aria-pressed="${r.theme === this.theme}"><div class="v2-stc-art" style="${bgArt(r.theme, r.color)}">${locked ? `<span class="v2-stc-lock">${ico('lock', 1.6)}</span>` : ''}</div><b>${r.name}</b><small>${esc(sub)}</small></button>`;
    }).join('');
    const buyVal = chain ? solInfo?.buyIn ?? '' : formatN0(canSit ? stakes.selectedBuyInChips : tier.minBuyIn);
    return topBar('CHOOSE YOUR TABLE') + `<div class="v2-body">${tabsHtml}
<div class="v2-ts">
  <div class="v2-ts-left">
    <div class="v2-ts-preview" style="${bgArt(room.theme, room.color)}"><div class="v2-ts-felt"></div><div class="v2-ts-cap"><b>${room.name} room</b><div class="v2-sm v2-mut">Your table plays in this room</div></div></div>
    <div class="v2-ts-cards">${cards}</div>
  </div>
  <div class="v2-panel v2-col v2-ts-sel">
    <span class="v2-cap">Selected table</span>
    <b class="v2-h v2-ts-name">${room.name}</b>
    <div class="v2-kv"><span>Stakes</span><b>${chain ? `${esc(StakeCatalog.Tiers[level]?.displayName ?? solInfo?.label ?? '')} Stakes (SOL)` : `${tier.displayName} Stakes`}</b></div>
    <div class="v2-kv"><span>Blinds</span><b>${esc(chain ? solInfo?.blinds ?? '' : tier.blindsLabel)}</b></div>
    <div class="v2-kv"><span>Minimum buy-in</span><b>${esc(chain ? solInfo?.minBuyIn ?? '' : formatN0(tier.minBuyIn))}</b></div>
    <span class="v2-sm v2-mut" style="margin-top:.4em">Your buy-in</span>
    <div class="v2-row">${btn('−', 'buy-step', { h: 'ghost', v: -1 })}<div class="v2-field v2-grow v2-num v2-ts-buy">${esc(buyVal)}</div>${btn('+', 'buy-step', { h: 'ghost', v: 1 })}</div>
    <div class="v2-row">${btn('MIN', 'buy-end', { v: 'min', c: 'v2-grow' })}${btn('2×', 'buy-end', { v: 'double', c: 'v2-grow' })}${btn('MAX', 'buy-end', { v: 'max', c: 'v2-grow' })}</div>
    ${!chain && !canSit ? `<div class="v2-xs v2-badc">You need ${formatN0(tier.minBuyIn)} Coins to sit here.</div>` : ''}
    <div class="v2-grow"></div>
    ${btn('JOIN TABLE ›', 'join', { h: 'gold', c: 'lg w' })}
  </div>
</div></div>`;
  },
  actions: {
    room: (v) => {
      tables.theme = v as Theme;
      StakeTableSkin.selectThemeTable(tables.theme, host().stakes, (t) => S('theme')?.setTheme?.(t));
    },
    'ts-tab': (v) => {
      tables.tab = v as 'pub' | 'priv';
      if (tables.tab === 'priv' && !tables.priv.loaded) void loadPrivate(tables);
    },
    'buy-step': (v) => {
      const dir = Number(v);
      if (onchain()) return void onchainApi.stepBuyIn?.(levelOf(tables.theme), dir);
      const s = host().stakes;
      const tier = s.resolve();
      s.selectedBuyInChips = s.selectedBuyInChips + dir * Math.max(1, tier.bigBlind * 10);
    },
    'buy-end': (v) => {
      const end = v as 'min' | 'max' | 'double';
      if (onchain()) return void onchainApi.setBuyInEnd?.(levelOf(tables.theme), end);
      const s = host().stakes;
      const t = s.resolve();
      s.selectedBuyInChips = end === 'min' ? s.minBuyInChips(t) : end === 'max' ? s.maxBuyInChips(t) : s.selectedBuyInChips * 2;
    },
    join: () => {
      const h = host();
      if (!signedIn()) return h.show('Login');
      if (onchain()) return void onchainApi.joinTable?.(levelOf(tables.theme));
      const tier = selectedTier(tables.theme);
      if (!h.stakes.canSit(tier)) {
        ui().openDialog({
          title: 'Not enough Coins',
          body: `${esc(tier.displayName)} tables need ${formatN0(tier.minBuyIn)} Coins to sit. Pick a lower table, or get Coins in the Shop.`,
          buttons: btn('Shop', 'nec-shop', { h: 'green' }) + btn('OK', 'nec-ok', { h: 'gold' }),
          actions: { 'nec-shop': () => ui().show('shop', 'coins'), 'nec-ok': () => ui().closeDialog() },
        });
        return;
      }
      void joinFreePlay(h, tier, h.stakes.selectedBuyInChips, 'join');
    },
    'priv-refresh': () => loadPrivate(tables),
    'priv-code': () => {
      const code = (tables.input?.code ?? '').trim();
      if (!code) return ui().message('Join by code', 'Enter the table code your friend shared.');
      void onchainApi.partyJoin?.(code);
    },
    'priv-host': () => ui().show('sol-host'),
    'priv-lobby': () => onchainApi.openPrivateTables?.(),
    'priv-join': (v) => {
      const row = tables.priv.rows.find((r) => r.address === v);
      if (row) void row.join();
    },
  },
};

const levelOf = (theme: Theme): number => Math.max(0, ROOMS.findIndex((r) => r.theme === theme));

/** The chosen stake if it plays in this room, else the room's entry stake (NomadUiHost SelectedTableTier). */
function selectedTier(theme: Theme): StakeTier {
  const stakes = host().stakes;
  const chosen = stakes.selectedMinBuyIn;
  const tier = chosen > 0 ? StakeCatalog.get(chosen) : stakes.resolve();
  return StakeTableSkin.themeFor(tier.minBuyIn) === theme ? tier : StakeTableSkin.stakesFor(theme)[0]!;
}

function privatePanel(t: typeof tables): string {
  const p = t.priv;
  const grid = 'v2-ptgrid';
  const body = p.loading
    ? `<div class="v2-empty">Loading private tables…</div>`
    : p.error
      ? `<div class="v2-empty">${ico('sol', 4)}<span>Couldn't load the private tables: ${esc(p.error)}</span><div class="v2-row">${btn('Try again', 'priv-refresh', { h: 'blue' })}${btn('Open the SOL lobby', 'priv-lobby', { h: 'ghost' })}</div></div>`
      : p.rows.length === 0
        ? `<div class="v2-empty">${ico('sol', 4)}<span>No private SOL tables are open right now.<br>Host one, or join a friend's table by code.</span></div>`
        : `<div class="${grid} v2-pthdr"><span>Blinds</span><span>Host</span><span>Seated</span><span>Access</span><span>Buy-in</span><span></span></div>
           <div class="v2-scroll v2-col" style="gap:.4em;flex:1;min-height:0">${p.rows
             .map((r) => `<div class="${grid} v2-ptrow"><b>${esc(r.blinds)}</b><span class="v2-ellip">${esc(r.mine ? 'You' : r.host)}</span><span>${esc(r.seated)}</span><span><span class="v2-pill">${esc(r.access)}</span></span><b class="v2-num">${esc(r.buyIn)}</b>${btn(r.mine ? 'Open' : 'Join', 'priv-join', { h: r.mine ? 'violet' : 'gold', c: 'sm', v: r.address })}</div>`)
             .join('')}</div>`;
  return `<div class="v2-panel v2-col v2-priv" style="flex:1;min-height:0">
  <div class="v2-row v2-wrap v2-priv-top"><b class="v2-h v2-grow">Private SOL tables</b>${input('code', t.input?.code ?? '', 'Table code', { max: 44, cls: 'v2-priv-code' })}${btn('Join by code', 'priv-code', { h: 'blue' })}${p.loaded && !p.loading && !p.error ? btn('Refresh', 'priv-refresh', { h: 'ghost' }) : ''}${btn('+ Host a table', 'priv-host', { h: 'gold' })}</div>
  ${body}
  <div class="v2-xs v2-mut">Cards are readable only by your own table key (MagicBlock TEE, devnet).</div>
</div>`;
}

async function loadPrivate(t: typeof tables): Promise<void> {
  t.priv = { loading: true, rows: [], error: null, loaded: true };
  ui().render();
  try {
    const per = await w3(app()).per.get();
    const list = await per.listTables();
    const me = per.gameWallet.address?.toBase58() ?? null;
    const u64 = (v: unknown): bigint => {
      try {
        return typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v ?? '0').trim() || '0');
      } catch {
        return 0n;
      }
    };
    const rows: PrivRow[] = [];
    for (const r of list) {
      if (Number(r.maxSeats ?? 0) > 8) continue;
      const min = u64(r.minBuyIn), max = u64(r.maxBuyIn), sb = u64(r.smallBlind), bb = u64(r.bigBlind);
      const address = String(r.address ?? '');
      const creator = String(r.creator ?? '');
      const buyIn = per.buyIn.for(min, max, bb);
      rows.push({
        address,
        blinds: `${sol(sb)} / ${sol(bb)}`,
        host: creator ? `${creator.slice(0, 4)}…${creator.slice(-4)}` : '—',
        seated: `${Number(r.seated ?? 0)} / ${Number(r.maxSeats ?? 0)}`,
        access: r.inviteOnly === true ? 'Invite-only' : 'Anyone',
        buyIn: sol(buyIn),
        mine: me !== null && me === creator,
        join: async () => {
          const { joinAndGo } = await import('../../web3/ui/lobby');
          await joinAndGo(app(), per, address, buyIn, (s) => ui().toast(s, 3000), { smallBlind: sb, bigBlind: bb, minBuyIn: min, maxBuyIn: max });
        },
      });
    }
    t.priv = { loading: false, rows, error: null, loaded: true };
  } catch (e) {
    t.priv = { loading: false, rows: [], error: e instanceof Error ? e.message : String(e), loaded: true };
  }
  ui().render();
}

// ------------------------------------------------------------------ Party

const party: ScreenDef = {
  id: 'party',
  replaces: ['PartyMenu'],
  input: { code: '' },
  open() {
    this.input = { code: '' };
  },
  render() {
    const chain = onchain();
    return topBar('PARTY') + `<div class="v2-body">
<div class="v2-party-sub v2-mut">${chain ? 'Private SOL tables with friends' : 'Private tables with friends'}</div>
<div class="v2-party">
  <div class="v2-panel v2-col v2-party-card">${ico('cards', 7)}<b class="v2-h">Create Party</b><div class="v2-mut">${chain ? 'Open a private SOL table and share its code.' : 'Start a private table and share the code.'}</div><div class="v2-grow"></div>${btn('CREATE', 'create', { h: 'gold', c: 'lg w' })}</div>
  <div class="v2-panel v2-col v2-party-card">${ico('friends', 7)}<b class="v2-h">Join Party</b><div class="v2-mut">Join a friend's table with their code.</div>${input('code', this.input?.code ?? '', 'Enter session code', { max: chain ? 44 : 12, cls: 'v2-party-code' })}<div class="v2-grow"></div><button class="v2-b blue lg w" data-a="join" data-enter="code">JOIN</button></div>
</div></div>`;
  },
  actions: {
    create: () => {
      if (!signedIn()) return host().show('Login');
      if (onchain()) return ui().show('sol-host');
      if (needCoins(PARTY_MIN_BUYIN, 'A private table')) return;
      startParty(host(), app(), true, '');
    },
    join: () => {
      const code = (party.input?.code ?? '').trim();
      if (!code) return ui().message('Join a party', 'Enter the session code your friend shared.');
      if (needCoins(PARTY_MIN_BUYIN, 'Joining a private table')) return;
      startParty(host(), app(), false, code);
    },
  },
};

/** Private tables buy in for 500–1,000 Coins (economy/nomad/social.ts PrivateMinBuyIn). */
const PARTY_MIN_BUYIN = 500;

// ------------------------------------------------------------------ Host a SOL table

type Access = 'anyone' | 'link' | 'invite';

const solHost: ScreenDef & { stake: number; seats: number; access: Access; invitees: string[]; busy: boolean } = {
  id: 'sol-host',
  back: 'tables',
  stake: 2,
  seats: 6,
  access: 'anyone',
  invitees: [],
  busy: false,
  input: { wallet: '' },
  render() {
    const st = SOL_STAKES[this.stake]!;
    const blinds = SOL_STAKES.map((s, i) => {
      const r = ROOMS[i] ?? ROOMS[0]!;
      const name = StakeCatalog.Tiers[i]?.displayName ?? s.label;
      return `<button class="v2-stc${i === this.stake ? ' on' : ''}"${act('sh-stake', i)}><div class="v2-stc-art v2-center" style="background:linear-gradient(${r.color},#1a0f4a)">${ico('sol', 2)}</div><b>${esc(name)}</b><small>${sol(s.small)} / ${sol(s.big)}</small></button>`;
    }).join('');
    const seats: [string, string][] = [2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), String(n)]);
    const name = StakeCatalog.Tiers[this.stake]?.displayName ?? st.label;
    return topBar('HOST A SOL TABLE', { toggle: false, back: 'tables' }) + `<div class="v2-body"><div class="v2-sh">
  <div class="v2-panel v2-col v2-sh-form v2-scroll">
    <b class="v2-h">Blinds <span class="v2-sm v2-mut" style="font-family:var(--v2-ui)">buy-in 10 to 100 big blinds</span></b>
    <div class="v2-sh-blinds">${blinds}</div>
    <b class="v2-h">Seats</b><div class="v2-row v2-wrap">${chips(seats, String(this.seats), 'sh-seats', true)}</div>
    <b class="v2-h">Who can join</b><div class="v2-row v2-wrap">${chips([['anyone', 'Anyone'], ['link', 'Link only'], ['invite', 'Invite-only']], this.access, 'sh-access', true)}</div>
    ${this.access === 'invite' ? `<div class="v2-row">${input('wallet', this.input?.wallet ?? '', 'Invitee wallet address (up to 15)', { max: 44, cls: 'v2-grow' })}<button class="v2-b blue" data-a="sh-add" data-enter="wallet">+ Add</button></div>
    <div class="v2-row v2-wrap v2-sm">${this.invitees.length ? this.invitees.map((w) => `<button class="v2-pill"${act('sh-del', w)} aria-label="Remove ${esc(w)}">${esc(w.slice(0, 4))}…${esc(w.slice(-3))} ✕</button>`).join('') : '<span class="v2-mut">Only you and wallets you add (plus the invite link) can sit.</span>'}</div>` : `<div class="v2-sm v2-mut">${this.access === 'link' ? 'Only people with the invite link can sit. You get the link in Your tables.' : 'Anyone can find and join this table.'}</div>`}
  </div>
  <div class="v2-panel v2-col v2-sh-sum">
    <b class="v2-h">Summary</b>
    <div class="v2-sh-felt v2-center"><span class="v2-pill">${esc(name)} ${sol(st.small)} / ${sol(st.big)} · ${this.seats} seats</span></div>
    <div class="v2-kv"><span>Buy-in</span><b>${sol(stakeMinBuyIn(this.stake))} – ${sol(stakeMaxBuyIn(this.stake))}</b></div>
    <div class="v2-kv"><span>Open cost</span><b>≈ ◎ 0.03</b></div>
    <div class="v2-kv"><span>Back on close</span><b>≈ ◎ 0.013</b></div>
    <div class="v2-kv"><span>Rake</span><b>5% of buy-ins</b></div>
    <div class="v2-kv"><span>Auto-close</span><b>6 h empty</b></div>
    <div class="v2-grow"></div>
    <div class="v2-xs v2-mut">You approve once in your wallet, then you're seated from your game balance.</div>
    ${btn(this.busy ? 'CREATING…' : 'CREATE TABLE', 'sh-create', { h: 'gold', c: 'lg w', dis: this.busy })}
  </div>
</div></div>`;
  },
  actions: {
    'sh-stake': (v) => void (solHost.stake = Number(v)),
    'sh-seats': (v) => void (solHost.seats = Number(v)),
    'sh-access': (v) => void (solHost.access = v as Access),
    'sh-add': () => {
      const w = (solHost.input?.wallet ?? '').trim();
      if (!w) return;
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return ui().message('Invite a wallet', "That isn't a Solana wallet address.");
      if (solHost.invitees.length >= 15) return ui().message('Invite a wallet', 'Up to 15 wallets besides you.');
      if (!solHost.invitees.includes(w)) solHost.invitees.push(w);
      solHost.input = { wallet: '' };
    },
    'sh-del': (v) => void (solHost.invitees = solHost.invitees.filter((w) => w !== v)),
    'sh-create': () => createSolTable(),
  },
};

async function createSolTable(): Promise<void> {
  if (solHost.busy) return;
  if (!signedIn()) return host().show('Login');
  solHost.busy = true;
  let status = 'Getting ready…';
  const dlg = (): void =>
    ui().openDialog({ title: 'Host a SOL table', body: () => `<div class="v2-row">${ico('sol', 2.4)}<span>${esc(status)}</span></div>`, buttons: btn('Hide', 'sh-hide', { h: 'ghost' }), actions: { 'sh-hide': () => ui().closeDialog() }, dismiss: false });
  dlg();
  try {
    const per = await w3(app()).per.get();
    const [{ hostSolTable }, { PublicKey }] = await Promise.all([import('../../web3/ui/lobbyHost'), import('@solana/web3.js')]);
    const invitees = solHost.access === 'invite' ? solHost.invitees.map((w) => new PublicKey(w)) : [];
    await hostSolTable(app(), per, { stake: solHost.stake, seats: solHost.seats, inviteOnly: solHost.access !== 'anyone', invitees }, (s) => {
      status = s;
      ui().render();
    });
    ui().closeDialog();
  } catch (e) {
    ui().closeDialog();
    ui().message("Couldn't host", esc(e instanceof Error ? e.message : String(e)));
  } finally {
    solHost.busy = false;
    ui().render();
  }
}

export function playScreens(): ScreenDef[] {
  return [tables, party, solHost];
}
