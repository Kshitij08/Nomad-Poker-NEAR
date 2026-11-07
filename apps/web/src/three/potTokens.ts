import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Texture,
} from 'three';
import data from '../data/pot-tokens.json';
import { Ease, Ticker, ticker, type Linkable } from '../anim/tween';

/**
 * The 3D half of Poker.Game.PotView: token piles that grow with the pot and fly to the winner.
 *
 * - SetPot → UpdateCounts → RestackTokens: a bigger pot adds the *delta* in tokens (largest
 *   denominations first, capped at maxTokens in total, the remainder rounded up with one smallest
 *   token); a smaller pot recounts from scratch. Pile slot k sits at (0, k·spacing, sin((d·31+k)·78.233)·jitter).
 * - AwardTokensTo: every visible token leaves its pool and flies to the seat (DOMove + DOScale to
 *   flyEndScale, both InQuad over flyDuration, delayed flightIndex·flyStagger), then goes back to its
 *   pool inactive with its scale restored. A later SetPot restacks whatever pot remains with fresh tokens.
 *
 * Tokens are Token_N prefabs (tools/extract-unity-tokens.mjs): Unity's built-in plane with the white
 * token base (010.png) and a coin sprite child, both Standard-shader cutout. Unity space throughout.
 */

const BASE = `${import.meta.env.BASE_URL}assets/tokens/`;
const loader = new TextureLoader();
const textures = new Map<string, Texture>();
function texture(file: string): Texture {
  let t = textures.get(file);
  if (!t) {
    t = loader.load(BASE + encodeURIComponent(file));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    textures.set(file, t);
  }
  return t;
}

/** Unity's built-in Plane: 10×10 in XZ, normal +Y. Its UVs run against the axes: u = 0.5 − x/10, v = 0.5 − z/10. */
function unityPlaneGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const p = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
  const uv: number[] = [];
  for (let i = 0; i < 4; i++) uv.push(0.5 - p[i * 3] / 10, 0.5 - p[i * 3 + 2] / 10);
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/** A Unity sprite quad: XY plane, centre pivot, facing −Z, uv (0,0) at bottom-left. */
function spriteGeometry(w: number, h: number): BufferGeometry {
  const g = new BufferGeometry();
  const x = w / 2;
  const y = h / 2;
  g.setAttribute('position', new BufferAttribute(new Float32Array([-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 2, 1, 0, 3, 2]); // Unity winding (clockwise seen from the front, −Z)
  return g;
}

/** Built-in Standard shader, cutout mode (Token.mat / Token_colour.mat); Standard culls back faces. */
function cutoutMaterial(map: Texture, m: { cutoff: number; glossiness: number; metallic: number }): MeshStandardMaterial {
  return new MeshStandardMaterial({ map, alphaTest: m.cutoff, roughness: 1 - m.glossiness, metalness: m.metallic, side: FrontSide });
}

const prefab = data.prefab;
let planeGeo: BufferGeometry | null = null;
let planeMat: MeshStandardMaterial | null = null;
const coinGeos = new Map<string, BufferGeometry>();
const coinMats = new Map<string, MeshStandardMaterial>();

function setLocal(o: Object3D, t: { position: number[]; rotation: number[]; scale: number[] }): void {
  o.position.fromArray(t.position);
  o.quaternion.fromArray(t.rotation);
  o.scale.fromArray(t.scale);
}

class Token implements Linkable {
  readonly root = new Group();
  alive = true;
  constructor(coin: (typeof data.denominations)[number]['coin']) {
    planeGeo ??= unityPlaneGeometry();
    planeMat ??= cutoutMaterial(texture(prefab.plane.texture.file), prefab.plane.material);
    const plane = new Mesh(planeGeo, planeMat);
    plane.name = 'Plane';
    setLocal(plane, prefab.plane);

    let geo = coinGeos.get(coin.file);
    if (!geo) coinGeos.set(coin.file, (geo = spriteGeometry(coin.worldSize[0], coin.worldSize[1])));
    let mat = coinMats.get(coin.file);
    if (!mat) coinMats.set(coin.file, (mat = cutoutMaterial(texture(coin.file), prefab.colour.material)));
    const colour = new Mesh(geo, mat);
    colour.name = 'colour';
    setLocal(colour, prefab.colour);

    plane.add(colour);
    this.root.add(plane);
    setLocal(this.root, prefab.root); // Instantiate keeps the prefab's local rotation/scale; position is restacked
    this.root.name = 'Token';
  }
  get active(): boolean {
    return this.root.visible;
  }
  setActive(v: boolean): void {
    this.root.visible = v;
  }
}

interface Denomination {
  value: number;
  coin: (typeof data.denominations)[number]['coin'];
  parent: Group;
}

export class PotTokens {
  readonly root = new Group();
  private readonly denominations: Denomination[];
  private readonly pool: Token[][];
  private readonly counts: number[];
  private pot = 0;
  private readonly s = data.settings;

  constructor(world: Object3D) {
    this.root.name = data.tokenParents.name;
    this.root.position.fromArray(data.tokenParents.worldPosition);
    world.add(this.root);
    this.denominations = data.denominations.map((d) => {
      const parent = new Group();
      parent.name = d.parent.split('/').pop()!;
      parent.position.fromArray(d.parentLocalPosition);
      this.root.add(parent);
      return { value: d.value, coin: d.coin, parent };
    });
    this.pool = this.denominations.map(() => []);
    this.counts = this.denominations.map(() => 0);
    for (const d of data.denominations) texture(d.coin.file); // warm the textures
    this.setPot(0);
  }

  setPot(pot: number): void {
    this.updateCounts(pot);
    this.pot = pot;
    this.restack();
  }

  /** Flies every visible token to `targetWorld` (Unity world space, e.g. the winning SeatView's position). */
  awardTokensTo(targetWorld: Vector3 | number[]): void {
    const target = Array.isArray(targetWorld) ? new Vector3().fromArray(targetWorld) : targetWorld.clone();
    let flightIndex = 0;
    this.pool.forEach((pool, d) => {
      for (let k = pool.length - 1; k >= 0; k--) {
        const token = pool[k];
        if (!token.alive || !token.active) continue;
        pool.splice(k, 1); // in flight: restack spawns fresh tokens for whatever pot remains
        const parent = this.denominations[d].parent;
        const scale = token.root.scale.clone();
        const from = new Vector3();
        // Only translations above the token, so world → parent-local is a subtraction.
        const local = target.clone().sub(this.root.position).sub(parent.position);
        let started = false;
        const fly = ticker
          .sequence()
          .interval(flightIndex * this.s.flyStagger)
          .append(this.s.flyDuration, () =>
            flightStep(this.s.flyDuration, (e) => {
              if (!started) {
                started = true;
                from.copy(token.root.position);
              }
              token.root.position.lerpVectors(from, local, e);
              token.root.scale.copy(scale).multiplyScalar(1 + (this.s.flyEndScale - 1) * e);
            }),
          )
          .play()
          .setLink(token);
        fly.onComplete(() => {
          token.setActive(false);
          token.root.scale.copy(scale);
          this.pool[d].push(token);
        });
        flightIndex++;
      }
    });
  }

  private restack(): void {
    this.denominations.forEach((den, d) => {
      const pool = this.pool[d];
      const count = this.counts[d];
      for (let k = 0; k < count; k++) {
        if (k === pool.length) {
          const t = new Token(den.coin);
          den.parent.add(t.root);
          pool.push(t);
        }
        const token = pool[k];
        token.setActive(true);
        token.root.position.set(0, k * this.s.tokenSpacing, Math.sin((d * 31 + k) * 78.233) * this.s.tokenJitter);
      }
      for (let k = count; k < pool.length; k++) pool[k].setActive(false);
    });
  }

  private updateCounts(pot: number): void {
    updateTokenCounts(this.counts, this.denominations.map((d) => d.value), this.pot, pot, this.s.maxTokens);
  }

  /** Visible token count per denomination value (for tests / debugging). */
  get visibleCounts(): Record<number, number> {
    const out: Record<number, number> = {};
    this.denominations.forEach((d, i) => (out[d.value] = this.pool[i].filter((t) => t.active).length));
    return out;
  }
}

/**
 * PotView.UpdateCounts + AddChips, in place on `counts` (one entry per denomination value). A bigger pot adds
 * only the delta; a smaller one recounts from scratch; zero clears.
 */
export function updateTokenCounts(counts: number[], values: number[], previousPot: number, pot: number, maxTokens: number): void {
  if (pot <= 0) counts.fill(0);
  else if (pot > previousPot) addChips(counts, values, pot - previousPot, maxTokens);
  else if (pot < previousPot) {
    counts.fill(0);
    addChips(counts, values, pot, maxTokens);
  }
}

function addChips(counts: number[], values: number[], amount: number, maxTokens: number): void {
  const order = values.map((_, i) => i).filter((i) => values[i] > 0);
  order.sort((a, b) => values[b] - values[a]);
  if (order.length === 0) return;
  let total = order.reduce((n, d) => n + counts[d], 0);
  let remaining = amount;
  for (const d of order) {
    const n = Math.min(Math.floor(remaining / values[d]), maxTokens - total);
    counts[d] += n;
    remaining -= n * values[d];
    total += n;
  }
  // Round the leftover up with one smallest-denomination token so a small post still shows a chip.
  if (remaining > 0 && total < maxTokens) counts[order[order.length - 1]]++;
}

/** A sequence step: an InQuad 0→1 tween not registered on the ticker. */
function flightStep(duration: number, update: (t: number) => void) {
  return Ticker.detached(duration, update, Ease.InQuad);
}
