import {
  AlwaysDepth,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
  type Camera,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import type { LensDistortionRenderer } from './lensDistortion';
import { worldCanvasSpace, worldCanvasZoom } from '../layout/canvasSpace';

/**
 * Per-pixel depth sorting between the DOM HUD's world-space canvases and the 3D scene, like Unity.
 *
 * Unity (built-in pipeline, Test.unity): the seat HUDs (`Name_Canvas*`, sort order 1), the pot (`Pot_UI`, 0) and
 * the felt (`Table_Canvas`, −1) are World Space canvases drawn by the main camera with UI/Default and TMP SDF:
 * Transparent queue, ZWrite Off, ZTest [unity_GUIZTestMode] = LEqual for world-space canvases. The cards (Standard,
 * opaque, queue 2000, ZWrite on) and the pot tokens (Standard cutout, queue 2450, ZWrite on) are drawn first. So a
 * card above a canvas plane hides the canvas there, and a card below it is covered by the canvas's opaque pixels.
 * The Screen Space Overlay `Canvas` (betting / confirm panels) is always on top.
 *
 * Web: the base WebGL canvas (everything) sits under the DOM world layer, so where the HUD is transparent the cards
 * show through. This class renders a second pass into the same context — only opaque objects, after a depth
 * pre-pass that writes depth 0 everywhere except over each visible HUD canvas's content rect, where it writes the
 * canvas plane's depth — and copies it to an overlay 2D canvas between the DOM world layer and the screen layer.
 * Opaque pixels in front of a HUD plane therefore draw over the DOM; those behind it are discarded (the base
 * canvas still shows them under the transparent parts of the DOM). Both passes go through the river slam's lens
 * distortion when it is active, so the overlay stays registered with the base image.
 */

/** What a world-space HUD canvas exposes (WorldCanvas satisfies it). */
export interface HudPlaneSource {
  readonly root: HudNode;
  /** Canvas pivot in Unity world space. */
  readonly position: readonly [number, number, number];
  /** World units per canvas unit. */
  readonly unitScale: number;
  readonly shaker: { readonly angle: number; readonly axis: readonly [number, number, number] };
  readonly eulerOffset: { x: number; y: number; z: number } | null;
}

/** The subset of UNode the content bounds need. */
export interface HudNode {
  readonly children: readonly HudNode[];
  readonly activeSelf: boolean;
  readonly anchorMin: readonly [number, number];
  readonly anchorMax: readonly [number, number];
  readonly anchoredPosition: readonly [number, number];
  readonly sizeDelta: readonly [number, number];
  readonly pivot: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  readonly groupAlpha: number;
  readonly image: unknown;
  readonly text: unknown;
}

export interface HudPlaneEntry {
  canvas: HudPlaneSource;
  visible: boolean;
}

/** Layer the overlay pass sees: every opaque renderable plus the lights. */
export const HUD_OCCLUDER_LAYER = 31;

export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/**
 * Union of the rects of every active graphic (image or text) under `root`, in canvas units around the canvas pivot
 * (y up) — the area where the canvas can have pixels. Follows the RectTransform layout (anchors, pivot,
 * anchoredPosition, sizeDelta) with each node's Z rotation and scale. Returns null when nothing is drawn.
 */
export function hudContentBounds(root: HudNode): Bounds | null {
  const b: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  // 2D affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
  const visit = (n: HudNode, m: number[], w: number, h: number, pivot: readonly [number, number]) => {
    if (!n.activeSelf || n.groupAlpha <= 0) return;
    if (n.image || n.text) {
      const x0 = -pivot[0] * w;
      const y0 = -pivot[1] * h;
      for (const [x, y] of [
        [x0, y0],
        [x0 + w, y0],
        [x0, y0 + h],
        [x0 + w, y0 + h],
      ]) {
        const px = m[0] * x + m[2] * y + m[4];
        const py = m[1] * x + m[3] * y + m[5];
        if (px < b[0]) b[0] = px;
        if (py < b[1]) b[1] = py;
        if (px > b[2]) b[2] = px;
        if (py > b[3]) b[3] = py;
      }
    }
    for (const c of n.children) {
      const cw = (c.anchorMax[0] - c.anchorMin[0]) * w + c.sizeDelta[0];
      const ch = (c.anchorMax[1] - c.anchorMin[1]) * h + c.sizeDelta[1];
      // Child pivot in this node's local space (rect min = −pivot·size).
      const px = -pivot[0] * w + (c.anchorMin[0] + (c.anchorMax[0] - c.anchorMin[0]) * c.pivot[0]) * w + c.anchoredPosition[0];
      const py = -pivot[1] * h + (c.anchorMin[1] + (c.anchorMax[1] - c.anchorMin[1]) * c.pivot[1]) * h + c.anchoredPosition[1];
      const r = (c.rotation * Math.PI) / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      const la = cos * c.scale[0];
      const lb = sin * c.scale[0];
      const lc = -sin * c.scale[1];
      const ld = cos * c.scale[1];
      visit(
        c,
        [
          m[0] * la + m[2] * lb,
          m[1] * la + m[3] * lb,
          m[0] * lc + m[2] * ld,
          m[1] * lc + m[3] * ld,
          m[0] * px + m[2] * py + m[4],
          m[1] * px + m[3] * py + m[5],
        ],
        cw,
        ch,
        c.pivot,
      );
    }
  };
  // The root is centred on the canvas pivot (WorldCanvas places its centre at `position`).
  visit(root, [1, 0, 0, 1, 0, 0], root.sizeDelta[0], root.sizeDelta[1], [0.5, 0.5]);
  return b[0] <= b[2] ? b : null;
}

const DEG = Math.PI / 180;
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _m = new Matrix4();
const _basis = new Matrix4();

/**
 * three.js world matrix of a unit quad (PlaneGeometry 1×1) covering `bounds` on the canvas plane, with the canvas's
 * shake rotations about its pivot — the same composition WorldCanvas applies to the DOM (CSS: matrix · shaker ·
 * euler offset), converted from CSS's y-down frame to the canvas's y-up frame.
 */
export function hudQuadMatrix(c: HudPlaneSource, bounds: Bounds, out: Matrix4): Matrix4 {
  const s = c.unitScale;
  const [px, py, pz] = worldCanvasSpace.positions.get(c) ?? c.position;
  // Canvas local (x right, y = screen up = Unity +z, z toward the camera) → three world (Unity z negated).
  _basis.set(s, 0, 0, px, 0, 0, s, py, 0, -s, 0, -pz, 0, 0, 0, 1);
  if (worldCanvasSpace.upright) {
    // Portrait (layout/portraitTable.ts): the Unity root is turned and scaled, and WorldCanvas draws the canvas upright
    // at hudScale × the projected size — the same plane, screen-aligned, around the moved pivot.
    const p = _v.set(px, py, pz).applyMatrix4(worldCanvasSpace.matrix);
    const k = s * worldCanvasZoom() * (worldCanvasSpace.scales.get(c) ?? worldCanvasSpace.hudScale);
    _basis.set(k, 0, 0, p.x, 0, 0, k, p.y, 0, -k, 0, p.z, 0, 0, 0, 1);
  }
  out.copy(_basis);
  const a = c.shaker.angle;
  if (a) {
    const [ax, ay, az] = c.shaker.axis;
    // CSS rotate3d(ax, −ay, −az, a) in y-down space = rotation about (−ax, −ay, az) by a in y-up space.
    _v.set(-ax, -ay, az).normalize();
    out.multiply(_m.makeRotationFromQuaternion(_q.setFromAxisAngle(_v, a * DEG)));
  }
  const eo = c.eulerOffset;
  if (eo && (eo.x || eo.y || eo.z)) {
    // CSS rotateY(−y) rotateX(x) rotateZ(z) (y down) = Ry(−y)·Rx(−x)·Rz(−z) (y up).
    _q.setFromAxisAngle(_v.set(0, 1, 0), -eo.y * DEG);
    _q.multiply(_q2.setFromAxisAngle(_v.set(1, 0, 0), -eo.x * DEG));
    _q.multiply(_q2.setFromAxisAngle(_v.set(0, 0, 1), -eo.z * DEG));
    out.multiply(_m.makeRotationFromQuaternion(_q));
  }
  const w = Math.max(1e-3, bounds[2] - bounds[0]);
  const h = Math.max(1e-3, bounds[3] - bounds[1]);
  _m.makeScale(w, h, 1).setPosition((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 0);
  return out.multiply(_m);
}

/** True for a visible mesh/sprite/etc. whose materials are all opaque (ZWrite on in Unity terms). */
function isOpaqueRenderable(o: Object3D): boolean | null {
  const mat = (o as Object3D & { material?: { transparent: boolean; visible: boolean } | { transparent: boolean; visible: boolean }[] }).material;
  if (!mat) return null; // not a renderable (group, light, camera)
  const mats = Array.isArray(mat) ? mat : [mat];
  let any = false;
  for (const m of mats) {
    if (!m.visible) continue;
    if (m.transparent) return false;
    any = true;
  }
  return any;
}

export class HudDepthCompositor {
  readonly overlay: HTMLCanvasElement;
  /** Set false to disable the overlay pass (debug: `__poker.stage.hudDepth.enabled = false`). */
  enabled = true;
  /** Last frame's overlay cost in ms (CPU side: mark + pre-pass + opaque pass + copy). */
  lastMs = 0;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly maskScene = new Scene();
  private readonly quads: Mesh[] = [];
  private readonly quadMaterial = new MeshBasicMaterial({ colorWrite: false, depthFunc: AlwaysDepth, side: DoubleSide });
  private readonly quadGeometry = new PlaneGeometry(1, 1);
  private overlayEmpty = true;
  private readonly clearColor = new Color();

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly planes: () => HudPlaneEntry[],
  ) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'hud-depth-overlay';
    Object.assign(this.overlay.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      pointerEvents: 'none',
    });
    this.ctx = this.overlay.getContext('2d')!;

    // Depth 0 everywhere first (NDC z = −1): nothing outside a HUD rect reaches the overlay.
    const near = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        vertexShader: 'void main() { gl_Position = vec4(position.xy, -1.0, 1.0); }',
        fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
        colorWrite: false,
        depthFunc: AlwaysDepth,
      }),
    );
    near.frustumCulled = false;
    near.renderOrder = -1000;
    this.maskScene.add(near);
  }

  private quad(i: number): Mesh {
    let q = this.quads[i];
    if (!q) {
      q = new Mesh(this.quadGeometry, this.quadMaterial);
      q.matrixAutoUpdate = false;
      q.matrixWorldAutoUpdate = false;
      q.frustumCulled = false;
      this.maskScene.add(q);
      this.quads[i] = q;
    }
    return q;
  }

  /** Base pass (the whole scene, under the DOM), then the overlay pass. Call instead of `lens.render`. */
  render(scene: Scene, camera: Camera, lens: LensDistortionRenderer): void {
    if (this.enabled) this.renderOverlay(scene, camera, lens);
    else this.clearOverlay();
    lens.render(scene, camera);
  }

  private clearOverlay(): void {
    if (this.overlayEmpty) return;
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.overlayEmpty = true;
  }

  private renderOverlay(scene: Scene, camera: Camera, lens: LensDistortionRenderer): void {
    const t0 = performance.now();
    const gl = this.renderer.domElement;
    if (this.overlay.width !== gl.width || this.overlay.height !== gl.height) {
      this.overlay.width = gl.width;
      this.overlay.height = gl.height;
      this.overlayEmpty = true;
    }

    // HUD planes, far to near (the pot lies lower than the seats), so the nearest wins where rects overlap.
    const entries = this.planes()
      .filter((e) => e.visible)
      .sort((a, b) => a.canvas.position[1] - b.canvas.position[1]);
    let n = 0;
    for (const e of entries) {
      const bounds = hudContentBounds(e.canvas.root);
      if (!bounds) continue;
      const q = this.quad(n);
      hudQuadMatrix(e.canvas, bounds, q.matrixWorld);
      q.renderOrder = n;
      q.visible = true;
      n++;
    }
    for (let i = n; i < this.quads.length; i++) this.quads[i].visible = false;

    // Tag what the overlay pass sees: opaque renderables and the lights.
    let occluders = 0;
    if (n > 0) {
      scene.traverse((o) => {
        const opaque = isOpaqueRenderable(o);
        if (opaque === null || opaque) o.layers.enable(HUD_OCCLUDER_LAYER);
        else o.layers.disable(HUD_OCCLUDER_LAYER);
        if (opaque) occluders++;
      });
    }
    if (n === 0 || occluders === 0) {
      this.clearOverlay();
      this.lastMs = performance.now() - t0;
      return;
    }

    const r = this.renderer;
    const background = scene.background;
    const layerMask = camera.layers.mask;
    const autoClear = r.autoClear;
    r.getClearColor(this.clearColor);
    const clearAlpha = r.getClearAlpha();
    scene.background = null;
    r.setClearColor(0x000000, 0);
    try {
      lens.renderWith(() => {
        r.autoClear = true;
        r.render(this.maskScene, camera);
        r.autoClear = false;
        camera.layers.set(HUD_OCCLUDER_LAYER);
        r.render(scene, camera);
        camera.layers.mask = layerMask;
        r.autoClear = true;
      });
      this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      this.ctx.drawImage(gl, 0, 0);
      this.overlayEmpty = false;
    } finally {
      camera.layers.mask = layerMask;
      r.autoClear = autoClear;
      scene.background = background;
      r.setClearColor(this.clearColor, clearAlpha);
    }
    this.lastMs = performance.now() - t0;
  }
}
