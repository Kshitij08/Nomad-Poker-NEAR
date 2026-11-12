/**
 * Main menu "rooms" (replaces the TABLES / QUICK PLAY / PARTY tiles). The centre of the menu is the room you'd play
 * in: swipe (or ‹ ›, arrow keys, dots) through Solana → Neon City (it wraps round); the room sets the stake. The
 * card's own bar carries the actions: "Sit down" is Quick Play at that room's stake, "With friends" opens Party.
 */
import { StakeTableSkin, type Theme } from '../../menu/stakes';
import { joinFreePlay } from '../../menu/screens/mainMenu';
import { formatN0, type StakeTier } from '@nomad/engine';
import { esc, act, btn } from '../core';
import { ico } from '../icons';
import { ui, host, S, onchain, onchainApi, signedIn, needCoins } from '../ctx';
import { ROOMS, bgArt, levelOf } from './play';
import './rooms.css';

export const rooms = { theme: 'Town' as Theme, animate: false };

/** Picks up the player's current stake when the menu opens. */
export function syncRoom(): void {
  const stakes = host().stakes;
  rooms.theme = StakeTableSkin.themeFor(stakes.resolve().minBuyIn);
  // The fixed buy-in replaces any amount picked earlier on Choose your table.
  const tier = roomTier(rooms.theme);
  stakes.selectedMinBuyIn = tier.minBuyIn;
  stakes.selectedBuyInChips = tier.startingStack;
}

/**
 * A room's stake. Every player sits with the same fixed buy-in, the stake's standard stack (100 big blinds in most
 * rooms): the room plays its highest stake whose stack you can cover, else its entry stake (locked until you can).
 */
export function roomTier(theme: Theme): StakeTier {
  const list = StakeTableSkin.stakesFor(theme);
  const coins = host().stakes.coins;
  let pick = list[0]!;
  for (const t of list) if (coins >= t.startingStack) pick = t;
  return pick;
}

function select(theme: Theme): void {
  if (theme === rooms.theme) return;
  rooms.theme = theme;
  rooms.animate = true;
  // The table theme and stake follow the room (like Choose your table), with the fixed buy-in.
  S('theme')?.setTheme?.(theme);
  const tier = roomTier(theme);
  const stakes = host().stakes;
  stakes.selectedMinBuyIn = tier.minBuyIn;
  stakes.selectedBuyInChips = tier.startingStack;
}

export function step(dir: number): void {
  const i = levelOf(rooms.theme);
  const n = (i + dir + ROOMS.length) % ROOMS.length;
  select(ROOMS[n]!.theme);
}

function peek(i: number, side: 'prev' | 'next'): string {
  const r = ROOMS[(i + ROOMS.length) % ROOMS.length]!;
  return `<button class="v2-rm-peek ${side}" style="${bgArt(r.theme, r.color)}"${act('room-step', side === 'prev' ? -1 : 1)} aria-label="${esc(r.name)} room"><b>${esc(r.name)}</b></button>`;
}

/** The room stage markup for the main menu. */
export function roomStage(): string {
  const chain = onchain();
  const i = levelOf(rooms.theme);
  const r = ROOMS[i]!;
  const stakes = host().stakes;
  const tier = roomTier(rooms.theme);
  const sol = chain ? onchainApi.tableStakes?.(i) : null;
  const locked = !chain && stakes.coins < tier.startingStack;
  const stakeLine = chain ? `${esc(sol?.label.split(' ')[0] ?? tier.displayName)} stakes · ${esc(sol?.blinds ?? '')}` : `${esc(tier.displayName)} stakes · ${esc(tier.blindsLabel)}`;
  // One fixed buy-in per room, the same for every player.
  const buyLine = chain
    ? `Buy-in ${esc(sol?.minBuyIn ?? '')} · on-chain (devnet)`
    : locked
      ? `Buy-in ${formatN0(tier.startingStack)} Coins · you have ${formatN0(stakes.coins)}`
      : `Buy-in ${formatN0(tier.startingStack)} Coins`;
  const enter = rooms.animate ? ' in' : '';
  rooms.animate = false;
  const dots = ROOMS.map((x, j) => `<button class="v2-rm-dot${j === i ? ' on' : ''}"${act('room-pick', x.theme)} aria-label="${esc(x.name)}"></button>`).join('');
  return `<section class="v2-rooms" aria-roledescription="carousel" aria-label="Rooms">
  <div class="v2-rm-stage">
    ${peek(i - 1, 'prev')}
    <div class="v2-rm-card${locked ? ' locked' : ''}${enter}" style="${bgArt(r.theme, r.color)}">
      ${locked ? `<span class="v2-rm-lock">${ico('lock', 1.4)} Locked</span>` : ''}
      <button class="v2-rm-arrow prev"${act('room-step', -1)} aria-label="Previous room">${ico('back', 1.2)}</button>
      <button class="v2-rm-arrow next"${act('room-step', 1)} aria-label="Next room">${ico('back', 1.2, 'transform:scaleX(-1)')}</button>
      <div class="v2-rm-bar">
        <div class="v2-rm-info" aria-live="polite"><b class="v2-rm-name">${esc(r.name)}</b><span class="v2-rm-stake">${stakeLine}</span><span class="v2-rm-buy">${buyLine}</span></div>
        <div class="v2-rm-actions">
          ${locked ? btn(`GET COINS <span class="v2-rm-arr">›</span>`, 'go', { h: 'green', c: 'lg v2-rm-sit', v: 'shop:coins' }) : btn(`SIT DOWN <span class="v2-rm-arr">›</span>`, 'room-sit', { h: 'gold', c: 'lg v2-rm-sit' })}
          ${btn(`${ico('friends', 1.3)} With friends`, 'room-friends', { h: 'violet', c: 'v2-rm-friends' })}
        </div>
      </div>
    </div>
    ${peek(i + 1, 'next')}
  </div>
  <div class="v2-rm-dots">${dots}</div>
</section>`;
}

export const roomActions = {
  'room-step': (v: string) => step(Number(v)),
  'room-pick': (v: string) => select(v as Theme),
  'room-friends': () => host().show('PartyMenu'),
  'room-sit': () => {
    const h = host();
    if (!signedIn()) return h.show('Login');
    const i = levelOf(rooms.theme);
    if (onchain()) return void onchainApi.quickPlay?.(i);
    const tier = roomTier(rooms.theme);
    if (needCoins(tier.startingStack, `The ${ROOMS[i]!.name} room`)) return;
    void joinFreePlay(h, tier, tier.startingStack, 'quick');
  },
};

/** Swipe on the stage and ←/→ keys on the main menu change the room. */
export function installRoomGestures(): void {
  const el = ui().el;
  let x0 = 0;
  let y0 = 0;
  let tracking = false;
  let swallowClick = false;
  let mouse = false;
  el.addEventListener('pointerdown', (e) => {
    swallowClick = false;
    if (ui().currentId !== 'main' || !(e.target as HTMLElement).closest('.v2-rm-stage')) return;
    tracking = true;
    mouse = e.pointerType === 'mouse';
    x0 = e.clientX;
    y0 = e.clientY;
  });
  el.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      step(dx < 0 ? 1 : -1);
      // Only a mouse drag fires a click afterwards; a touch swipe doesn't, so nothing to swallow.
      if (mouse) {
        swallowClick = true;
        window.setTimeout(() => (swallowClick = false), 400);
      }
      ui().render();
    }
  });
  el.addEventListener('pointercancel', () => (tracking = false));
  // A swipe that ends on a button must not also press it.
  el.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (ui().currentId !== 'main' || ui().hasDialog || el.hidden || el.querySelector('.v2-profile')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    step(e.key === 'ArrowRight' ? 1 : -1);
    ui().render();
    e.preventDefault();
  });
}
