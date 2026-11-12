/** Small DOM helpers for the Redesign v2 pieces on the live table (styles in ./table.css, under .v2t). */
import './table.css';

export function v2tEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

/** A v2 button (hue: gold | blue | ghost). */
export function v2tButton(parent: HTMLElement, label: string, hue: 'gold' | 'blue' | 'ghost', onClick: () => void, cls = ''): HTMLButtonElement {
  const b = v2tEl('button', `v2t-b ${hue} ${cls}`, parent, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** The .v2t root layer over the table. */
export function v2tLayer(parent: HTMLElement, z: number, cls = ''): HTMLElement {
  const root = v2tEl('div', `v2t ${cls}`, parent);
  root.style.zIndex = String(z);
  return root;
}

/** Text with Unity-ish rich tags (<b>, <color=#hex>) turned into safe HTML. */
export function richToHtml(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/&lt;b&gt;/g, '<b>')
    .replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;color=(#[0-9a-fA-F]{3,8})&gt;/g, '<span style="color:$1">')
    .replace(/&lt;\/color&gt;/g, '</span>')
    .replace(/&lt;\/?size[^&]*&gt;/g, '');
}
