/**
 * Small DOM helpers for the Agent dialogs. Unity builds these dialogs in code (NomadDialogs: Panel, Line, Row, Button,
 * ScrollList) in 1920x1080 reference pixels with centre-origin anchored positions; `refPanel` + `place` reproduce that
 * coordinate system (x right, y up, from the panel centre) and scale the panel to fit the window.
 */
import { formatN0 } from '../../core/util/dotnetMath';
import { roundHalfEven } from '../../core/util/dotnetMath';
import './agents.css';

export const COLORS = {
  gold: 'rgb(255, 212, 77)',
  agentLine: 'rgb(158, 227, 255)',
  soft: 'rgb(168, 184, 224)',
  good: 'rgb(102, 230, 128)',
  bad: 'rgb(242, 115, 115)',
  white: '#fff',
} as const;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Positions `e` in its reference panel: centre (x, y) with y up, size (w, h) in reference pixels. */
export function place(e: HTMLElement, panelW: number, panelH: number, x: number, y: number, w: number, h: number): HTMLElement {
  e.style.position = 'absolute';
  e.style.left = `${panelW / 2 + x - w / 2}px`;
  e.style.top = `${panelH / 2 - y - h / 2}px`;
  e.style.width = `${w}px`;
  e.style.height = `${h}px`;
  return e;
}

export interface RefPanel {
  root: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  w: number;
  h: number;
  dispose(): void;
}

/** NomadDialogs.Panel: a titled window of `w` x `h` reference pixels over a dimmed screen, scaled to fit. */
export function refPanel(host: HTMLElement, title: string, w: number, h: number, onClose: () => void): RefPanel {
  const root = el('div', 'agent-modal');
  const panel = el('div', 'agent-panel');
  panel.style.width = `${w}px`;
  panel.style.height = `${h}px`;
  const head = el('div', 'agent-panel-head', title);
  const close = el('button', 'agent-panel-close', '✕');
  close.addEventListener('click', onClose);
  const body = el('div', 'agent-panel-body');
  panel.append(head, close, body);
  root.append(panel);
  host.append(root);
  const fit = () => {
    const s = Math.min((window.innerWidth * 0.96) / w, (window.innerHeight * 0.96) / h, 1.2);
    panel.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  fit();
  window.addEventListener('resize', fit);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
  window.addEventListener('keydown', onKey);
  return {
    root, panel, body, w, h,
    dispose: () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}

/** NomadDialogs.Line: one line of text at (x, y). */
export function line(p: RefPanel | { body: HTMLElement; w: number; h: number }, text: string, size: number, x: number, y: number, w: number, h: number,
  color: string = COLORS.white, align: 'left' | 'center' | 'right' = 'left'): HTMLElement {
  const t = el('div', 'agent-line');
  t.innerHTML = text;
  t.style.fontSize = `${size}px`;
  t.style.color = color;
  t.style.textAlign = align;
  t.style.lineHeight = `${h}px`;
  place(t, p.w, p.h, x, y, w, h);
  p.body.append(t);
  return t;
}

/** NomadDialogs.Button (the art's yellow TABLES / blue QUICK PLAY buttons). */
export function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'nomad-btn' + (primary ? ' primary' : ''), label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---- cards and numbers as text (NomadUiHost.Replay.cs)

function suitHex(suit: string, onLight: boolean): string {
  switch (suit.toLowerCase()) {
    case 'h': return onLight ? '#D62F3A' : '#FF6B6B';
    case 'd': return onLight ? '#1F6FD1' : '#5DB0FF';
    case 'c': return onLight ? '#178A43' : '#5BD88A';
    default: return onLight ? '#1A1A2E' : '#F2F4FA';
  }
}

const rankText = (card: string): string => {
  const r = card.slice(0, -1);
  return r === 'T' ? '10' : r;
};

/** A card ("As", "Th") as rich text in a four-colour deck (CardRich): the suit is its letter. */
export function cardRich(card: string | null | undefined): string {
  if (!card || card.length < 2) return '<span style="color:#7F8AB0">??</span>';
  const s = card[card.length - 1]!;
  return `<span style="color:${suitHex(s, false)}">${escapeHtml(rankText(card))}<small>${escapeHtml(s.toLowerCase())}</small></span>`;
}

export function cardsRich(spaced: string | null | undefined): string {
  if (!spaced || !spaced.trim()) return '';
  return spaced.split(/[ ,]+/).filter(Boolean).map((p) => cardRich(p.replace(/["[\]]/g, ''))).join(' ');
}

const MARK_L = String.fromCharCode(1);
const MARK_R = String.fromCharCode(2);
const MARKED = new RegExp(MARK_L + '([^' + MARK_R + ']*)' + MARK_R, 'g');

/** A card formatter for AgentHandReplayText that survives HTML escaping; richCards() turns the marks into coloured cards. */
export const cardMark = (c: string): string => MARK_L + c + MARK_R;

/** Text built with cardMark → safe HTML (names escaped, cards coloured like CardRich). */
export function richCards(text: string): string {
  return escapeHtml(text).replace(MARKED, (_, c: string) => cardRich(c));
}

/** SetChip: a white chip with the rank and suit letter; null = face down ("?"), "" = an empty board slot. */
export function setChip(chip: HTMLElement, card: string | null): void {
  chip.classList.remove('down', 'empty');
  if (card == null) {
    chip.classList.add('down');
    chip.innerHTML = '<span style="color:#C9D3F5">?</span>';
  } else if (card.length < 2) {
    chip.classList.add('empty');
    chip.innerHTML = '';
  } else {
    const s = card[card.length - 1]!;
    chip.innerHTML = `<span style="color:${suitHex(s, true)}">${escapeHtml(rankText(card))}<small>${escapeHtml(s.toLowerCase())}</small></span>`;
  }
}

export const coins = (v: number): string => formatN0(v);
export const plusCoins = (v: number): string => (v >= 0 ? '+' : '') + formatN0(v);

/** NomadUiHost.Duration: "4m 05s", "1h 12m". */
export function duration(seconds: number): string {
  const s = Math.max(0, roundHalfEven(Math.fround(seconds)));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** NomadUiHost.Short: cut to n characters with an ellipsis. */
export const shortText = (s: string, n: number): string => (!s || s.length <= n ? s : s.slice(0, n - 1) + '…');

/** NomadUiHost.Message: a message box with up to two buttons (and an optional text input). */
export function message(host: HTMLElement, title: string, body: string, ok: string | null = 'OK', onOk?: (input?: string) => void,
  cancel: string | null = null, onCancel?: () => void, input?: { placeholder: string; value?: string }): () => void {
  const p = refPanel(host, title, 800, input ? 460 : 380, () => close());
  const text = line(p, escapeHtml(body), 28, 0, input ? 70 : 20, 700, input ? 150 : 170, 'rgb(204, 214, 237)', 'center');
  text.style.lineHeight = '1.3';
  text.style.display = 'flex';
  text.style.alignItems = 'center';
  text.style.justifyContent = 'center';
  let field: HTMLInputElement | null = null;
  if (input) {
    field = el('input', 'agent-input');
    field.placeholder = input.placeholder;
    field.value = input.value ?? '';
    place(field, p.w, p.h, 0, -50, 560, 64);
    p.body.append(field);
    setTimeout(() => field?.focus(), 0);
  }
  const row = el('div', 'agent-buttons');
  place(row, p.w, p.h, 0, -p.h / 2 + 75, 720, 80);
  if (cancel) row.append(button(cancel, false, () => { close(); onCancel?.(); }));
  if (ok) row.append(button(ok, true, () => { close(); onOk?.(field?.value); }));
  p.body.append(row);
  function close() {
    p.dispose();
  }
  return close;
}
