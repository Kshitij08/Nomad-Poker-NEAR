/**
 * Main menu "rooms" (replaces the TABLES / QUICK PLAY / PARTY tiles). The centre of the menu is the room you'd play
 * in: swipe (or ‹ ›, arrow keys, dots) through Nomad → Neon City (it wraps round); the room sets the stake. The
 * card's own bar carries the actions: "Sit down" is Quick Play at that room's stake, "With friends" opens Party.
 */
import { StakeTableSkin, type Theme } from '../../menu/stakes';
import { joinFreePlay } from '../../menu/play';
import { formatN0, type StakeTier } from '@nomad/engine';
import { esc, act, btn } from '../core';
import { ico } from '../icons';
import { ui, host, S, onchain, signedIn, needCoins } from '../ctx';
import { HOUSE_TABLES, type HouseTable } from '../../near/escrow';
import { formatNear } from '../../near/backing';
import { ROOMS, bgArt, levelOf, roomArt } from './play';
import './rooms.css';

/** The room on show. */
export const rooms = { theme: 'Town' as Theme };
const SLIDE_MS = 340;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Carousel motion, run on the DOM rather than in the markup. A room change re-renders the stage; the markup carries no
 * motion classes, so a re-render once the slide is over produces the same HTML and core leaves the nodes alone (no
 * swap at the end). The slide itself is attached after each render (`v2:rendered`, core.ts): `.in` + data-dir on the
 * stage and the outgoing card (a snapshot, `ghost`) laid back in. Every animation runs off one clock (`start`) through
 * a negative delay (--rm-delay), so a render mid-slide (the menu's coin tick, the theme change) that replaces the stage
 * picks the motion up where it was instead of restarting it: one continuous motion.
 */
interface Motion { dir: number; start: number; ghost: HTMLElement | null; timer: number }
let motion: Motion | null = null;

/** A snapshot of the room card on show (same box, same mid-slide transform / opacity when the player clicks quickly). */
function snapshot(): HTMLElement | null {
  const stage = ui().el.querySelector<HTMLElement>('.v2-rm-stage');
  const card = stage?.querySelector<HTMLElement>('.v2-rm-card:not(.v2-rm-ghost)');
  if (!stage || !card) return null;
  const cs = getComputedStyle(card);
  const g = card.cloneNode(true) as HTMLElement;
  g.classList.add('v2-rm-ghost');
  g.setAttribute('aria-hidden', 'true');
  g.setAttribute('inert', '');
  for (const n of g.querySelectorAll('[data-a]')) n.removeAttribute('data-a');
  for (const n of g.querySelectorAll('[aria-live]')) n.removeAttribute('aria-live');
  // The card's layout box in the stage (its offset parent); the transform in flight is carried by --g-t.
  g.style.cssText += `;left:${card.offsetLeft}px;top:${card.offsetTop}px;width:${card.offsetWidth}px;height:${card.offsetHeight}px;--g-t:${cs.transform === 'none' ? 'none' : cs.transform};--g-o:${cs.opacity}`;
  return g;
}

function startMotion(dir: number): void {
  if (motion) endMotion();
  if (reducedMotion()) return;
  motion = { dir, start: performance.now(), ghost: snapshot(), timer: 0 };
  const m = motion;
  m.timer = window.setTimeout(() => motion === m && endMotion(), SLIDE_MS + 40);
}

function endMotion(): void {
  if (!motion) return;
  window.clearTimeout(motion.timer);
  motion.ghost?.remove();
  motion = null;
  // Fill mode `both` holds the end state, which is the card's resting state, so dropping the classes moves nothing.
  const stage = ui().el.querySelector<HTMLElement>('.v2-rm-stage');
  if (stage) {
    stage.classList.remove('in');
    delete stage.dataset.dir;
    stage.style.removeProperty('--rm-delay');
  }
}

/** After a render: (re)attach the slide in flight to the (new) stage, at the time it has reached. */
function attachMotion(): void {
  if (!motion) return;
  const stage = ui().el.querySelector<HTMLElement>('.v2-rm-stage');
  if (!stage) return endMotion();
  const t = performance.now() - motion.start;
  if (t >= SLIDE_MS) return endMotion();
  stage.style.setProperty('--rm-delay', `${-t.toFixed(1)}ms`);
  stage.dataset.dir = motion.dir > 0 ? 'next' : 'prev';
  stage.classList.add('in');
  if (motion.ghost) stage.prepend(motion.ghost);
}

/** Room art is decoded up front so a slide never starts on an empty card that pops its picture in mid-motion. */
let artWarm = false;
function warmRoomArt(): void {
  if (artWarm) return;
  artWarm = true;
  for (const r of ROOMS) {
    const url = roomArt(r.theme);
    if (!url) continue;
    const img = new Image();
    img.src = url;
    void img.decode?.().catch(() => undefined);
  }
}

/**
 * The table theme follows the room, but switching it re-skins the (hidden) table and re-renders the menu, which is
 * main-thread work that stalled the first frames of the slide. It's applied once the slide is over, or straight away
 * when the player sits down / opens Party before that.
 */
let themeTimer = 0;
function applyTheme(): void {
  window.clearTimeout(themeTimer);
  themeTimer = 0;
  const th = S('theme') as { pack?: { theme?: string }; setTheme?: (t: Theme) => void } | undefined;
  if (th?.pack?.theme !== rooms.theme) th?.setTheme?.(rooms.theme);
}

/** Picks up the player's current stake when the menu opens. */
export function syncRoom(): void {
  const stakes = host().stakes;
  rooms.theme = StakeTableSkin.themeFor(stakes.resolve().minBuyIn);
  // Never open on a room the player can't sit in: fall back to the richest room whose buy-in they cover.
  if (stakes.coins < roomTier(rooms.theme).startingStack) {
    const ok = ROOMS.filter((r) => stakes.coins >= roomTier(r.theme).startingStack);
    rooms.theme = (ok[ok.length - 1] ?? ROOMS[0]!).theme;
  }
  // The fixed buy-in replaces any amount picked earlier on Choose your table.
  const tier = roomTier(rooms.theme);
  stakes.selectedMinBuyIn = tier.minBuyIn;
  stakes.selectedBuyInChips = tier.startingStack;
  // The table skin follows the room shown here (as select() does), so Sit Down opens in this room from the first frame
  // instead of showing the previous room until the session's stake skin arrives.
  applyTheme();
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

function select(theme: Theme, dir = 0): void {
  if (theme === rooms.theme) return;
  // Dots: travel towards the picked room (forwards when it's further along the list).
  const d = dir || Math.sign(levelOf(theme) - levelOf(rooms.theme));
  startMotion(d);
  rooms.theme = theme;
  // The table theme (after the slide, applyTheme) and stake follow the room (like Choose your table), with the fixed buy-in.
  window.clearTimeout(themeTimer);
  themeTimer = window.setTimeout(applyTheme, SLIDE_MS + 60);
  const tier = roomTier(theme);
  const stakes = host().stakes;
  stakes.selectedMinBuyIn = tier.minBuyIn;
  stakes.selectedBuyInChips = tier.startingStack;
}

export function step(dir: number): void {
  const i = levelOf(rooms.theme);
  const n = (i + dir + ROOMS.length) % ROOMS.length;
  select(ROOMS[n]!.theme, dir < 0 ? -1 : 1);
}

/** The room we'd suggest: the richest one whose buy-in the player covers (the first when none). */
export function recommendedRoom(): Theme {
  const coins = host().stakes.coins;
  const ok = ROOMS.filter((r) => coins >= roomTier(r.theme).startingStack);
  return (ok[ok.length - 1] ?? ROOMS[0]!).theme;
}

/** On-chain: the NEAR house table a room stands for (five rooms over three stakes: 2 Micro, 2 Low, 1 Mid). */
export function nearTableOf(roomIndex: number): HouseTable {
  return HOUSE_TABLES[Math.min(HOUSE_TABLES.length - 1, Math.floor((roomIndex * HOUSE_TABLES.length) / ROOMS.length))]!;
}
const nearOf = (chips: number): string => formatNear(BigInt(chips) * 10n ** 21n, 3);

function peek(i: number, side: 'prev' | 'next'): string {
  const r = ROOMS[(i + ROOMS.length) % ROOMS.length]!;
  const t = roomTier(r.theme);
  const locked = !onchain() && host().stakes.coins < t.startingStack;
  const n = nearTableOf(ROOMS.indexOf(r)).config;
  const stake = onchain() ? `${n.small_blind} / ${n.big_blind} · NEAR` : `${t.displayName} · ${t.blindsLabel}`;
  return `<button class="v2-rm-peek ${side}${locked ? ' locked' : ''}" style="${bgArt(r.theme, r.color)}"${act('room-step', side === 'prev' ? -1 : 1)} aria-label="${esc(r.name)} room${locked ? ', locked' : ''}">${locked ? `<span class="v2-rm-peek-lock">${ico('lock', 1.1)}</span>` : ''}<b>${esc(r.name)}</b><small>${esc(stake)}</small></button>`;
}

/** The room stage markup for the main menu. */
export function roomStage(): string {
  const chain = onchain();
  const i = levelOf(rooms.theme);
  const r = ROOMS[i]!;
  const stakes = host().stakes;
  const tier = roomTier(rooms.theme);
  const near = nearTableOf(i);
  const locked = !chain && stakes.coins < tier.startingStack;
  const stakeLine = chain ? `${esc(near.name)} · ${near.config.small_blind} / ${near.config.big_blind}` : `${esc(tier.displayName)} stakes · ${esc(tier.blindsLabel)}`;
  // One fixed buy-in per room, the same for every player.
  const buyLine = chain
    ? `Buy-in ${nearOf(near.config.min_buy_in)}–${nearOf(near.config.max_buy_in)} NEAR · on NEAR testnet`
    : locked
      ? `Buy-in ${formatN0(tier.startingStack)} Coins · you have ${formatN0(stakes.coins)}`
      : `Buy-in ${formatN0(tier.startingStack)} Coins`;
  const dots = ROOMS.map((x, j) => `<button class="v2-rm-dot${j === i ? ' on' : ''}"${act('room-pick', x.theme)} aria-label="${esc(x.name)}"></button>`).join('');
  return `<section class="v2-rooms" aria-roledescription="carousel" aria-label="Rooms">
  <div class="v2-rm-stage">
    ${peek(i - 1, 'prev')}
    <div class="v2-rm-card${locked ? ' locked' : ''}" style="${bgArt(r.theme, r.color)}">
      ${locked ? `<span class="v2-rm-lock">${ico('lock', 1.4)} Locked</span>` : !chain && rooms.theme === recommendedRoom() ? `<span class="v2-rm-lock v2-rm-rec">${ico('star', 1.2)} Recommended</span>` : ''}
      <button class="v2-rm-arrow prev"${act('room-step', -1)} aria-label="Previous room">${ico('back', 1.2)}</button>
      <button class="v2-rm-arrow next"${act('room-step', 1)} aria-label="Next room">${ico('back', 1.2, 'transform:scaleX(-1)')}</button>
      <div class="v2-rm-bar">
        <div class="v2-rm-info" aria-live="polite"><b class="v2-rm-name">${esc(r.name)}</b><span class="v2-rm-stake">${stakeLine}</span><span class="v2-rm-buy">${buyLine}</span></div>
        <div class="v2-rm-actions">
          ${locked ? btn(`Get Coins ${ico('next', 0.8)}`, 'get-coins', { h: 'green', c: 'lg v2-rm-sit' }) : btn(`Sit Down ${ico('next', 0.8)}`, 'room-sit', { h: 'gold', c: 'lg v2-rm-sit' })}
          ${btn(`${ico('friends', 1.3)} Play with friends`, 'room-friends', { h: 'violet', c: 'v2-rm-friends' })}
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
  'room-friends': () => {
    applyTheme();
    // On-chain: host or join a NEAR table (Play for NEAR has Host a table and invite links).
    if (onchain()) return ui().show('near-tables');
    host().show('PartyMenu');
  },
  'room-sit': () => {
    applyTheme();
    const h = host();
    if (!signedIn()) return h.show('Login');
    const i = levelOf(rooms.theme);
    if (onchain()) return ui().show('near-tables', nearTableOf(i).id);
    const tier = roomTier(rooms.theme);
    if (needCoins(tier.startingStack, `The ${ROOMS[i]!.name} room`)) return;
    void joinFreePlay(h, tier, tier.startingStack, 'quick');
  },
};

/** Swipe on the stage and ←/→ keys on the main menu change the room. */
export function installRoomGestures(): void {
  const el = ui().el;
  el.addEventListener('v2:rendered', (e) => {
    if ((e as CustomEvent<string>).detail !== 'main') return endMotion();
    warmRoomArt();
    attachMotion();
  });
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
