/** Play: Choose your table (Public and, On-chain, Private SOL tables), Party, Host a SOL table. Atlas: Redesign v2 › Play. */
import { StakeCatalog, formatN0, type StakeTier } from '@nomad/engine';
import { joinFreePlay } from '../../menu/screens/mainMenu';
import { StakeTableSkin, type Theme } from '../../menu/stakes';
import { MENU_DATA } from '../../menu/data';
import { assetUrl } from '../../hud/unityUi';
import { startParty, startWatch } from '../../economy/nomad/social';
import { cloudGameServer } from '../../net/serverUrl';
import { chain, chainMoney, type ChainService, type HostedRow, type LobbyRead } from '../../chain';
import { btn, esc, act, tabs, chips, input, type Action } from '../core';
import { ico } from '../icons';
import { ui, host, app, S, onchain, onchainApi, topBar, signedIn, needCoins, getCoinsRoute, copy } from '../ctx';
import { shortAddr, solAmt, solError, solTask } from './solKit';
import type { ScreenDef } from '../install';
import { nearTablesScreen } from './nearTables';
import './play.css';

/** The five rooms (Unity TableSelect cards), cheapest first; index = SOL stake level. */
export const ROOMS: { theme: Theme; name: string; color: string }[] = [
  { theme: 'Default', name: 'Solana', color: '#9945ff' },
  { theme: 'Forest', name: 'Forest', color: '#2e8b57' },
  { theme: 'Town', name: 'Town', color: '#d08a3a' },
  { theme: 'Desert', name: 'Desert', color: '#d6a85c' },
  { theme: 'Neon_City', name: 'Neon City', color: '#ff4fa3' },
];

/**
 * Sharper copies of the room art: the menu export is 1541×578 and looked soft on the big room cards (and upscaled 2-3×
 * on phones). These are the same scenes at 2048×768 (theming/) and 2880×1080 (Solana, 3d/).
 */
const ROOM_ART_HI: Partial<Record<Theme, string>> = {
  Default: 'assets/3d/BG.webp',
  Forest: 'assets/theming/Forest/Forest_bg.webp',
  Town: 'assets/theming/Town/Town_bg.webp',
  Desert: 'assets/theming/Desert/Desert_bg.webp',
  Neon_City: 'assets/theming/Neon_City/Neon_City_bg.webp',
};

/** The room's table background art (the scene the table plays in), or null. */
export function roomArt(theme: Theme): string | null {
  const hi = ROOM_ART_HI[theme];
  if (hi) return assetUrl(hi);
  try {
    const pack = MENU_DATA.themes.find((t) => t.theme === theme);
    const sp = pack?.tableBackground ? MENU_DATA.sprites[pack.tableBackground] : null;
    return sp?.file ? assetUrl(sp.file) : null;
  } catch {
    return null;
  }
}

export const bgArt = (theme: Theme, color: string): string => {
  const url = roomArt(theme);
  return `background:${url ? `linear-gradient(180deg,transparent 55%,color-mix(in srgb,var(--v2-shade) 55%,transparent)),url('${esc(url)}') center/cover no-repeat,` : ''}linear-gradient(160deg,${color},var(--v2-bg-top))`;
};

// ------------------------------------------------------------------ Choose your table


// ------------------------------------------------------------------ Private SOL tables (Tables › Private tables)

/** An on-chain amount for display. Lobby actions go through the chain seam (src/chain), loaded on first use. */
const sol = (units: bigint | number): string => chainMoney().format(units);
const walletNow = (): string | null => onchainApi.walletAddress?.() ?? null;
const findHosted = (v: string): HostedRow | null => tables.priv.data?.hosted.find((h) => h.address === v) ?? null;
const reloadPrivate = (): void => void loadPrivate(tables);

async function loadPrivate(t: typeof tables): Promise<void> {
  const wallet = walletNow();
  t.priv = { ...t.priv, loading: true, loaded: true, error: null, wallet };
  ui().render();
  try {
    const c = await chain();
    t.priv = { loading: false, loaded: true, error: null, data: await c.lobby.read(), wallet };
  } catch (e) {
    console.error('[ui2] private tables', e);
    t.priv = { loading: false, loaded: true, error: solError(e, "Couldn't load the private tables. Check your connection and try again."), data: null, wallet };
  }
  ui().render();
}

function walletStrip(): string {
  const addr = walletNow();
  if (!addr)
    return `<div class="v2-card v2-row v2-wrap v2-priv-wallet">${ico('sol', 2.2)}<div class="v2-grow"><b>Connect a wallet to play SOL tables</b><div class="v2-xs v2-mut">They run on the Solana test network, with test SOL.</div></div>${btn('Connect wallet', 'priv-connect', { h: 'gold' })}</div>`;
  const [main = '', note = ''] = (onchainApi.balanceText?.() ?? '').split(' · ');
  const amount = /^Tap/.test(main) || !main
    ? btn('Show balance', 'priv-balance', { h: 'ghost', c: 'sm' })
    : `<button class="v2-solamt v2-priv-bal"${act('priv-balance')} aria-label="Game balance, tap to refresh">${ico('sol', 1.1)}<b class="v2-num">${esc(main.split(' (')[0])}</b></button>`;
  return `<div class="v2-card v2-row v2-wrap v2-priv-wallet">
    <div class="v2-col v2-priv-kv"><span class="v2-cap">Wallet</span><b class="v2-num">${esc(shortAddr(addr))}</b></div>
    ${btn('Copy address', 'priv-copy', { h: 'blue', c: 'sm' })}
    <div class="v2-col v2-priv-kv"><span class="v2-cap">Game balance</span>${amount}${note ? `<span class="v2-xs v2-mut">${esc(note)}</span>` : ''}</div>
    <span class="v2-grow"></span>
    <div class="v2-row v2-priv-money">${btn('Deposit', 'priv-deposit', { h: 'gold', c: 'sm' })}${btn('Withdraw', 'priv-withdraw', { h: 'blue', c: 'sm' })}<button class="v2-b ghost sm"${act('priv-more')} aria-label="More wallet options" title="More">${ico('more', 1)}</button></div>
  </div>`;
}

function hostedRow(h: HostedRow): string {
  const deposit = `${ico('sol', 1)} about 0.013 SOL`;
  let pill: string;
  let detail: string;
  let buttons = '';
  switch (h.state) {
    case 'old-list':
      pill = '<span class="v2-pill">Closed</span>';
      detail = `Its old invite list still holds a deposit (${deposit})`;
      buttons = btn('Get deposit back', 'h-oldlist', { h: 'gold', c: 'sm', v: h.address });
      break;
    case 'closed':
      pill = '<span class="v2-pill">Closed</span>';
      detail = `Its deposit (${deposit}) can come back to your wallet`;
      buttons = btn('Get deposit back', 'h-reclaim', { h: 'gold', c: 'sm', v: h.address });
      break;
    case 'open':
      pill = '<span class="v2-pill ok">Open</span>';
      detail = `${h.seated} / ${h.maxSeats} seated${h.links ? ' · invite link' : ''}`;
      if (h.links) buttons += (h.link ? btn('Copy invite link', 'h-copy', { h: 'blue', c: 'sm', v: h.address }) : '') + btn(h.link ? 'New link' : 'Make a link', 'h-newlink', { h: h.link ? 'ghost' : 'blue', c: 'sm', v: h.address });
      buttons += btn('Close table', 'h-close', { h: 'red', c: 'sm', v: h.address, dis: h.seated > 0, title: h.seated > 0 ? 'You can close it once everyone has left' : 'Close this table' });
      break;
    case 'unlisted':
      pill = '<span class="v2-pill ok">Open</span>';
      detail = 'It shows in the list within a minute';
      buttons = btn(`Join ${ico('sol', 0.9)} ${esc(sol(h.buyIn))}`, 'h-join', { h: 'gold', c: 'sm', v: h.address });
      break;
    case 'not-open':
      pill = '<span class="v2-pill gold">Not open yet</span>';
      detail = 'Created, but not open for players yet';
      buttons = btn('Open it', 'h-open', { h: 'gold', c: 'sm', v: h.address });
      break;
    default:
      pill = `<span class="v2-pill">${esc(h.pending)}</span>`;
      detail = 'This takes a few seconds';
  }
  return `<div class="v2-card v2-row v2-wrap v2-priv-host">${pill}<span class="v2-grow v2-sm"><b class="v2-num">${esc(shortAddr(h.address))}</b> · ${detail}</span><div class="v2-row v2-wrap v2-priv-hbtns">${buttons}</div></div>`;
}

function privatePanel(t: typeof tables): string {
  const p = t.priv;
  const wallet = walletNow();
  // The wallet changed (connected, switched): read "Your tables" again.
  if (p.loaded && !p.loading && wallet !== p.wallet) queueMicrotask(reloadPrivate);
  const grid = 'v2-ptgrid';
  const d = p.data;
  let body: string;
  if (!d && (p.loading || !p.loaded)) body = `<div class="v2-empty"><i class="v2-spin" aria-hidden="true"></i><span>Loading private tables…</span></div>`;
  else if (!d) body = `<div class="v2-empty">${ico('sol', 4)}<span>${esc(p.error ?? '')}</span>${btn('Try again', 'priv-refresh', { h: 'blue' })}</div>`;
  else {
    const notes = d.linkedClosed ? `<div class="v2-card v2-row v2-sm">${ico('lock', 1.6)}<span class="v2-grow">The table in your invite link (${esc(shortAddr(d.linkedClosed))}) isn't open right now. Ask the host to open it again.</span></div>` : '';
    const hosted = d.hosted.length ? `<span class="v2-cap">Your tables</span>${d.hosted.map(hostedRow).join('')}<span class="v2-cap">Open tables</span>` : '';
    const rows = d.tables.length === 0
      ? `<div class="v2-empty">${ico('sol', 4)}<span>No private SOL tables are open right now.<br>Host one, or join a friend's table by code.</span></div>`
      : `<div class="${grid} v2-pthdr"><span>Blinds</span><span>Host</span><span>Seated</span><span>Who can join</span><span>Buy-in</span><span></span></div>${d.tables
          .map((r) => {
            const buyIn = chainMoney().buyIn.for(r.minBuyIn, r.maxBuyIn, r.bigBlind);
            const access = r.mine ? '<span class="v2-pill gold">Yours</span>' : r.inviteOnly ? (r.haveLink ? '<span class="v2-pill ok">Invited</span>' : '<span class="v2-pill">Invite-only</span>') : '<span class="v2-pill">Anyone</span>';
            return `<div class="${grid} v2-ptrow"><b class="v2-solamt">${ico('sol', 1)}<span class="v2-num">${esc(sol(r.smallBlind))} / ${esc(sol(r.bigBlind))}</span></b><span class="v2-ellip">${esc(r.mine ? 'You' : shortAddr(r.creator) || '—')}</span><span>${r.seated} / ${r.maxSeats}</span><span>${access}</span>${solAmt(buyIn)}${btn('Join', 'priv-join', { h: 'gold', c: 'sm', v: r.address, title: r.inviteOnly && !r.haveLink && !r.mine ? 'Invite-only: you can sit if the host invited your wallet' : undefined })}</div>`;
          })
          .join('')}`;
    body = `<div class="v2-scroll v2-col v2-priv-list">${notes}${hosted}${rows}</div>`;
  }
  const buyIn = `<div class="v2-row v2-wrap v2-priv-buy"><span class="v2-sm v2-mut">Your buy-in</span>${chips(chainMoney().buyIn.labels.map((l, i) => [String(i), l] as [string, string]), String(chainMoney().buyIn.choice), 'priv-buyin')}</div>`;
  return `<div class="v2-panel v2-col v2-priv" style="flex:1;min-height:0">
  <div class="v2-row v2-wrap v2-priv-top"><b class="v2-h v2-grow">Private SOL tables</b>${input('code', t.input?.code ?? '', 'Table code', { max: 44, cls: 'v2-priv-code' })}<button class="v2-b blue" data-a="priv-code" data-enter="code">Join by code</button>${d && !p.loading ? btn('Refresh', 'priv-refresh', { h: 'ghost' }) : ''}${btn(`${ico('plus', 1)} Host a table`, 'priv-host', { h: 'gold' })}</div>
  ${walletStrip()}
  ${buyIn}
  ${body}
  <div class="v2-xs v2-mut">Only you can see your cards, and every hand can be verified. SOL tables run on the Solana test network.</div>
</div>`;
}

/** Runs a hosted-table action with the progress dialog, then reads the lobby again. */
function hostedTask(v: string, title: string, fallback: string, op: (c: ChainService, h: HostedRow, st: (s: string) => void) => Promise<string | void | null>): void {
  const h = findHosted(v);
  if (!h) return;
  void solTask(title, fallback, async (st) => op(await chain(), h, st), reloadPrivate);
}

async function connectWallet(): Promise<boolean> {
  try {
    if (onchainApi.connectWallet) return await onchainApi.connectWallet();
    return await (await chain()).connectWallet();
  } catch (e) {
    ui().message('Connect a wallet', esc(solError(e, "Couldn't connect your wallet. Try again.")));
    return false;
  }
}

const privActions: Record<string, Action> = {
  'priv-refresh': () => reloadPrivate(),
  'priv-code': () => {
    const code = (tables.input?.code ?? '').trim();
    if (!code) return ui().message('Join by code', 'Enter the table code your friend shared.');
    void onchainApi.partyJoin?.(code);
  },
  'priv-host': () => {
    if (!signedIn()) return host().show('Login');
    tables.stayPriv = true;
    ui().show('sol-host');
  },
  'priv-connect': async () => {
    await connectWallet();
    reloadPrivate();
  },
  'priv-copy': () => {
    const a = walletNow();
    if (a) copy(a, 'Wallet address copied');
  },
  'priv-balance': () => void onchainApi.refreshSol?.(),
  'priv-deposit': () => void onchainApi.deposit?.(),
  'priv-withdraw': () => void onchainApi.withdraw?.(),
  'priv-more': () =>
    ui().openDialog({
      title: 'Your wallet',
      body: `<p>Each device you play SOL tables on keeps a key your wallet approved, so hands don't need a wallet prompt.</p><p style="margin-top:.6em">Lost a device, or played on a shared computer? Log out all devices. Each one then asks your wallet once before it plays again. Your game balance stays yours.</p>`,
      buttons: btn('Close', 'pm-close', { h: 'ghost' }) + btn('Log out all devices', 'pm-revoke', { h: 'red' }),
      actions: {
        'pm-close': () => ui().closeDialog(),
        'pm-revoke': () => {
          ui().closeDialog();
          void solTask('Log out all devices', "Couldn't log out your devices. Try again in a moment.", async (st) => {
            if (!(await connectWallet())) return null;
            await (await chain()).lobby.revokeSessions(st);
            return 'Done. Every device asks your wallet once before it plays SOL tables again.';
          }, reloadPrivate);
        },
      },
    }),
  'priv-buyin': (v) => {
    chainMoney().buyIn.choice = Number(v);
  },
  'priv-join': (v) => {
    const r = tables.priv.data?.tables.find((x) => x.address === v);
    if (!r) return;
    if (!signedIn()) return host().show('Login');
    const buyIn = chainMoney().buyIn.for(r.minBuyIn, r.maxBuyIn, r.bigBlind);
    void solTask('Join table', "Couldn't join the table. Try again in a moment.", async (st) => {
      await (await chain()).lobby.join(r.address, buyIn, st, { smallBlind: r.smallBlind, bigBlind: r.bigBlind, minBuyIn: r.minBuyIn, maxBuyIn: r.maxBuyIn });
    });
  },
  'h-join': (v) =>
    hostedTask(v, 'Join table', "Couldn't join the table. Try again in a moment.", async (c, h, st) => {
      await c.lobby.join(h.address, h.buyIn, st);
    }),
  'h-open': (v) => hostedTask(v, 'Open your table', "Couldn't open the table. Try again in a minute.", async (c, h, st) => void (await c.lobby.open(h, st))),
  'h-copy': (v) => {
    const link = findHosted(v)?.link;
    if (link) copy(link, 'Invite link copied');
  },
  'h-newlink': (v) =>
    hostedTask(v, 'New invite link', "Couldn't make a new link. Try again in a moment.", async (c, h, st) => {
      await c.lobby.newInviteLink(h, st);
      return 'Your new invite link is ready, and older links no longer work. Tap Copy invite link to share it.';
    }),
  'h-close': (v) =>
    ui().message('Close this table?', `Players can't join it after this. Its deposit (${ico('sol', 1)} about 0.013 SOL) can come back to your wallet a minute later.`, 'Close table', () =>
      hostedTask(v, 'Close your table', "Couldn't close the table. Try again in a moment.", async (c, h, st) => {
        await c.lobby.close(h, st);
        return 'Closed. In a minute, tap Get deposit back to take its deposit back.';
      }), 'Keep it', undefined, 'red'),
  'h-reclaim': (v) =>
    hostedTask(v, 'Get deposit back', "Couldn't get the deposit back yet. Try again in a minute.", async (c, h, st) => {
      await c.lobby.reclaim(h, st);
      return "The table's deposit is back in your wallet.";
    }),
  'h-oldlist': (v) =>
    hostedTask(v, 'Get deposit back', "Couldn't get the deposit back yet. Try again in a minute.", async (c, h, st) => {
      await c.lobby.closeOldInvites(h.id, st);
      return "The invite list's deposit is back in your wallet.";
    }),
};
/** The private tables tab: the lobby read (through the chain seam) and the wallet it was read for. */
interface PrivState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  data: LobbyRead | null;
  /** The wallet the data was read for (a wallet change reads again). */
  wallet: string | null;
}

const tables: ScreenDef & {
  theme: Theme;
  tab: 'pub' | 'priv';
  /** Come back to Private tables (after Host a SOL table). */
  stayPriv: boolean;
  priv: PrivState;
} = {
  id: 'tables',
  replaces: ['TableSelect_TownLobby'],
  theme: 'Town',
  tab: 'pub',
  stayPriv: false,
  priv: { loading: false, loaded: false, error: null, data: null, wallet: null },
  input: { code: '' },
  open(arg) {
    this.theme = StakeTableSkin.themeFor(host().stakes.resolve().minBuyIn);
    this.tab = arg === 'priv' || (arg === undefined && this.stayPriv) ? 'priv' : 'pub';
    this.stayPriv = false;
    this.priv.loaded = false;
    if (this.tab === 'priv' && onchain()) void loadPrivate(this);
  },
  render() {
    const chain = onchain();
    const tabsHtml = chain ? `<div class="v2-ts-tabs">${tabs([['pub', 'Public tables'], ['priv', 'Private tables']], this.tab, 'ts-tab')}</div>` : '';
    if (chain && this.tab === 'priv') return topBar('Tables') + `<div class="v2-body">${tabsHtml}${privatePanel(this)}</div>`;
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
    return topBar('Tables') + `<div class="v2-body">${tabsHtml}
<div class="v2-ts">
  <div class="v2-ts-left">
    <div class="v2-ts-preview" style="${bgArt(room.theme, room.color)}"><div class="v2-ts-felt"></div><div class="v2-ts-cap"><b>${room.name} room</b><div class="v2-sm v2-mut">Your table plays in this room</div></div></div>
    <div class="v2-ts-cards">${cards}</div>
  </div>
  <div class="v2-panel v2-col v2-ts-sel">
    <span class="v2-cap">Selected table</span>
    <b class="v2-h v2-ts-name">${room.name}</b>
    <div class="v2-kv"><span>Stakes</span><b>${chain ? `${esc(StakeCatalog.Tiers[level]?.displayName ?? solInfo?.label ?? '')} stakes (SOL)` : `${tier.displayName} stakes`}</b></div>
    <div class="v2-kv"><span>Blinds</span><b>${esc(chain ? solInfo?.blinds ?? '' : tier.blindsLabel)}</b></div>
    <div class="v2-kv"><span>Minimum buy-in</span><b>${esc(chain ? solInfo?.minBuyIn ?? '' : formatN0(tier.minBuyIn))}</b></div>
    <span class="v2-sm v2-mut" style="margin-top:.4em">Your buy-in</span>
    <div class="v2-row">${btn(ico('minus', 1), 'buy-step', { h: 'ghost', v: -1, title: 'Less' })}<div class="v2-field v2-grow v2-num v2-ts-buy">${esc(buyVal)}</div>${btn(ico('plus', 1), 'buy-step', { h: 'ghost', v: 1, title: 'More' })}</div>
    <div class="v2-row">${btn('Min', 'buy-end', { v: 'min', c: 'v2-grow' })}${btn('2×', 'buy-end', { v: 'double', c: 'v2-grow' })}${btn('Max', 'buy-end', { v: 'max', c: 'v2-grow' })}</div>
    ${!chain && !canSit ? `<div class="v2-xs v2-badc">You need ${formatN0(tier.minBuyIn)} Coins to sit here.</div>` : ''}
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
          body: `${esc(tier.displayName)} tables need ${formatN0(tier.minBuyIn)} Coins to sit. Pick a lower table. ${esc(getCoinsRoute().hint)}`,
          buttons: btn('Not now', 'nec-ok', { h: 'ghost' }) + btn(esc(getCoinsRoute().label), 'nec-get', { h: 'green' }),
          actions: { 'nec-get': () => { ui().closeDialog(); getCoinsRoute().go(); }, 'nec-ok': () => ui().closeDialog() },
        });
        return;
      }
      void joinFreePlay(h, tier, h.stakes.selectedBuyInChips, 'join');
    },
    ...privActions,
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
  },
  render() {
    const chain = onchain();
    return topBar('Play with friends') + `<div class="v2-body">
<div class="v2-party-sub v2-mut">${chain ? 'Private SOL tables with friends' : 'Private tables with friends'}</div>
<div class="v2-party">
  <div class="v2-panel v2-col v2-party-card">${ico('cards', 7)}<b class="v2-h">Create a party</b><div class="v2-mut">${chain ? 'Open a private SOL table and share its code.' : 'Start a private table and share the code.'}</div><div class="v2-grow"></div>${btn('Create a table', 'create', { h: 'gold', c: 'w' })}</div>
  <div class="v2-panel v2-col v2-party-card">${ico('friends', 7)}<b class="v2-h">Join a party</b><div class="v2-mut">Join a friend's table with their code.</div>${input('code', this.input?.code ?? '', 'Enter session code', { max: chain ? 44 : 12, cls: 'v2-party-code' })}<div class="v2-grow"></div><button class="v2-b blue w" data-a="join" data-enter="code">Join table</button></div>
  ${chain ? '' : `<div class="v2-panel v2-col v2-party-card">${ico('eye', 7)}<b class="v2-h">Watch a table</b><div class="v2-mut">Spectate live games: public tables, or a private one by its code.</div><div class="v2-grow"></div>${btn('Watch', 'watch', { h: 'violet', c: 'w' })}</div>`}
</div></div>`;
  },
  actions: {
    create: () => {
      if (!signedIn()) return host().show('Login');
      if (onchain()) return ui().show('sol-host');
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
    const st = chainMoney().stakes[this.stake]!;
    const blinds = chainMoney().stakes.map((s, i) => {
      const r = ROOMS[i] ?? ROOMS[0]!;
      const name = StakeCatalog.Tiers[i]?.displayName ?? s.label;
      return `<button class="v2-stc${i === this.stake ? ' on' : ''}"${act('sh-stake', i)}><div class="v2-stc-art v2-center" style="background:linear-gradient(${r.color},var(--v2-bg-top))">${ico('sol', 2)}</div><b>${esc(name)}</b><small>${sol(s.small)} / ${sol(s.big)}</small></button>`;
    }).join('');
    const seats: [string, string][] = [2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), String(n)]);
    const name = StakeCatalog.Tiers[this.stake]?.displayName ?? st.label;
    return topBar('Host a SOL table', { back: 'tables' }) + `<div class="v2-body"><div class="v2-sh">
  <div class="v2-panel v2-col v2-sh-form v2-scroll">
    <b class="v2-h">Blinds <span class="v2-sm v2-mut" style="font-family:var(--v2-ui)">buy-in 10 to 100 big blinds</span></b>
    <div class="v2-sh-blinds">${blinds}</div>
    <b class="v2-h">Seats</b><div class="v2-row v2-wrap">${chips(seats, String(this.seats), 'sh-seats', true)}</div>
    <b class="v2-h">Who can join</b><div class="v2-row v2-wrap">${chips([['anyone', 'Anyone'], ['link', 'Link only'], ['invite', 'Invite-only']], this.access, 'sh-access', true)}</div>
    ${this.access === 'invite' ? `<div class="v2-row">${input('wallet', this.input?.wallet ?? '', 'Invitee wallet address (up to 15)', { max: 44, cls: 'v2-grow' })}<button class="v2-b blue" data-a="sh-add" data-enter="wallet">${ico('plus', 0.9)} Add</button></div>
    <div class="v2-row v2-wrap v2-sm">${this.invitees.length ? this.invitees.map((w) => `<button class="v2-pill"${act('sh-del', w)} aria-label="Remove ${esc(w)}">${esc(w.slice(0, 4))}…${esc(w.slice(-3))} ${ico('close', 0.8)}</button>`).join('') : '<span class="v2-mut">Only you and wallets you add (plus the invite link) can sit.</span>'}</div>` : `<div class="v2-sm v2-mut">${this.access === 'link' ? 'Only people with the invite link can sit. You get the link in Your tables.' : 'Anyone can find and join this table.'}</div>`}
  </div>
  <div class="v2-panel v2-col v2-sh-sum">
    <b class="v2-h">Summary</b>
    <div class="v2-sh-felt v2-center"><span class="v2-pill">${esc(name)} ${sol(st.small)} / ${sol(st.big)} · ${this.seats} seats</span></div>
    <div class="v2-kv"><span>Buy-in</span><b>${sol(chainMoney().minBuyIn(this.stake))} – ${sol(chainMoney().maxBuyIn(this.stake))}</b></div>
    <div class="v2-kv"><span>Open cost</span><b>≈ ${ico('sol', 1)} 0.03 SOL</b></div>
    <div class="v2-kv"><span>Back on close</span><b>≈ ${ico('sol', 1)} 0.013 SOL</b></div>
    <div class="v2-kv"><span>Rake</span><b>5% of buy-ins</b></div>
    <div class="v2-kv"><span>Auto-close</span><b>6 h empty</b></div>
    <div class="v2-grow"></div>
    <div class="v2-xs v2-mut">You approve once in your wallet, then you're seated from your game balance.</div>
    ${btn(this.busy ? 'Creating…' : 'Create Table', 'sh-create', { h: 'gold', c: 'lg w', dis: this.busy })}
  </div>
</div></div>`;
  },
  actions: {
    'sh-stake': (v) => void (solHost.stake = Number(v)),
    'sh-seats': (v) => void (solHost.seats = Number(v)),
    'sh-access': (v) => void (solHost.access = v as Access),
    'sh-add': async () => {
      const w = (solHost.input?.wallet ?? '').trim();
      if (!w) return;
      if (!(await chain()).lobby.isAccount(w)) return ui().message('Invite a wallet', "That isn't a wallet address on this network.");
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
    ui().openDialog({ title: 'Host a SOL table', body: () => `<div class="v2-row" style="gap:.9em"><i class="v2-spin" aria-hidden="true"></i><span>${esc(status)}</span></div>`, buttons: btn('Hide', 'sh-hide', { h: 'ghost' }), actions: { 'sh-hide': () => ui().closeDialog() }, dismiss: false });
  dlg();
  try {
    const c = await chain();
    const invitees = solHost.access === 'invite' ? [...solHost.invitees] : [];
    await c.lobby.host({ stake: solHost.stake, seats: solHost.seats, inviteOnly: solHost.access !== 'anyone', invitees }, (s) => {
      status = s;
      ui().render();
    });
    ui().closeDialog();
  } catch (e) {
    ui().closeDialog();
    ui().message("Couldn't host", esc(solError(e, "The table couldn't be opened. Nothing was charged. Try again in a moment.")));
  } finally {
    solHost.busy = false;
    ui().render();
  }
}

export function playScreens(): ScreenDef[] {
  return [tables, party, solHost, watch, nearTablesScreen];
}
