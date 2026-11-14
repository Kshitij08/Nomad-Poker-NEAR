/**
 * Shop (Phase 3). The Nomad API owns the catalogue, prices and effects (packages/contract SHOP_ITEMS, sold by
 * packages/db/src/shop.ts); this screen shows it (the server's copy when online) and buys through ShopClient.
 *
 *   - Demo: XP items and card backs for Coins (a ledger debit on the server).
 *   - On-chain: the same items for devnet SOL (a wallet transfer the server checks on chain), plus Coins (chip) packs
 *     for SOL, credited to the Coins balance.
 *   - Demo's Coin packs are real-money items: "Coming soon" until an app-store / Stripe account exists.
 * Room themes aren't sold (they'd change the room backgrounds). Card backs are worn at every table once owned; without
 * one, every table shows the free Nomad back ("Default · Free").
 */
import { SHOP_ITEMS, type ShopItemInfo } from '@nomad/contract';
import { shopClient, type ShopError } from '../../economy/shopClient';
import { cardBackPreview, equipCardBack, equippedCardBack } from '../../theming/cardBack';
import type { ThemeId } from '../../theming/themeData';
import { btn, esc, tabs } from '../core';
import { ico, coinStack, ui2Art } from '../icons';
import { ui, app, host, onchain, onchainApi, topBar, setMode, sfx } from '../ctx';
import { PokerSound } from '@nomad/engine';
import type { ScreenDef } from '../install';
import './shop.css';
import './shopPurchase.css';

export type ShopCategory = 'featured' | 'coins' | 'xp' | 'skins';

/** Demo's real-money items: shown, not sold yet (no app-store / Stripe account). On-chain sells server packs for SOL. */
const COIN_PACKS: { id: string; name: string; blurb: string; demo: string; ribbon?: string; stack: number }[] = [
  { id: 'coins-5k', name: 'Pocket pile', blurb: '5,000 Coins', demo: '$0.99', stack: 1 },
  { id: 'coins-25k', name: 'Big stack', blurb: '25,000 Coins', demo: '$3.99', ribbon: 'HOT', stack: 2 },
  { id: 'coins-60k', name: 'Vault', blurb: '60,000 Coins', demo: '$7.99', stack: 3 },
  { id: 'coins-150k', name: 'Treasure', blurb: '150,000 Coins', demo: '$14.99', ribbon: 'BEST VALUE', stack: 4 },
];

const fmtCoins = (n: number) => n.toLocaleString('en-US');
const fmtSol = (lamports: number) => `${(lamports / 1e9).toFixed(lamports % 1_000_000 === 0 ? 3 : 4).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
/** A SOL price with the SOL icon (like Coins prices carry the coin), for buttons. */
const solPrice = (lamports: number) => `${ico('sol', 1.1)} ${esc(fmtSol(lamports))}`;

const items = (): ShopItemInfo[] => shopClient(app()).catalog?.items ?? [...SHOP_ITEMS];
const byCat = (cat: 'xp' | 'skins' | 'coins') => items().filter((i) => i.category === cat);
const deckTheme = (it: ShopItemInfo): ThemeId | null => (it.effect.kind === 'card_back' ? (it.effect.theme as ThemeId) : null);

/** Shop item art (public/assets/ui2/shop/), by item id: the catalogue's XP items and Coins packs, and the demo packs. */
const SHOP_ART: Record<string, string> = {
  'xp-boost-1h': 'shop_xp_boost_1h',
  'xp-boost-24h': 'shop_xp_boost_24h',
  'xp-pack': 'shop_xp_pack',
  'xp-level': 'shop_level_up',
  'coins-5k': 'shop_coins_5k',
  'coins-25k': 'shop_coins_25k',
  'coins-60k': 'shop_coins_60k',
  'coins-150k': 'shop_coins_150k',
};

/** The item's picture, or null when it has none (an id the server added later). */
/**
 * Each item's colour: the halo behind its art and the tint of its card's rim. Coins are gold, XP items pink / violet,
 * card backs their room's colour.
 */
const DECK_GLOW: Partial<Record<string, string>> = { Default: '#a46bff', Forest: '#3fd38a', Town: '#ffa94a', Desert: '#ffc861', Neon_City: '#ff4fa3', free: '#7fb2ff' };
function glowOf(it: { id: string; effect?: ShopItemInfo['effect'] }): string {
  const e = it.effect;
  if (e?.kind === 'card_back') return DECK_GLOW[String(e.theme)] ?? '#b69bff';
  if (e?.kind === 'coins' || it.id.startsWith('coins-')) return '#ffd54a';
  if (e?.kind === 'xp_boost') return '#ff7ad9';
  return '#c18bff';
}

/** The card's clipped layer: the background art and the corner ribbon (the card itself lets its art break out). */
const cardBg = (ribbon = ''): string => `<div class="v2-sclip"><div class="v2-sbg"></div>${ribbon}</div>`;

/** The item's art over its halo. */
const artBox = (inner: string, cls = 'v2-sart'): string => `<div class="${cls}"><i class="v2-shalo" aria-hidden="true"></i><div class="v2-sart-in">${inner}</div></div>`;

function shopArt(id: string): string | null {
  const file = SHOP_ART[id];
  return file ? `<img class="v2-ico v2-sh-art" src="${ui2Art(`shop/${file}`)}" alt="" draggable="false" decoding="async" style="width:7.5em;height:7.5em">` : null;
}

function art(it: ShopItemInfo): string {
  const t = deckTheme(it);
  if (t) {
    const src = cardBackPreview(t);
    return `<div class="v2-sh-deck">${[-14, 0, 14].map((r) => `<span style="transform:rotate(${r}deg)">${src ? `<img src="${esc(src)}" alt="" draggable="false">` : ''}</span>`).join('')}</div>`;
  }
  const pic = shopArt(it.id);
  if (pic) return pic;
  if (it.effect.kind === 'coins') {
    const n = it.effect.amount;
    return coinStack(n >= 150_000 ? 5 : n >= 60_000 ? 4 : n >= 25_000 ? 3 : 2, 3.6);
  }
  const bolt = it.effect.kind === 'xp_boost';
  return `<div class="v2-sh-rel">${ico('xp', 7)}${bolt ? `<span class="v2-sh-bolt">${ico('bolt', 3.4)}</span>` : ''}</div>`;
}

/** The buy button: price, or Owned / Wear / Wearing for card backs, or Coming soon. */
function action(it: ShopItemInfo, wide = true): string {
  const c = shopClient(app());
  const t = deckTheme(it);
  if (t && c.owns(it.id)) {
    const wearing = equippedCardBack() === t;
    return btn(wearing ? `${ico('check', 1.1)} Wearing` : 'Wear at tables', wearing ? 'unwear' : 'wear', { h: wearing ? 'ghost' : 'blue', c: wide ? 'w' : '', v: t });
  }
  const chain = onchain();
  const price = chain ? it.priceLamports : it.priceCoins;
  if (price === null) return btn('Not sold here', 'noop', { h: 'ghost', c: `${wide ? 'w ' : ''}dis`, dis: true });
  const label = chain ? solPrice(price) : `${ico('coin', 1.1)} ${fmtCoins(price)}`;
  return btn(label, 'buy', { h: 'gold', c: `v2-sh-buy${wide ? ' w' : ''}`, v: it.id });
}

/** The item's subtitle; Coins packs always say Coins (an older server copy said "Chips"). */
const blurbOf = (it: ShopItemInfo): string => (it.effect.kind === 'coins' ? 'Coins added to your balance' : it.blurb);

function card(it: ShopItemInfo): string {
  const owned = shopClient(app()).owns(it.id);
  return `<div class="v2-scard${owned ? ' v2-sh-owned' : ''}" style="--glow:${glowOf(it)}">${cardBg(owned ? '<span class="v2-ribbon v2-sh-ownedtag">OWNED</span>' : it.ribbon ? `<span class="v2-ribbon">${esc(it.ribbon)}</span>` : '')}${artBox(art(it))}<b class="v2-sname">${esc(it.name)}</b><small>${esc(blurbOf(it))}</small>${action(it)}</div>`;
}

/** The free Nomad back every player has: worn whenever no owned deck is. */
function freeDeckCard(): string {
  const wearing = !equippedCardBack();
  const src = cardBackPreview('free');
  const deck = `<div class="v2-sh-deck">${[-14, 0, 14].map((r) => `<span style="transform:rotate(${r}deg)">${src ? `<img src="${esc(src)}" alt="" draggable="false">` : ''}</span>`).join('')}</div>`;
  return `<div class="v2-scard" style="--glow:${DECK_GLOW.free}">${cardBg('<span class="v2-ribbon v2-sh-ownedtag">FREE</span>')}${artBox(deck)}<b class="v2-sname">Nomad deck</b><small>Default · Free</small>${btn(wearing ? `${ico('check', 1.1)} Wearing` : 'Wear at tables', wearing ? 'noop' : 'unwear', { h: wearing ? 'ghost' : 'blue', c: 'w v2-sh-buy' })}</div>`;
}

function packCard(p: (typeof COIN_PACKS)[number]): string {
  return `<div class="v2-scard" style="--glow:${glowOf(p)}">${cardBg(p.ribbon ? `<span class="v2-ribbon">${esc(p.ribbon)}</span>` : '')}${artBox(shopArt(p.id) ?? coinStack(p.stack + 1, 3.6))}<b class="v2-sname">${esc(p.name)}</b><small>${esc(p.blurb)} · ${esc(p.demo)}</small>${btn('Coming soon', 'soon', { h: 'ghost', c: 'w v2-sh-buy v2-sh-soon' })}</div>`;
}

function boostNote(): string {
  const until = shopClient(app()).catalog?.xpBoostUntil;
  if (!until) return '';
  const left = new Date(until).getTime() - Date.now();
  if (left <= 0) return '';
  const h = Math.floor(left / 3_600_000);
  const m = Math.ceil((left % 3_600_000) / 60_000);
  return `<div class="v2-sh-note">${ico('bolt', 1.4)}<span>2× XP is on · ends in ${h ? `${h}h ` : ''}${m}m</span></div>`;
}

function notice(): string {
  const c = shopClient(app());
  if (!c.hasServer) return `<div class="v2-sh-note v2-sh-offline">${ico('lock', 1.4)}<span>This version plays offline, so the Shop is for browsing only.</span></div>`;
  if (!c.online) return `<div class="v2-sh-note v2-sh-offline">${ico('lock', 1.4)}<span>Sign in to buy. You can still look around.</span>${btn('Sign in', 'signin', { h: 'blue', c: 'sm' })}</div>`;
  if (onchain() && c.catalog && !c.catalog.solEnabled) return `<div class="v2-sh-note v2-sh-offline">${ico('sol', 1.4)}<span>SOL purchases aren't open right now. Switch to Demo to buy with Coins.</span></div>`;
  return boostNote();
}

const CATS: [ShopCategory, string, string][] = [
  ['featured', 'Featured', 'bag'],
  ['xp', 'XP boosts', 'xp'],
  ['skins', 'Card skins', 'cards'],
  ['coins', 'Coins', 'coin'],
];

const shop: ScreenDef & { cat: ShopCategory; busy: string | null } = {
  id: 'shop',
  cat: 'featured',
  busy: null,
  open(arg) {
    this.cat = typeof arg === 'string' && CATS.some(([k]) => k === arg) ? (arg as ShopCategory) : 'featured';
    // Fresh ownership and boost on every visit (one request at a time; render() only loads a missing catalogue).
    shopClient(app()).ensure(() => ui().render(), true);
  },
  render() {
    const cat = this.cat;
    // The session can finish restoring after the Shop opened: fetch the catalogue (ownership, prices) then.
    shopClient(app()).ensure(() => ui().render());
    let body: string;
    if (cat === 'featured') {
      const hero = items().find((i) => i.id === 'xp-boost-24h') ?? byCat('xp')[0]!;
      const side = [items().find((i) => i.id === 'deck:Neon_City'), items().find((i) => i.id === 'xp-pack')].filter(Boolean) as ShopItemInfo[];
      body = `<div class="v2-sh-feat">
  <div class="v2-scard v2-sfeat" style="--glow:${glowOf(hero)}">${cardBg(hero.ribbon ? `<span class="v2-ribbon">${esc(hero.ribbon)}</span>` : '')}
    <div class="v2-sfeat-in">${artBox(art(hero), 'v2-sart v2-sfeat-art')}
    <div class="v2-col v2-sfeat-txt"><span class="v2-pill gold" style="width:max-content">Double XP</span><b class="v2-sfeat-big">${esc(hero.name)}</b><span class="v2-sfeat-lines">${esc(hero.blurb)}.<br>Stacks with a running boost.</span>${action(hero, false)}</div></div></div>
  <div class="v2-col v2-sh-side">${side.map((it) => `<div class="v2-scard v2-scard-row" style="--glow:${glowOf(it)}">${cardBg()}${artBox(art(it))}<div class="v2-col v2-grow" style="gap:.3em;align-items:flex-start"><b class="v2-sname">${esc(it.name)}</b><small>${esc(it.blurb)}</small>${action(it, false)}</div></div>`).join('')}</div>
</div>`;
    } else if (cat === 'coins') {
      // One state at a time: the notice above already says when buying isn't possible (offline / signed out).
      const canSell = shopClient(app()).hasServer && shopClient(app()).online;
      body = onchain()
        ? `${canSell ? `<div class="v2-sh-note">${ico('sol', 1.4)}<span>Buy Coins with SOL on the Solana test network. They go straight to your Coins balance.</span></div>` : ''}<div class="v2-sh-grid">${byCat('coins').map(card).join('')}</div>`
        : `<div class="v2-sh-note">${ico('coin', 1.4)}<span>Coin packs open soon. Switch to On-chain to buy Coins with SOL, or claim the Daily spin and Weekly rewards for free Coins.</span></div><div class="v2-sh-grid">${COIN_PACKS.map(packCard).join('')}</div>`;
    } else if (cat === 'skins') {
      body = `<div class="v2-sh-grid">${freeDeckCard()}${byCat('skins').map(card).join('')}</div>`;
    } else {
      body = `<div class="v2-sh-grid">${byCat(cat).map(card).join('')}</div>`;
    }
    return `${topBar('Shop')}
<div class="v2-sh-tabs">${tabs(CATS.map(([k, l]) => [k, l]), cat, 'cat')}</div>
<div class="v2-body v2-scroll v2-sh-body">${notice()}${body}</div>`;
  },
  actions: {
    cat: (v) => {
      shop.cat = v as ShopCategory;
    },
    buy: (v) => confirmBuy(v),
    wear: (v) => {
      equipCardBack(v as ThemeId);
      ui().toast('Now on your cards at every table');
    },
    unwear: () => {
      equipCardBack(null);
      ui().toast('Back to the free Nomad cards');
    },
    soon: () => ui().toast('Coin packs open soon'),
    signin: () => host().show('Login'),
    noop: () => undefined,
    mode: (v) => setMode(v),
  },
};

function confirmBuy(id: string): void {
  const c = shopClient(app());
  const it = items().find((x) => x.id === id);
  if (!it) return;
  if (!c.hasServer) return ui().message('Browsing only', 'This version plays offline, so nothing can be bought here.');
  if (!c.online) return ui().message('Sign in to buy', 'Sign in (a guest account works) and your purchase is one tap away.', 'Sign in', () => host().show('Login'), 'Not now');
  const chain = onchain();
  const price = chain ? it.priceLamports : it.priceCoins;
  if (price === null) return;
  if (chain && c.catalog && !c.catalog.solEnabled) return ui().message('SOL purchases are closed', "SOL purchases aren't open right now. Switch to Demo to buy with Coins.");
  if (chain && !onchainApi.walletAddress?.()) {
    ui().message('Connect a wallet to buy', 'SOL purchases are paid from your Solana wallet (on the test network). Connect one, then tap Buy again.', 'Connect wallet', () => {
      void onchainApi.connectWallet?.().then(() => ui().render());
    }, 'Not now');
    return;
  }
  const how = chain ? `${fmtSol(price)} on the Solana test network, paid from your wallet` : `${fmtCoins(price)} Coins from your balance`;
  ui().openDialog({
    title: `Buy ${esc(it.name)}`,
    body: `<div class="v2-row" style="gap:1.2em"><div class="v2-sh-mini">${art(it)}</div><div><b style="font-size:1.2em">${esc(blurbOf(it))}</b><div class="v2-mut">${esc(how)}</div></div></div>`,
    buttons: btn('Cancel', 'sb-cancel', { h: 'ghost' }) + btn(chain ? `Pay ${solPrice(price)}` : `Buy for ${ico('coin', 1.1)} ${fmtCoins(price)}`, 'sb-ok', { h: 'gold' }),
    actions: {
      'sb-cancel': () => ui().closeDialog(),
      'sb-ok': () => {
        ui().closeDialog();
        void runBuy(it, chain);
      },
    },
  });
}

async function runBuy(it: ShopItemInfo, chain: boolean): Promise<void> {
  const c = shopClient(app());
  // The busy dialog gets the guide's ghost "Hide": the purchase carries on, and its result still shows when it lands.
  let hidden = false;
  const busy = (text: string) => {
    if (hidden) return;
    ui().openDialog({
      title: `Buying ${esc(it.name)}`,
      body: `<div class="v2-row" style="gap:.9em"><i class="v2-spin" aria-hidden="true"></i><span>${esc(text)}</span></div>`,
      buttons: btn('Hide', 'sh-hide', { h: 'ghost' }),
      actions: { 'sh-hide': () => { hidden = true; ui().closeDialog(); } },
      dismiss: false,
    });
  };
  busy(chain ? 'Getting a price…' : 'Buying…');
  try {
    const r = chain ? await c.buyWithSol(it.id, busy) : await c.buyWithCoins(it.id);
    if (!hidden) ui().closeDialog();
    sfx(PokerSound.ChipsToWinner);
    const t = deckTheme(it);
    if (t) {
      equipCardBack(t);
      ui().toast(`${it.name} bought · now on your cards at every table`, 2600);
    } else if (it.effect.kind === 'coins') ui().toast(`${fmtCoins(it.effect.amount)} Coins added to your balance`, 2600);
    else if (it.effect.kind === 'xp_boost') ui().toast(`2× XP is on for ${it.effect.hours === 1 ? '1 hour' : `${it.effect.hours} hours`}`, 2600);
    else ui().toast(`${it.name} bought${r.levelsPaid.length ? ` · level ${Math.max(...r.levelsPaid)}!` : ''}`, 2600);
  } catch (e) {
    if (!hidden) ui().closeDialog();
    const err = e as ShopError;
    if (err.code === 'insufficient_funds')
      ui().message('Not enough Coins', `${esc(it.name)} costs ${fmtCoins(it.priceCoins ?? 0)} Coins. Claim today's Daily spin and Weekly reward for more.`);
    else if (err.code === 'declined') ui().message('Payment cancelled', esc(err.message));
    else if (err.signature) {
      // After the transfer was sent: never say "nothing was charged". Show the transaction on the devnet explorer.
      const url = `https://explorer.solana.com/tx/${encodeURIComponent(err.signature)}?cluster=devnet`;
      ui().message(
        err.code === 'unconfirmed' ? 'Payment sent' : 'Payment failed',
        `${esc(err.message)}<div class="v2-sh-sig"><a href="${esc(url)}" target="_blank" rel="noopener">View the transaction</a><code>${esc(err.signature.slice(0, 10))}…${esc(err.signature.slice(-6))}</code></div>`,
      );
    } else if (chain) ui().message("That didn't go through", `${esc(err.message || 'Something went wrong.')} No SOL left your wallet.`);
    else ui().message("That didn't go through", `${esc(err.message || 'Something went wrong.')} No Coins were spent.`);
  }
  ui().render();
}

export function shopScreens(): ScreenDef[] {
  // A SOL payment that was sent earlier but confirmed only now (retried when the Shop loads).
  app().events.on('shop:credited', (p: unknown) => {
    const it = items().find((x) => x.id === (p as { itemId?: string })?.itemId);
    ui().toast(`${it?.name ?? 'Your purchase'} came through`, 2600);
    ui().render();
  });
  return [shop];
}
