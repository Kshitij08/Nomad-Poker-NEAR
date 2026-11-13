/**
 * Shop (new in Redesign v2). Browsing only: there is no purchase backend yet, so Buy shows the confirm step and then
 * says the Shop isn't open; nothing is granted and no Coins are spent. SHOP_CATALOG is the one place a backend
 * catalogue replaces.
 */
import { btn, esc, tabs } from '../core';
import { ico, coinStack } from '../icons';
import { ui, onchain, topBar, setMode } from '../ctx';
import type { ScreenDef } from '../install';
import './shop.css';

export type ShopCategory = 'featured' | 'coins' | 'xp' | 'themes' | 'skins' | 'agents';

export interface ShopItem {
  id: string;
  name: string;
  blurb: string;
  /** Demo price: real money for Coin packs ("$0.99"), else Coins ("2,000"). Empty = not sold in Demo. */
  demo: string;
  /** On-chain price in SOL ("◎ 0.005"). */
  sol: string;
  ribbon?: string;
  /** Art colour (themes, skins, agents) or coin-stack size (coins). */
  color?: string;
  stack?: number;
}

/** The catalogue (placeholder until a store backend exists). */
export const SHOP_CATALOG: Record<Exclude<ShopCategory, 'featured'>, ShopItem[]> & { bundle: ShopItem & { was: { demo: string; sol: string }; ends: string; lines: string[] } } = {
  coins: [
    { id: 'coins-5k', name: 'Pocket Pile', blurb: '5,000 Coins', demo: '$0.99', sol: '◎ 0.005', stack: 1 },
    { id: 'coins-25k', name: 'Big Stack', blurb: '25,000 Coins', demo: '$3.99', sol: '◎ 0.020', ribbon: 'HOT', stack: 2 },
    { id: 'coins-60k', name: 'Vault', blurb: '60,000 Coins', demo: '$7.99', sol: '◎ 0.040', stack: 3 },
    { id: 'coins-150k', name: 'Treasure', blurb: '150,000 Coins', demo: '$14.99', sol: '◎ 0.075', ribbon: 'BEST VALUE', stack: 4 },
  ],
  xp: [
    { id: 'xp-1h', name: 'XP Boost · 1 h', blurb: '2× XP for 1 hour', demo: '2,000', sol: '◎ 0.002' },
    { id: 'xp-24h', name: 'XP Boost · 24 h', blurb: '2× XP for 24 hours', demo: '12,000', sol: '◎ 0.010', ribbon: 'POPULAR' },
    { id: 'xp-pack', name: 'XP Pack', blurb: '+5,000 XP', demo: '8,000', sol: '◎ 0.006' },
    { id: 'xp-skip', name: 'Level Skip', blurb: '+1 level instantly', demo: '25,000', sol: '◎ 0.020' },
  ],
  themes: [
    { id: 'th-neon', name: 'Neon City', blurb: 'Table theme', demo: '15,000', sol: '◎ 0.012', ribbon: 'NEW', color: '#ff4fa3' },
    { id: 'th-desert', name: 'Desert Dusk', blurb: 'Table theme', demo: '12,000', sol: '◎ 0.010', color: '#d6a85c' },
    { id: 'th-forest', name: 'Enchanted Forest', blurb: 'Table theme', demo: '12,000', sol: '◎ 0.010', color: '#2e8b57' },
    { id: 'th-galaxy', name: 'Galaxy Castle', blurb: 'Table theme', demo: '20,000', sol: '◎ 0.015', ribbon: 'LIMITED', color: '#7b3ff2' },
  ],
  skins: [
    { id: 'sk-galaxy', name: 'Galaxy Deck', blurb: 'Card back + faces', demo: '10,000', sol: '◎ 0.008', color: '#5b2bd1' },
    { id: 'sk-gold', name: 'Royal Gold', blurb: 'Card back', demo: '8,000', sol: '◎ 0.006', ribbon: 'HOT', color: '#e8b54a' },
    { id: 'sk-neon', name: 'Neon Glow', blurb: 'Card back', demo: '8,000', sol: '◎ 0.006', color: '#14f1c5' },
    { id: 'sk-4c', name: 'Classic 4-Colour', blurb: 'Card faces', demo: '5,000', sol: '◎ 0.004', color: '#2f6bff' },
  ],
  agents: [
    { id: 'ag-guard', name: 'Guardian Agent', blurb: 'Careful · low risk', demo: '', sol: '◎ 0.25', color: '#22c468' },
    { id: 'ag-tact', name: 'Tactician Agent', blurb: 'Balanced · medium risk', demo: '', sol: '◎ 0.40', ribbon: 'POPULAR', color: '#2f6bff' },
    { id: 'ag-dare', name: 'Daredevil Agent', blurb: 'Bold · high risk', demo: '', sol: '◎ 0.40', color: '#ff4f7a' },
    { id: 'ag-slot', name: 'Extra Agent Slot', blurb: 'Run one more agent', demo: '', sol: '◎ 0.10', color: '#ffc21f' },
  ],
  bundle: {
    id: 'bundle-starter', name: 'Starter Bundle', blurb: '50,000 Coins', demo: '$4.99', sol: '◎ 0.050', ribbon: '−60%',
    was: { demo: '$12.49', sol: '◎ 0.125' }, ends: 'Limited time', lines: ['+ Neon City table theme', '+ 2× XP for 24 hours'],
  },
};

type Cat = Exclude<ShopCategory, 'featured'>;

function art(cat: Cat, it: ShopItem, i: number): string {
  if (cat === 'coins') return coinStack((it.stack ?? 1) + 1, 3.6);
  if (cat === 'xp') return `<div class="v2-sh-rel">${ico('xp', 7)}${i < 2 ? `<span class="v2-sh-bolt">${ico('bolt', 3.4)}</span>` : ''}</div>`;
  if (cat === 'themes') return `<div class="v2-sh-theme" style="--c:${it.color}"><i></i></div>`;
  if (cat === 'skins') return `<div class="v2-sh-skins">${[-16, 0, 16].map((r, j) => `<i style="left:${2.5 + j * 1.2}em;transform:rotate(${r}deg);--c:${it.color}"></i>`).join('')}</div>`;
  return `<div class="v2-sh-rel">${ico('robot', 7, `filter:drop-shadow(0 .3em .6em ${it.color})`)}</div>`;
}

/** Price label and whether it's money (green button) or Coins / SOL (gold). */
function price(cat: Cat | 'bundle', it: ShopItem): { label: string; hue: string } {
  if (onchain() || cat === 'agents') return { label: esc(it.sol), hue: 'gold' };
  if (cat === 'coins' || cat === 'bundle') return { label: esc(it.demo), hue: 'green' };
  return { label: `${ico('coin', 1.1)} ${esc(it.demo)}`, hue: 'gold' };
}

function itemCard(cat: Cat, it: ShopItem, i: number): string {
  const p = price(cat, it);
  return `<div class="v2-scard"><div class="v2-rays"></div>${it.ribbon ? `<span class="v2-ribbon">${esc(it.ribbon)}</span>` : ''}<div class="v2-sart">${art(cat, it, i)}</div><b class="v2-sname">${esc(it.name)}</b><small>${esc(it.blurb)}</small>${btn(p.label, 'buy', { h: p.hue, c: 'w', v: `${cat}:${it.id}` })}</div>`;
}

function find(key: string): { cat: Cat | 'bundle'; it: ShopItem } | null {
  const [cat, id] = key.split(':') as [Cat | 'bundle', string];
  if (cat === 'bundle') return { cat, it: SHOP_CATALOG.bundle };
  const it = SHOP_CATALOG[cat]?.find((x) => x.id === id);
  return it ? { cat, it } : null;
}

function artFor(cat: Cat | 'bundle', it: ShopItem): string {
  if (cat === 'bundle') return coinStack(4, 3);
  const list = SHOP_CATALOG[cat];
  return `<div class="v2-sh-mini">${art(cat, it, list.indexOf(it))}</div>`;
}

function buy(key: string): void {
  const f = find(key);
  if (!f) return;
  const { cat, it } = f;
  const p = price(cat, it);
  const chain = onchain();
  const how = chain ? `${esc(it.sol)} from your game balance` : cat === 'coins' || cat === 'bundle' ? `${esc(it.demo)} · charged by the app store` : `${esc(it.demo)} Coins`;
  ui().openDialog({
    title: `Buy ${esc(it.name)}`,
    body: `<div class="v2-row" style="gap:1.2em">${artFor(cat, it)}<div><b style="font-size:1.3em">${esc(it.blurb)}</b><div class="v2-mut">${how}</div></div></div>`,
    buttons: btn('Cancel', 'sb-cancel', { h: 'ghost' }) + btn(chain ? `Approve ${esc(it.sol)}` : `Buy ${p.label}`, 'sb-ok', { h: 'gold' }),
    actions: {
      'sb-cancel': () => ui().closeDialog(),
      'sb-ok': () =>
        ui().message('The Shop opens soon', `Purchases aren't available yet, so nothing was charged${chain ? ' and your wallet was not asked to sign' : ''}. ${esc(it.name)} will be here when the Shop opens.`, 'Back to Shop'),
    },
  });
}

const CATS: [ShopCategory, string, string][] = [
  ['featured', 'Featured', 'bag'],
  ['coins', 'Coins', 'coin'],
  ['xp', 'XP boosts', 'xp'],
  ['themes', 'Themes', 'palette'],
  ['skins', 'Card skins', 'cards'],
];

const shop: ScreenDef & { cat: ShopCategory } = {
  id: 'shop',
  cat: 'featured',
  open(arg) {
    this.cat = typeof arg === 'string' ? (arg as ShopCategory) : 'featured';
  },
  render() {
    const chain = onchain();
    const cats = chain ? [...CATS, ['agents', 'AI Agents', 'robot'] as [ShopCategory, string, string]] : CATS;
    const cat: ShopCategory = this.cat === 'agents' && !chain ? 'featured' : this.cat;
    let body: string;
    if (cat === 'featured') {
      const b = SHOP_CATALOG.bundle;
      const bp = price('bundle', b);
      const side = ([['coins', SHOP_CATALOG.coins[3]!], ['skins', SHOP_CATALOG.skins[1]!]] as [Cat, ShopItem][])
        .map(([c, it]) => {
          const p = price(c, it);
          return `<div class="v2-scard v2-scard-row"><div class="v2-rays"></div>${it.ribbon ? `<span class="v2-ribbon">${esc(it.ribbon)}</span>` : ''}<div class="v2-sart">${c === 'coins' ? coinStack(5, 3.2) : art(c, it, 0)}</div><div class="v2-col v2-grow" style="gap:.3em;align-items:flex-start"><b class="v2-sname">${esc(it.name)}</b><small>${esc(it.blurb)}</small>${btn(p.label, 'buy', { h: p.hue, v: `${c}:${it.id}` })}</div></div>`;
        }).join('');
      body = `<div class="v2-sh-feat">
  <div class="v2-scard v2-sfeat"><div class="v2-rays"></div><span class="v2-ribbon">${esc(b.ribbon!)}</span>
    <div class="v2-sfeat-in"><div class="v2-col v2-sfeat-art">${coinStack(5, 4)}<div class="v2-row">${ico('xp', 4)}${ico('palette', 4)}</div></div>
    <div class="v2-col v2-sfeat-txt"><span class="v2-pill gold" style="width:max-content">Starter bundle</span><b class="v2-sfeat-big">${esc(b.blurb)}</b><span class="v2-sfeat-lines">${b.lines.map(esc).join('<br>')}</span><span class="v2-mut"><s>${esc(chain ? b.was.sol : b.was.demo)}</s></span>${btn(bp.label, 'buy', { h: 'gold', c: 'lg', v: 'bundle:' + b.id })}</div></div>
    <small class="v2-mut">${esc(b.ends)}</small></div>
  <div class="v2-col v2-sh-side">${side}</div>
</div>`;
    } else {
      const list = SHOP_CATALOG[cat];
      body = `<div class="v2-sh-grid">${list.map((it, i) => itemCard(cat, it, i)).join('')}</div>`;
    }
    return `${topBar('Shop')}
<div class="v2-sh-tabs">${tabs(cats.map(([k, l, i]) => [k, l, i]), cat, 'cat')}</div>
<div class="v2-body v2-scroll v2-sh-body">${body}</div>`;
  },
  actions: {
    cat: (v) => {
      shop.cat = v as ShopCategory;
    },
    buy: (v) => buy(v),
    mode: (v) => setMode(v),
  },
};

export function shopScreens(): ScreenDef[] {
  return [shop];
}
