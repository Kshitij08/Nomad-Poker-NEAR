/**
 * Redesign v2 table chrome kit (docs/ui-style-guide.md › Table HUD): the bars over the live table that hold
 * Leave / room code (top-left) and chat / reactions / hand rankings / settings (top-right), the pre-game row, the
 * table toast, and simple sheets. Shared by the Nomad table chrome (menu/table/nomadTableHud.ts) and the net chrome
 * (net/chrome/netChrome.ts), which register on the same table screen: both put their buttons into one set of slots.
 */
import { ico, ui2Art } from './icons';
import { v2tEl } from './tableKit';
import './tableChrome.css';

/** Small inline icons that only the table uses. */
const SVG = {
  chat: '<path d="M8 8h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H22l-9 8v-8H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="16" cy="21" r="2.8" fill="currentColor"/><circle cx="24" cy="21" r="2.8" fill="currentColor"/><circle cx="32" cy="21" r="2.8" fill="currentColor"/>',
  smile: '<circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="17" cy="20" r="3" fill="currentColor"/><circle cx="31" cy="20" r="3" fill="currentColor"/><path d="M15 29c2.5 4 5.5 6 9 6s6.5-2 9-6" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  help: '<circle cx="24" cy="24" r="19" fill="none" stroke="currentColor" stroke-width="4"/><path d="M18 18a6 6 0 1 1 9 5c-2 1.2-3 2.4-3 5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="35" r="2.8" fill="currentColor"/>',
  copy: '<rect x="15" y="15" width="25" height="27" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><path d="M10 33V10a4 4 0 0 1 4-4h18" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  send: '<path d="M6 24L42 8 32 42l-8-14z" fill="currentColor"/>',
  mic: '<rect x="17" y="5" width="14" height="24" rx="7" fill="currentColor"/><path d="M11 22a13 13 0 0 0 26 0M24 35v7M17 42h14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  micOff: '<rect x="17" y="5" width="14" height="24" rx="7" fill="currentColor"/><path d="M11 22a13 13 0 0 0 26 0M24 35v7M17 42h14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M8 6l32 36" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>',
  bot: '<rect x="8" y="14" width="32" height="26" rx="9" fill="currentColor"/><rect x="13" y="20" width="22" height="12" rx="6" fill="#2a1a6e"/><circle cx="19" cy="26" r="2.6" fill="#14f1c5"/><circle cx="29" cy="26" r="2.6" fill="#14f1c5"/><rect x="22.5" y="6" width="3" height="8" fill="currentColor"/>',
};

export function tIcon(name: keyof typeof SVG | string, sizeEm = 1.3): string {
  const body = (SVG as Record<string, string>)[name];
  if (body) return `<svg viewBox="0 0 48 48" aria-hidden="true" style="width:${sizeEm}em;height:${sizeEm}em">${body}</svg>`;
  return ico(name, sizeEm);
}

export interface ChromeSlots {
  /** The chrome layer (.v2t) over the table: drawers, sheets and toasts go here. */
  layer: HTMLElement;
  /** Top-left bar: Leave, then the room code. */
  left: HTMLElement;
  /** Second row under the left bar (portrait: room code / + Bot). */
  left2: HTMLElement;
  /** Top-right bar: reactions, chat, rankings, settings. */
  right: HTMLElement;
  /** Pre-game row (bottom centre in landscape, centre of the felt in portrait). */
  pregame: HTMLElement;
}

const slotsByRoot = new WeakMap<HTMLElement, ChromeSlots>();

/** The table screen's chrome slots (created once per table visit; both chromes share them). */
export function chromeSlots(root: HTMLElement): ChromeSlots {
  let s = slotsByRoot.get(root);
  if (s && s.layer.isConnected) return s;
  const layer = v2tEl('div', 'v2t v2t-chrome', root);
  layer.style.zIndex = '30';
  s = {
    layer,
    left: v2tEl('div', 'v2t-cbar left', layer),
    left2: v2tEl('div', 'v2t-cbar left2', layer),
    right: v2tEl('div', 'v2t-cbar right', layer),
    pregame: v2tEl('div', 'v2t-pgrow', layer),
  };
  slotsByRoot.set(root, s);
  return s;
}

/** The round table buttons' soft-2D art (public/assets/ui2/icons), like the menu icons. */
const BUTTON_ART: Record<string, string> = {
  smile: 'icons/ico_emoji',
  chat: 'icons/ico_chat',
  help: 'icons/ico_help',
  gear: 'icons/ico_settings',
};

/** A round icon button (settings, chat, reactions, rankings). `order` sorts it inside its bar. */
export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, order = 0): HTMLButtonElement {
  const b = v2tEl('button', 'v2t-ib', parent);
  b.type = 'button';
  const art = BUTTON_ART[icon];
  b.innerHTML = art ? `<img class="v2t-ib-art" src="${ui2Art(art)}" alt="" draggable="false" decoding="async">` : tIcon(icon, 1.35);
  if (art) b.classList.add('art');
  b.setAttribute('aria-label', label);
  b.title = label;
  b.style.order = String(order);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** A chip button (Leave, room code, + Bot). */
export function chipButton(parent: HTMLElement, html: string, label: string, onClick: () => void, cls = '', order = 0): HTMLButtonElement {
  const b = v2tEl('button', `v2t-chip ${cls}`, parent);
  b.type = 'button';
  b.innerHTML = html;
  b.setAttribute('aria-label', label);
  b.style.order = String(order);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

let toastTimer = 0;
/** A short confirmation at the top centre of the table ("Copied"). */
export function tableToast(layer: HTMLElement, text: string, ms = 1600): void {
  layer.querySelector('.v2t-toast')?.remove();
  const t = v2tEl('div', 'v2t-toast', layer, text);
  t.setAttribute('role', 'status');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), ms);
}

/** A sheet / dialog over the table (bottom sheet in portrait). Returns its body and a close function. */
export function tableSheet(layer: HTMLElement, title: string, opts: { wide?: boolean; onClose?: () => void } = {}): { body: HTMLElement; foot: HTMLElement; close: () => void } {
  const dim = v2tEl('div', 'v2t-dim v2t-sheet-dim', layer);
  const dlg = v2tEl('div', `v2t-dlg v2t-sheet${opts.wide ? ' wide' : ''}`, dim);
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', title);
  const head = v2tEl('div', 'v2t-sheet-head', dlg);
  v2tEl('div', 'v2t-h', head, title);
  const x = v2tEl('button', 'v2t-ib sm', head);
  x.type = 'button';
  x.innerHTML = ico('close', 1);
  x.setAttribute('aria-label', 'Close');
  const body = v2tEl('div', 'v2t-sheet-body', dlg);
  const foot = v2tEl('div', 'v2t-df', dlg);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dim.remove();
    window.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  x.addEventListener('click', close);
  dim.addEventListener('click', (e) => e.target === dim && close());
  return { body, foot, close };
}

// ---------------------------------------------------------------------------------------------------- hand rankings

const RANKS: [string, string, string[]][] = [
  ['Royal flush', 'A, K, Q, J, 10 of one suit', ['A♠', 'K♠', 'Q♠', 'J♠', '10♠']],
  ['Straight flush', 'Five in a row, one suit', ['9♥', '8♥', '7♥', '6♥', '5♥']],
  ['Four of a kind', 'Four cards of one rank', ['Q♣', 'Q♦', 'Q♥', 'Q♠', '4♦']],
  ['Full house', 'Three of a kind plus a pair', ['J♠', 'J♥', 'J♦', '8♣', '8♠']],
  ['Flush', 'Any five of one suit', ['K♦', '10♦', '7♦', '4♦', '2♦']],
  ['Straight', 'Five in a row, any suits', ['10♣', '9♦', '8♠', '7♥', '6♣']],
  ['Three of a kind', 'Three cards of one rank', ['7♠', '7♥', '7♦', 'K♣', '2♠']],
  ['Two pair', 'Two different pairs', ['A♥', 'A♣', '9♠', '9♦', '5♥']],
  ['Pair', 'Two cards of one rank', ['10♥', '10♠', 'K♦', '6♣', '3♠']],
  ['High card', 'None of the above: highest card plays', ['A♦', 'J♣', '8♥', '5♠', '2♦']],
];

/** Hand rankings, strongest first. */
export function openHandRankings(layer: HTMLElement): void {
  const { body, foot, close } = tableSheet(layer, 'Hand rankings', { wide: true });
  body.classList.add('v2t-ranks');
  body.innerHTML = RANKS.map(
    ([name, what, cards], i) =>
      `<div class="v2t-rank"><span class="v2t-rank-n">${i + 1}</span><div class="v2t-rank-t"><b>${name}</b><small>${what}</small></div><span class="v2t-rank-cards">${cards
        .map((c) => `<i class="v2t-mc${/[♥♦]/.test(c) ? ' r' : ''}">${c}</i>`)
        .join('')}</span></div>`,
  ).join('');
  const ok = v2tEl('button', 'v2t-b gold', foot, 'Got it');
  ok.type = 'button';
  ok.addEventListener('click', close);
}
