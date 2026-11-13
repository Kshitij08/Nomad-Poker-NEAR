/**
 * The v2 raise sheet (docs/ui-style-guide.md › Table HUD). The Unity Confirm_Panel stays as the betting panel's state
 * holder (its buttons keep the keyboard shortcuts: Enter, Escape, ↑/↓, A); this DOM sheet is what the player sees
 * and taps: preset chips with their amounts, −/+ and a slider, the stack, and Cancel / "Raise to N" (or "All-in N").
 * It sits just above the action row, so Fold and Call stay reachable while it is open; a tap outside closes it.
 */
import { TableMoney } from '@nomad/engine';
import { ico } from '../ui2/icons';
import './v2hud.css';

type Preset = 'MIN' | '1/4' | '1/2' | '3/4' | 'ALL IN';

export interface RaiseSheetActions {
  preset(p: Preset): void;
  set(v: number): void;
  nudge(dir: number): void;
  confirm(): void;
  close(): void;
  /** The action row's top edge in the HUD layer (CSS px). */
  anchor(): number;
}

export interface RaiseSheetState {
  verb: 'Raise' | 'Bet';
  value: number;
  min: number;
  max: number;
  stack: number;
  presets: { key: Preset; amount: number }[];
  canMinus: boolean;
  canPlus: boolean;
}

const PRESET_LABEL: Record<Preset, string> = { MIN: 'Min', '1/4': '¼ stack', '1/2': '½ stack', '3/4': '¾ stack', 'ALL IN': 'All-in' };

export class RaiseSheet {
  readonly el: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly presetsEl: HTMLElement;
  private readonly amount: HTMLElement;
  private readonly range: HTMLInputElement;
  private readonly minus: HTMLButtonElement;
  private readonly plus: HTMLButtonElement;
  private readonly go: HTMLButtonElement;
  private open = false;
  private placeTimer = 0;

  constructor(parent: HTMLElement, private readonly act: RaiseSheetActions) {
    const el = document.createElement('div');
    el.className = 'v2hud-raise';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Raise amount');
    el.innerHTML = `
      <div class="v2hud-raise-head"><b class="v2hud-raise-title">Raise</b><span class="v2hud-raise-stack"></span></div>
      <div class="v2hud-raise-presets"></div>
      <div class="v2hud-raise-amt">
        <button type="button" class="v2hud-rnd" data-r="minus" aria-label="Less">${ico('minus', 1)}</button>
        <div class="v2hud-raise-mid"><b class="v2hud-raise-val"></b><input type="range" class="v2hud-range" aria-label="Amount" step="any"></div>
        <button type="button" class="v2hud-rnd" data-r="plus" aria-label="More">${ico('plus', 1)}</button>
      </div>
      <div class="v2hud-raise-foot">
        <button type="button" class="v2hud-b ghost" data-r="cancel">Cancel</button>
        <button type="button" class="v2hud-b gold" data-r="go">Raise</button>
      </div>`;
    parent.append(el);
    this.el = el;
    const q = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
    this.title = q('.v2hud-raise-title');
    this.stack = q('.v2hud-raise-stack');
    this.presetsEl = q('.v2hud-raise-presets');
    this.amount = q('.v2hud-raise-val');
    this.range = q<HTMLInputElement>('.v2hud-range');
    this.minus = q<HTMLButtonElement>('[data-r=minus]');
    this.plus = q<HTMLButtonElement>('[data-r=plus]');
    this.go = q<HTMLButtonElement>('[data-r=go]');
    this.minus.addEventListener('click', () => this.act.nudge(-1));
    this.plus.addEventListener('click', () => this.act.nudge(+1));
    q('[data-r=cancel]').addEventListener('click', () => this.act.close());
    this.go.addEventListener('click', () => this.act.confirm());
    this.range.addEventListener('input', () => this.act.set(Number(this.range.value)));
    this.presetsEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
      if (b) this.act.preset(b.dataset.p as Preset);
    });
    // A tap outside the sheet and the action row closes it (the row's own buttons stay usable).
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.open) return;
        const t = e.target as HTMLElement;
        if (el.contains(t) || t.closest?.('[data-hud="betting"]')) return;
        this.act.close();
      },
      true,
    );
  }

  show(s: RaiseSheetState): void {
    const allIn = s.value >= s.max;
    this.title.textContent = s.verb;
    this.stack.textContent = `Stack ${TableMoney.chips(s.stack)}`;
    this.presetsEl.innerHTML = s.presets
      .map((p) => `<button type="button" class="v2hud-chip${p.amount === s.value ? ' on' : ''}${p.key === 'ALL IN' ? ' hot' : ''}" data-p="${p.key}"><span>${PRESET_LABEL[p.key]}</span><b>${TableMoney.chips(p.amount)}</b></button>`)
      .join('');
    this.amount.textContent = TableMoney.chips(s.value);
    this.range.min = String(s.min);
    this.range.max = String(s.max);
    if (document.activeElement !== this.range) this.range.value = String(s.value);
    const frac = s.max > s.min ? (s.value - s.min) / (s.max - s.min) : 1;
    this.range.style.setProperty('--fill', `${(frac * 100).toFixed(1)}%`);
    this.minus.disabled = !s.canMinus;
    this.plus.disabled = !s.canPlus;
    this.go.textContent = allIn ? `All-in ${TableMoney.chips(s.value)}` : `${s.verb} to ${TableMoney.chips(s.value)}`;
    this.go.classList.toggle('hot', allIn);
    this.go.classList.toggle('gold', !allIn);
    this.el.hidden = false;
    const opening = !this.open;
    this.open = true;
    // Place on open only (resizes go through placeSoon): re-placing on every slider move made the sheet jump.
    if (opening) this.place();
  }

  /**
   * Where the sheet goes (every show and every resize):
   * - phone (portrait): a compact two-row sheet over the action row, under your seat, so your cards and stack stay
   *   visible above it;
   * - landscape: centred just above the action row (whole-pixel position, so the text stays crisp). It used to sit
   *   beside your seat, where it covered the next seat's stack and cards.
   */
  /** After a resize: the seats re-project after the action row lays out, so measure a moment later. */
  placeSoon(): void {
    if (!this.open) return;
    window.clearTimeout(this.placeTimer);
    this.placeTimer = window.setTimeout(() => this.place(), 60);
  }

  place(): void {
    if (!this.open) return;
    const parent = this.el.parentElement;
    if (!parent) return;
    const st = this.el.style;
    const portrait = document.documentElement.dataset.orient === 'portrait';
    this.el.classList.toggle('compact', portrait);
    if (portrait) {
      st.left = st.right = '8px';
      st.width = 'auto';
      st.transform = 'none';
      st.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 8px)';
      return;
    }
    const pr = parent.getBoundingClientRect();
    const bottom = Math.max(8, pr.height - this.act.anchor() + 10);
    st.bottom = `${bottom}px`;
    st.right = '';
    const want = Math.round(Math.min(28 * parseFloat(getComputedStyle(this.el).fontSize || '14'), pr.width - 32));
    st.left = `${Math.round((pr.width - want) / 2)}px`;
    st.width = `${want}px`;
    st.transform = 'none';
  }

  hide(): void {
    this.open = false;
    // A focused control inside the hidden sheet (the slider after a drag) would keep the keyboard: the panel ignores
    // shortcuts while an input has focus, so F / C / R went dead after a timeout closed the sheet.
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.el.hidden = true;
  }
}
