/**
 * Lightweight sparkle particles over a uGUI area. Port of Game/NomadUI/NomadSparkles.cs: pooled images that pop,
 * drift, spin and fade. Burst() for one-off effects, setAmbient() for a gentle twinkle. Positions are in the sparkle
 * layer's centred space (y up), like the C#.
 */
import { assetUrl, type RGBA, type SpriteData, type UNode } from '../../hud/unityUi';
import { clamp01, lerp, smoothStep, type CoroutineHost } from '../ui/coroutines';

interface Particle {
  el: HTMLDivElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  rot: number;
  spin: number;
  col: RGBA;
  on: boolean;
}

export interface Rect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b));

export class NomadSparkles {
  private readonly layer = document.createElement('div');
  private readonly pool: Particle[] = [];
  private ambient = false;
  private ambientRect: Rect = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  private ambientRate = 0;
  private ambientAcc = 0;
  private readonly off: () => void;

  constructor(
    private readonly area: UNode,
    sprite: SpriteData | null,
    host: CoroutineHost,
    poolSize = 80,
    private readonly palette: RGBA[] = [
      { r: 1, g: 0.9, b: 0.55, a: 1 }, { r: 1, g: 0.78, b: 0.3, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, { r: 0.75, g: 0.85, b: 1, a: 1 },
    ],
  ) {
    const s = this.layer.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.right = '0';
    s.bottom = '0';
    s.pointerEvents = 'none';
    this.layer.className = 'rt-sparkles';
    area.el.append(this.layer);
    const url = sprite?.file ? `url("${assetUrl(sprite.file)}")` : '';
    if (sprite?.file) this.prepareTints(assetUrl(sprite.file));
    for (let i = 0; i < poolSize; i++) {
      const el = document.createElement('div');
      const st = el.style;
      st.position = 'absolute';
      st.left = '50%';
      st.top = '50%';
      st.display = 'none';
      st.pointerEvents = 'none';
      st.backgroundImage = url;
      st.backgroundSize = 'contain';
      st.backgroundRepeat = 'no-repeat';
      st.backgroundPosition = 'center';
      st.willChange = 'transform, opacity';
      this.layer.append(el);
      this.pool.push({ el, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0, size: 0, rot: 0, spin: 0, col: { r: 1, g: 1, b: 1, a: 1 }, on: false });
    }
    this.off = host.onUpdate(() => this.update(host.dt));
  }

  /** Image.color multiplies the sprite: one tinted copy per palette colour (4), made once the sprite loads. */
  private readonly tinted = new Map<RGBA, string>();
  private prepareTints(src: string): void {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const g = cv.getContext('2d');
      if (!g) return;
      for (const c of this.palette) {
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, cv.width, cv.height);
        const d = px.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = d[i]! * c.r;
          d[i + 1] = d[i + 1]! * c.g;
          d[i + 2] = d[i + 2]! * c.b;
        }
        g.putImageData(px, 0, 0);
        this.tinted.set(c, `url("${cv.toDataURL('image/png')}")`);
      }
    };
    img.src = src;
  }

  /** Centre of a node, in the sparkle layer's centred space (canvas units, y up). */
  centerOf(node: UNode): { x: number; y: number } {
    const a = this.area.el.getBoundingClientRect();
    const r = node.el.getBoundingClientRect();
    const sx = this.area.w ? a.width / this.area.w : 1;
    const sy = this.area.h ? a.height / this.area.h : 1;
    return { x: (r.left + r.width / 2 - (a.left + a.width / 2)) / (sx || 1), y: -(r.top + r.height / 2 - (a.top + a.height / 2)) / (sy || 1) };
  }

  /** Canvas-unit size of a node's rect. */
  sizeOf(node: UNode): { w: number; h: number } {
    return { w: node.w, h: node.h };
  }

  burst(center: { x: number; y: number }, count: number, radius: number, speed: number, size: number): void {
    this.layer.parentElement?.append(this.layer); // SetAsLastSibling
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const d = rand(0, radius);
      const sp = speed * rand(0.35, 1);
      this.spawn(center.x + dx * d, center.y + dy * d, dx * sp, dy * sp + speed * 0.15, rand(0.55, 1.1), size * rand(0.45, 1.1));
    }
  }

  /** Gentle twinkles inside `rect` (layer space) at `perSecond`, until switched off. */
  setAmbient(on: boolean, rect: Rect | null, perSecond: number): void {
    this.ambient = on;
    if (rect) this.ambientRect = rect;
    this.ambientRate = perSecond;
    if (on) this.layer.parentElement?.append(this.layer);
  }

  dispose(): void {
    this.off();
    this.layer.remove();
  }

  /** OnDisable: everything off. */
  clear(): void {
    this.ambient = false;
    for (const p of this.pool) {
      p.on = false;
      p.el.style.display = 'none';
    }
  }

  private spawn(x: number, y: number, vx: number, vy: number, life: number, size: number): void {
    const p = this.pool.find((q) => !q.on);
    if (!p) return;
    p.on = true;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = 0;
    p.max = life;
    p.size = size;
    p.rot = rand(0, 360);
    p.spin = rand(-220, 220);
    p.col = this.palette.length ? this.palette[randInt(0, this.palette.length)]! : { r: 1, g: 1, b: 1, a: 1 };
    p.el.style.display = '';
    this.apply(p);
  }

  private update(dt: number): void {
    if (this.ambient) {
      this.ambientAcc += this.ambientRate * dt;
      while (this.ambientAcc >= 1) {
        this.ambientAcc -= 1;
        const r = this.ambientRect;
        this.spawn(rand(r.xMin, r.xMax), rand(r.yMin, r.yMax), rand(-15, 15), rand(10, 40), rand(0.45, 0.8), rand(14, 30));
      }
    }
    for (const p of this.pool) {
      if (!p.on) continue;
      p.life += dt;
      if (p.life >= p.max) {
        p.on = false;
        p.el.style.display = 'none';
        continue;
      }
      const damp = Math.pow(0.18, dt);
      p.vx *= damp;
      p.vy *= damp;
      p.vy -= 60 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      this.apply(p);
    }
  }

  private apply(p: Particle): void {
    const t = p.max > 0 ? p.life / p.max : 1;
    const pop = t < 0.2 ? smoothStep(0, 1.15, t / 0.2) : lerp(1.15, 0.2, (t - 0.2) / 0.8);
    const alpha = t < 0.15 ? t / 0.15 : 1 - smoothStep(0, 1, (t - 0.5) / 0.5);
    const s = p.el.style;
    s.width = `${p.size}px`;
    s.height = `${p.size}px`;
    s.marginLeft = `${-p.size / 2}px`;
    s.marginTop = `${-p.size / 2}px`;
    s.transform = `translate(${p.x}px, ${-p.y}px) rotate(${-p.rot}deg) scale(${Math.max(0, pop)})`;
    s.opacity = String(clamp01(alpha) * p.col.a);
    const url = this.tinted.get(p.col);
    if (url && s.backgroundImage !== url) s.backgroundImage = url;
  }
}
