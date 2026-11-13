/**
 * "Show cards": after a hand ends, a player whose cards weren't shown at showdown can reveal them to the table.
 * A small v2 pill above the action row, offered until the next hand starts (or until used).
 */
import './v2hud.css';

export class ShowCardsButton {
  readonly el: HTMLButtonElement;
  private onClick: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'v2hud-show';
    b.hidden = true;
    b.textContent = 'Show cards';
    b.addEventListener('click', () => {
      const fn = this.onClick;
      this.hide();
      fn?.();
    });
    parent.append(b);
    this.el = b;
  }

  /** Offers the button (null hides it). */
  offer(onClick: (() => void) | null): void {
    if (!onClick) return this.hide();
    this.onClick = onClick;
    this.el.hidden = false;
  }

  hide(): void {
    this.onClick = null;
    this.el.hidden = true;
  }

  /**
   * Per frame while offered: keep the pill clear of your own seat (plate, status chip such as "Fold", D/SB/BB token)
   * and of the action row. Its CSS spot is above the action row; if that touches your seat it drops just under the
   * seat, and if that runs into the action row it moves beside the seat (right, else left). Client px rects.
   */
  place(own: DOMRect[], avoid: DOMRect[], layer: DOMRect): void {
    if (this.el.hidden) return;
    const s = this.el.style;
    s.left = s.top = s.bottom = s.transform = '';
    if (!own.length) return;
    const gap = 12;
    const near = (r: DOMRect, list: DOMRect[], pad: number) => list.some((o) => r.left - pad < o.right && r.right + pad > o.left && r.top - pad < o.bottom && r.bottom + pad > o.top);
    const box = this.el.getBoundingClientRect();
    if (!near(box, own, gap) && !near(box, avoid, 4)) return;
    const w = box.width;
    const h = box.height;
    const L = Math.min(...own.map((r) => r.left));
    const R = Math.max(...own.map((r) => r.right));
    const T = Math.min(...own.map((r) => r.top));
    const B = Math.max(...own.map((r) => r.bottom));
    const cx = (L + R) / 2;
    const cy = (T + B) / 2;
    const tries: [number, number][] = [
      [cx - w / 2, B + gap], // under the seat
      [R + gap * 1.5, cy - h / 2], // beside it, right
      [L - gap * 1.5 - w, cy - h / 2], // beside it, left
    ];
    for (const [x, y] of tries) {
      const r = new DOMRect(x, y, w, h);
      if (x < layer.left + 4 || x + w > layer.right - 4 || y < layer.top || y + h > layer.bottom) continue;
      if (near(r, own, gap - 1) || near(r, avoid, 4)) continue;
      s.left = `${x - layer.left}px`;
      s.top = `${y - layer.top}px`;
      s.bottom = 'auto';
      s.transform = 'none';
      return;
    }
  }
}
