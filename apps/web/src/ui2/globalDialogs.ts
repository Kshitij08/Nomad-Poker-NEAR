/**
 * One dialog system for the whole game. The Nomad host's dialogs (NomadDialogs: message, form, busy, settings) were
 * Unity-styled panels used from ~100 call sites (errors, confirms, wallet, net, the table's Leave and Settings). They
 * now render as v2 dialogs (bottom sheets in portrait) on a fixed layer over everything — the menu, the table, the
 * Unity screens that remain — so every modal in the game looks and behaves the same.
 */
import type { NomadDialogs } from '../menu/dialogs';
import { PokerAudio } from '../menu/audio';
import { esc } from './core';

interface Btn {
  label: string;
  hue: string;
  run: () => void;
}

/** TMP rich text (<size=80%>, <color=…>, <b>, \n) → safe HTML. */
export function richText(s: string): string {
  const keep: string[] = [];
  const marked = String(s ?? '').replace(/<\/?(b|i)>/gi, (m) => {
    keep.push(m.toLowerCase());
    return `\u0000${keep.length - 1}\u0000`;
  });
  const stripped = marked.replace(/<[^>]+>/g, '');
  return esc(stripped)
    .replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)] ?? '')
    .replace(/\n/g, '<br>');
}

class GlobalDialogs {
  private readonly root: HTMLElement;
  private open = false;
  private busy = false;
  private dismissedBusy: string | null = null;
  private onEscape: (() => void) | null = null;
  readonly onClosed: (() => void)[] = [];

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'v2 v2-global';
    this.root.hidden = true;
    document.body.append(this.root);
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains('v2-dim') && !this.busy) this.onEscape?.();
    });
    document.addEventListener(
      'keydown',
      (e) => {
        if (!this.open || e.key !== 'Escape') return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.onEscape?.();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  private show(title: string, body: string, buttons: Btn[], o: { busy?: boolean; wide?: boolean; escape?: () => void } = {}): HTMLElement {
    this.root.innerHTML = `<div class="v2-dim"><div class="v2-dlg${o.wide ? ' wide' : ''}" role="${o.busy ? 'status' : 'dialog'}" aria-modal="true" aria-label="${esc(title)}"><div class="v2-dh">${esc(title)}</div><div class="v2-db">${body}</div><div class="v2-df"></div></div></div>`;
    const foot = this.root.querySelector('.v2-df')!;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = `v2-b ${b.hue}`;
      el.textContent = b.label;
      el.addEventListener('click', () => b.run());
      foot.append(el);
    }
    this.root.hidden = false;
    this.open = true;
    this.busy = !!o.busy;
    this.onEscape = o.escape ?? null;
    return this.root;
  }

  close(): void {
    if (!this.open) return;
    this.root.hidden = true;
    this.root.innerHTML = '';
    this.open = false;
    this.busy = false;
    this.onEscape = null;
    for (const fn of this.onClosed) fn();
  }

  message(title: string, body: string, ok: string | null = 'OK', onOk?: () => void, cancel: string | null = null, onCancel?: () => void, placeholder: string | null = null, onInput?: (v: string) => void, value: string | null = null, keepBusy = false): void {
    if (!keepBusy) this.dismissedBusy = null;
    const input = placeholder !== null ? `<input class="v2-field v2-gd-in" maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value ?? '')}" autocomplete="off" spellcheck="false">` : '';
    let field: HTMLInputElement | null = null;
    const okFn = (): void => {
      const v = field?.value;
      this.close();
      onOk?.();
      if (v !== undefined) onInput?.(v.trim());
    };
    const cancelFn = (): void => {
      this.close();
      onCancel?.();
    };
    const buttons: Btn[] = [];
    if (cancel !== null) buttons.push({ label: cancel, hue: 'ghost', run: cancelFn });
    if (ok !== null) buttons.push({ label: ok, hue: /sign out|leave|delete|remove|stop|disconnect/i.test(ok) ? 'red' : 'gold', run: okFn });
    const root = this.show(title, `<p class="v2-gd-p">${richText(body)}</p>${input}`, buttons, { escape: cancel !== null || ok === null ? cancelFn : okFn });
    field = root.querySelector('.v2-gd-in');
    if (field) {
      field.addEventListener('keydown', (e) => e.key === 'Enter' && okFn());
      field.focus();
      field.select();
    }
  }

  form(title: string, placeholders: string[], secret: boolean[], ok: string, onOk: (values: string[]) => void, cancel = 'Cancel'): void {
    const body = placeholders.map((p, i) => `<input class="v2-field v2-gd-in" type="${secret[i] ? 'password' : /email/i.test(p) ? 'email' : 'text'}" placeholder="${esc(p)}" autocomplete="off" spellcheck="false">`).join('');
    let fields: HTMLInputElement[] = [];
    const okFn = (): void => {
      const values = fields.map((f) => f.value.trim());
      this.close();
      onOk(values);
    };
    const root = this.show(title, `<div class="v2-col">${body}</div>`, [
      { label: cancel, hue: 'ghost', run: () => this.close() },
      { label: ok, hue: 'gold', run: okFn },
    ], { escape: () => this.close() });
    fields = [...root.querySelectorAll<HTMLInputElement>('.v2-gd-in')];
    fields.forEach((f) => f.addEventListener('keydown', (e) => e.key === 'Enter' && okFn()));
    fields[0]?.focus();
  }

  busyNote(title: string, text: string): void {
    if (this.open && !this.busy) return;
    if (this.dismissedBusy === title) return;
    this.show(title, `<div class="v2-row v2-gd-busy"><i class="v2-spin" aria-hidden="true"></i><p class="v2-gd-p">${richText(text)}</p></div>`, [
      { label: 'Hide', hue: 'ghost', run: () => {
        this.dismissedBusy = title;
        this.close();
      } },
    ], { busy: true, escape: () => {
      this.dismissedBusy = title;
      this.close();
    } });
  }

  closeBusy(): void {
    if (this.busy) this.close();
  }

  /** Settings at the table (and anywhere the host opens them): Music / Sound effects, account rows, Leave table. */
  settings(leaveTable?: () => void, account: [string, () => void][] = []): void {
    const vol = (label: string, key: 'music' | 'sfx', v: number) =>
      `<div class="v2-row v2-set-row"><span class="v2-set-l">${label}</span><input class="v2-gd-range" type="range" min="0" max="100" step="1" value="${Math.round(v * 100)}" style="--fill:${Math.round(v * 100)}%" data-vol="${key}" aria-label="${label}"><b class="v2-set-v" data-vol-out="${key}">${Math.round(v * 100)}%</b></div>`;
    const rows = account.length
      ? `<div class="v2-row v2-set-row v2-wrap"><span class="v2-set-l">Account</span>${account.map(([l], i) => `<button class="v2-b ${/sign out|disconnect/i.test(l) ? 'red' : 'blue'} sm" data-acc="${i}">${esc(l)}</button>`).join('')}</div>`
      : '';
    const buttons: Btn[] = [];
    if (leaveTable) buttons.push({ label: 'Leave table', hue: 'red', run: () => {
      this.close();
      leaveTable();
    } });
    buttons.push({ label: 'Close', hue: leaveTable ? 'ghost' : 'gold', run: () => this.close() });
    const root = this.show('Settings', vol('Music', 'music', PokerAudio.musicVolume) + vol('Sound effects', 'sfx', PokerAudio.sfxVolume) + rows, buttons, { wide: true, escape: () => this.close() });
    root.querySelectorAll<HTMLInputElement>('[data-vol]').forEach((r) =>
      r.addEventListener('input', () => {
        const v = Number(r.value) / 100;
        if (r.dataset.vol === 'music') PokerAudio.musicVolume = v;
        else PokerAudio.sfxVolume = v;
        r.style.setProperty('--fill', `${r.value}%`);
        const o = root.querySelector(`[data-vol-out="${r.dataset.vol}"]`);
        if (o) o.textContent = `${r.value}%`;
      }),
    );
    root.querySelectorAll<HTMLElement>('[data-acc]').forEach((b) =>
      b.addEventListener('click', () => {
        this.close();
        account[Number(b.dataset.acc)]?.[1]();
      }),
    );
  }
}

let instance: GlobalDialogs | null = null;
export function globalDialogs(): GlobalDialogs {
  return (instance ??= new GlobalDialogs());
}

/** Routes the host's dialog box API into the v2 dialogs. Panels built from Unity parts (panel / window) stay. */
export function takeOverDialogs(d: NomadDialogs): void {
  const g = globalDialogs();
  const dd = d as unknown as Record<string, unknown>;
  dd.message = (...a: Parameters<NomadDialogs['message']>) => g.message(...a);
  dd.form = (...a: Parameters<NomadDialogs['form']>) => g.form(...a);
  dd.busy = (title: string, text: string) => g.busyNote(title, text);
  dd.closeBusy = () => g.closeBusy();
  dd.settings = (leave?: () => void, account?: [string, () => void][]) => g.settings(leave, account ?? []);
  const origClose = d.close.bind(d);
  dd.close = () => {
    if (g.isOpen) g.close();
    else origClose();
  };
  const origOpen = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(d), 'isOpen')?.get?.bind(d);
  Object.defineProperty(d, 'isOpen', { get: () => g.isOpen || !!origOpen?.(), configurable: true });
  g.onClosed.push(() => d.onClosed.forEach((fn) => fn()));
}
