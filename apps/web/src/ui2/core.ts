/**
 * Redesign v2 screen host. Screens are plain HTML strings re-rendered from their state; clicks are delegated by
 * `data-a="<action>"` (+ optional `data-v="<value>"`), inputs report through `data-in="<key>"` into `screen.input`.
 * Rendering is skipped while an input has focus or a slider is being dragged, and only touches the DOM when the
 * markup changed, so the once-a-second refresh is cheap.
 */
import { ico } from './icons';

export type Action = (v: string, el: HTMLElement, ev: Event) => void | Promise<void>;

export interface V2Screen {
  /** Unique id ("main", "tables", …). */
  readonly id: string;
  /** Where the top bar's Back goes (a v2 screen id); default 'main'. */
  back?: string;
  /** Markup for the page (inside .v2-page or full-bleed when `bare`). */
  render(): string;
  /** Click handlers by data-a name. */
  actions?: Record<string, Action>;
  /** Slider changes by data-sld key (0–100). */
  slide?(key: string, value: number, done: boolean): void;
  /** Called when the screen is opened (with an optional argument). */
  open?(arg?: unknown): void;
  /** Called when it is left. */
  close?(): void;
  /** Inputs' current values by data-in key (kept across renders). */
  input?: Record<string, string>;
  /** Back closes something inside the screen first (a popover): return true when it did. */
  backFirst?(): boolean;
  /** When true, render() supplies its own full-screen layout (no .v2-page wrapper). */
  bare?: boolean;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Attributes for a clickable element. */
export const act = (a: string, v: unknown = ''): string => ` data-a="${esc(a)}"${v !== '' ? ` data-v="${esc(v)}"` : ''}`;

/** A button. h = gold | blue | violet | red | green | ghost | hot; c = extra classes (lg, sm, w, dis). */
export function btn(label: string, a: string, o: { h?: string; c?: string; v?: unknown; dis?: boolean; title?: string } = {}): string {
  return `<button class="v2-b ${o.h ?? 'blue'} ${o.c ?? ''}"${act(a, o.v ?? '')}${o.dis ? ' disabled' : ''}${o.title ? ` title="${esc(o.title)}"` : ''}>${label}</button>`;
}

/** Tab strip. items: [value, label, icon?]. */
export function tabs(items: [string, string, string?][], on: string, a: string, cls = ''): string {
  return `<div class="v2-tabs ${cls}" role="tablist">${items
    .map(([v, l, i]) => `<button class="v2-tab${v === on ? ' on' : ''}" role="tab" aria-selected="${v === on}"${act(a, v)}>${i ? ico(i, 1.5, v === on ? '' : 'color:#c3bef0') : ''}<span class="v2-ellip">${l}</span></button>`)
    .join('')}</div>`;
}

/** Chips. items: [value, label]. */
export function chips(items: [string, string][], on: string, a: string, big = false): string {
  return items.map(([v, l]) => `<button class="v2-chip${big ? ' big' : ''}${v === on ? ' on' : ''}"${act(a, v)}>${l}</button>`).join('');
}

/** Draggable slider (0–100). */
export function slider(key: string, value: number, label: string): string {
  const v = Math.max(0, Math.min(100, value));
  return `<div class="v2-sld" data-sld="${esc(key)}" role="slider" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v)}" tabindex="0"><div class="trk"><i style="width:${v}%"></i><b class="knob" style="left:${v}%"></b></div></div>`;
}

export function input(key: string, value: string, placeholder: string, o: { cls?: string; type?: string; max?: number; style?: string } = {}): string {
  return `<input class="v2-field ${o.cls ?? ''}" data-in="${esc(key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" type="${o.type ?? 'text'}"${o.max ? ` maxlength="${o.max}"` : ''}${o.style ? ` style="${o.style}"` : ''} autocomplete="off" spellcheck="false">`;
}

export interface DialogSpec {
  title: string;
  body: string | (() => string);
  buttons: string;
  wide?: boolean;
  actions?: Record<string, Action>;
  /** Tap on the dim area closes (default true). */
  dismiss?: boolean;
}

export class V2 {
  readonly el: HTMLElement;
  private readonly bg: HTMLElement;
  private readonly pageEl: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly screens = new Map<string, V2Screen>();
  private current: V2Screen | null = null;
  private dialog: DialogSpec | null = null;
  private lastHtml = '';
  private lastDlg = '';
  private dragging = false;
  private toastTimer = 0;
  private readonly history: string[] = [];
  /** Called when the v2 layer opens or closes a screen (null = hidden; Unity screen showing). */
  onChange: ((id: string | null) => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'v2';
    this.el.hidden = true;
    this.bg = document.createElement('div');
    this.bg.className = 'v2-bg';
    this.pageEl = document.createElement('div');
    this.layer = document.createElement('div');
    this.el.append(this.bg, this.pageEl, this.layer);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
  }

  register(s: V2Screen): void {
    this.screens.set(s.id, s);
  }

  get(id: string): V2Screen | undefined {
    return this.screens.get(id);
  }

  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  get isOpen(): boolean {
    return !!this.current;
  }

  get hasDialog(): boolean {
    return !!this.dialog;
  }

  /** Opens a v2 screen. */
  show(id: string, arg?: unknown, pushHistory = true): void {
    const s = this.screens.get(id);
    if (!s) return;
    if (this.current && this.current !== s) {
      this.current.close?.();
      if (pushHistory) this.history.push(this.current.id);
    }
    if (id === 'main') this.history.length = 0;
    if (this.history.length > 20) this.history.shift();
    this.dialog = null;
    this.current = s;
    this.el.hidden = false;
    s.open?.(arg);
    this.lastHtml = '';
    this.render(true);
    const scroller = this.pageEl.querySelector('.v2-scroll');
    if (scroller) scroller.scrollTop = 0;
    this.onChange?.(id);
  }

  /** Hides the v2 layer (a Unity screen is showing). */
  hide(): void {
    if (!this.current) return;
    this.current.close?.();
    this.current = null;
    this.dialog = null;
    this.history.length = 0;
    this.el.hidden = true;
    this.pageEl.innerHTML = '';
    this.layer.innerHTML = '';
    this.lastHtml = this.lastDlg = '';
    this.onChange?.(null);
  }

  /** Back: closes a dialog, else goes to the screen's back target. Returns false at the main menu. */
  back(): boolean {
    if (this.dialog) {
      this.closeDialog();
      return true;
    }
    if (this.current?.backFirst?.()) {
      this.render(true);
      return true;
    }
    if (!this.current || this.current.id === 'main') return false;
    // Where you came from (e.g. Tables → Shop → Back = Tables), else the screen's own back target.
    let prev = this.history.pop();
    while (prev && (prev === this.current.id || !this.screens.has(prev))) prev = this.history.pop();
    this.show(prev ?? this.current.back ?? 'main', undefined, false);
    return true;
  }

  /** Re-renders the current screen (and dialog) when their markup changed. */
  render(force = false): void {
    const s = this.current;
    if (!s) return;
    if (!force && (this.dragging || this.typing())) return;
    let html: string;
    try {
      html = s.render();
    } catch (e) {
      console.error('[ui2] render failed', s.id, e);
      return;
    }
    if (force || html !== this.lastHtml) {
      const scrolls = [...this.pageEl.querySelectorAll<HTMLElement>('.v2-scroll')].map((x) => x.scrollTop);
      // Keyboard focus survives a re-render: re-focus the control with the same action (and value, else class).
      const fa = document.activeElement as HTMLElement | null;
      const focusSel = fa && this.pageEl.contains(fa) && fa.dataset.a ? `[data-a="${CSS.escape(fa.dataset.a)}"]${fa.dataset.v !== undefined ? `[data-v="${CSS.escape(fa.dataset.v)}"]` : ''}${fa.classList[0] ? `.${CSS.escape(fa.classList[0])}` : ''}` : null;
      this.pageEl.className = s.bare ? 'v2-bare' : 'v2-page';
      this.pageEl.dataset.screen = s.id;
      this.pageEl.innerHTML = html;
      this.pageEl.querySelectorAll<HTMLElement>('.v2-scroll').forEach((x, i) => (x.scrollTop = scrolls[i] ?? 0));
      if (focusSel) {
        const again = this.pageEl.querySelector<HTMLElement>(focusSel);
        if (again && !(again as HTMLButtonElement).disabled) again.focus({ preventScroll: true });
      }
      this.lastHtml = html;
    }
    const dlg = this.dialog ? this.dialogHtml(this.dialog) : '';
    if (force || dlg !== this.lastDlg) {
      this.layer.innerHTML = dlg;
      this.lastDlg = dlg;
    }
  }

  private typing(): boolean {
    const a = document.activeElement;
    return !!a && this.el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }

  // ------------------------------------------------------------------ dialogs + toast

  openDialog(d: DialogSpec): void {
    this.dialog = d;
    this.render(true);
    (this.layer.querySelector('input') as HTMLInputElement | null)?.focus();
  }

  closeDialog(): void {
    if (!this.dialog) return;
    this.dialog = null;
    this.render(true);
  }

  /** Simple message dialog. */
  message(title: string, body: string, ok = 'OK', onOk?: () => void, cancel?: string, onCancel?: () => void, okHue = 'gold'): void {
    this.openDialog({
      title,
      body,
      buttons: (cancel ? btn(esc(cancel), 'dlg-cancel', { h: 'ghost' }) : '') + btn(esc(ok), 'dlg-ok', { h: okHue }),
      actions: {
        'dlg-ok': () => {
          this.closeDialog();
          onOk?.();
        },
        'dlg-cancel': () => {
          this.closeDialog();
          onCancel?.();
        },
      },
    });
  }

  private dialogHtml(d: DialogSpec): string {
    return `<div class="v2-dim" data-dim="1"><div class="v2-dlg${d.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(d.title.replace(/<[^>]+>/g, ''))}"><div class="v2-dh">${d.title}</div><div class="v2-db">${typeof d.body === 'function' ? d.body() : d.body}</div><div class="v2-df">${d.buttons}</div></div></div>`;
  }

  toast(text: string, ms = 1800): void {
    this.el.querySelector('.v2-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'v2-toast';
    t.textContent = text;
    this.el.append(t);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.remove(), ms);
  }

  // ------------------------------------------------------------------ events

  private onClick(e: Event): void {
    const target = e.target as HTMLElement;
    if (this.dialog && target.closest('[data-dim]') === target && this.dialog.dismiss !== false) {
      this.closeDialog();
      return;
    }
    const el = target.closest<HTMLElement>('[data-a]');
    if (!el || !this.el.contains(el) || (el as HTMLButtonElement).disabled) return;
    const a = el.dataset.a!;
    const v = el.dataset.v ?? '';
    const inDialog = this.layer.contains(el);
    const fn = (inDialog ? this.dialog?.actions?.[a] : undefined) ?? this.current?.actions?.[a] ?? this.globalActions[a];
    if (!fn) return;
    e.preventDefault();
    try {
      const r = fn(v, el, e);
      if (r instanceof Promise) r.catch((err) => console.error('[ui2] action failed', a, err)).finally(() => this.render());
      else this.render();
    } catch (err) {
      console.error('[ui2] action failed', a, err);
    }
  }

  /** Actions every screen has (back, go:<screen>). */
  readonly globalActions: Record<string, Action> = {
    back: () => {
      this.back();
    },
    // go:<screen> or go:<screen>:<arg>
    go: (v) => {
      const i = v.indexOf(':');
      if (i < 0) this.show(v);
      else this.show(v.slice(0, i), v.slice(i + 1));
    },
  };

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const key = el.dataset?.in;
    if (!key || !this.current) return;
    (this.current.input ??= {})[key] = el.value;
  }

  private onKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement;
    if (e.key === 'Enter' && el.dataset?.dlgIn) {
      this.layer.querySelector<HTMLElement>('[data-a="p-ok"]')?.click();
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && el.dataset?.in) {
      const go = this.el.querySelector<HTMLElement>(`[data-enter="${el.dataset.in}"]`);
      if (go) {
        (el as HTMLInputElement).blur();
        go.click();
        this.render(true);
      }
    }
    const sld = el.closest<HTMLElement>('[data-sld]');
    if (sld && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const now = Number(sld.getAttribute('aria-valuenow') ?? 0);
      const v = Math.max(0, Math.min(100, now + (e.key === 'ArrowRight' ? 5 : -5)));
      this.current?.slide?.(sld.dataset.sld!, v, true);
      this.render();
      (this.el.querySelector(`[data-sld="${sld.dataset.sld}"]`) as HTMLElement | null)?.focus();
      e.preventDefault();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    const sld = (e.target as HTMLElement).closest<HTMLElement>('[data-sld]');
    if (!sld || !this.current?.slide) return;
    const key = sld.dataset.sld!;
    const trk = sld.querySelector<HTMLElement>('.trk')!;
    const fill = trk.querySelector<HTMLElement>('i')!;
    const knob = trk.querySelector<HTMLElement>('.knob')!;
    const screen = this.current;
    this.dragging = true;
    sld.classList.add('drag');
    const at = (x: number): number => {
      const r = trk.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((x - r.left) / Math.max(1, r.width)) * 100));
    };
    const move = (ev: PointerEvent, done: boolean): void => {
      const v = at(ev.clientX);
      fill.style.width = knob.style.left = `${v}%`;
      sld.setAttribute('aria-valuenow', String(Math.round(v)));
      screen.slide?.(key, v, done);
      // live outputs next to the slider
      this.el.querySelectorAll<HTMLElement>(`[data-out="${key}"]`).forEach((o) => {
        const f = outFormats[o.dataset.fmt ?? 'pct'];
        if (f) o.textContent = f(v);
      });
    };
    move(e, false);
    const mv = (ev: PointerEvent): void => move(ev, false);
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      sld.classList.remove('drag');
      this.dragging = false;
      move(ev, true);
      this.render();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    e.preventDefault();
  }
}

/** Formatters for live slider outputs (`<span data-out="key" data-fmt="pct">`). Screens add their own. */
export const outFormats: Record<string, (v: number) => string> = {
  pct: (v) => `${Math.round(v)}%`,
};

export const out = (key: string, v: number, f = 'pct'): string =>
  `<span data-out="${esc(key)}" data-fmt="${f}">${esc(outFormats[f]?.(v) ?? Math.round(v))}</span>`;
