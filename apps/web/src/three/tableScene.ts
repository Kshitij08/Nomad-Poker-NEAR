import {
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from 'three';
import sceneData from '../data/unity-scene.json';
import slotAnims from '../data/slot-anims.json';
import { ClipPlayer, type ClipCurve, type ClipData } from '../anim/clipPlayer';
import { UnitySpline, type SplineData } from '../anim/unitySpline';
import { applyUnityCameraPose, createUnityRoot } from './unitySpace';
import { CardModelVisual } from './cardModel';
import type { CommunitySlot } from '../table/splineCardDealer';
import type { CardFace } from '../table/cardView';

/**
 * Builds the table from the data extracted out of Assets/Test/Test.unity: camera, light, the felt
 * (a world-space canvas image), each seat's two deal splines, and the five Animator-driven community
 * slots. Everything sits under the Unity-space root (see unitySpace.ts).
 */

type Arr3 = number[];
type RawKnot = { position: Arr3; tangentIn: Arr3; tangentOut: Arr3; rotation: number[] };
type RawSpline = { name: string; closed: boolean; knots: RawKnot[]; worldMatrix: number[] };

const v3 = (a: Arr3) => ({ x: a[0], y: a[1], z: a[2] });

export function splineFromData(raw: RawSpline): UnitySpline {
  const data: SplineData = {
    name: raw.name,
    closed: raw.closed,
    worldMatrix: raw.worldMatrix,
    knots: raw.knots.map((k) => ({
      position: v3(k.position),
      tangentIn: v3(k.tangentIn),
      tangentOut: v3(k.tangentOut),
      rotation: { x: k.rotation[0], y: k.rotation[1], z: k.rotation[2], w: k.rotation[3] },
    })),
  };
  return new UnitySpline(data);
}

// ---- Community slots ----------------------------------------------------------------------------

type HNode = {
  name: string;
  active?: boolean;
  localPosition: number[];
  localRotation?: number[];
  localEuler?: number[];
  localScale: number[];
  children?: HNode[];
};

function buildHierarchy(n: HNode): Object3D {
  const o = new Group();
  o.name = n.name;
  o.position.fromArray(n.localPosition);
  if (n.localRotation) o.quaternion.fromArray(n.localRotation);
  else if (n.localEuler) {
    const d = Math.PI / 180;
    o.rotation.set(n.localEuler[0] * d, n.localEuler[1] * d, n.localEuler[2] * d, 'YXZ');
  }
  o.scale.fromArray(n.localScale);
  o.visible = n.active !== false;
  for (const c of n.children ?? []) o.add(buildHierarchy(c));
  return o;
}

function findPath(root: Object3D, path: string): Object3D | null {
  let node: Object3D | undefined = root;
  for (const name of path.split('/')) {
    node = node?.children.find((c) => c.name === name);
    if (!node) return null;
  }
  return node ?? null;
}

type RawKey = { time: number; value: number | number[]; inSlope: number | number[]; outSlope: number | number[]; weightedMode?: number; inWeight?: number | number[]; outWeight?: number | number[] };
type RawCurve = { path: string; attribute: string; keys: RawKey[] };
type RawClip = { name: string; length: number; loopTime: boolean; curves: Record<string, RawCurve[]> };

const num = (x: number | number[] | undefined, fallback = 0) => (typeof x === 'number' ? x : fallback);

/** The per-component editor curves carry the same data the runtime vector curves play. */
function toClip(raw: RawClip): ClipData {
  const curves: ClipCurve[] = (raw.curves.m_EditorCurves ?? [])
    .filter((c) => /^(m_LocalPosition|localEulerAnglesRaw|m_LocalScale|m_LocalRotation)\.[xyzw]$|^m_IsActive$/.test(c.attribute))
    .map((c) => ({
      path: c.path,
      attribute: c.attribute,
      keyframes: c.keys.map((k) => ({
        time: k.time,
        value: num(k.value),
        inSlope: num(k.inSlope, Infinity),
        outSlope: num(k.outSlope, Infinity),
        weightedMode: k.weightedMode ?? 0,
        inWeight: num(k.inWeight, 1 / 3),
        outWeight: num(k.outWeight, 1 / 3),
      })),
    }));
  return { name: raw.name, length: raw.length, loop: raw.loopTime, curves };
}

const clips = slotAnims.clips as unknown as Record<string, RawClip>;

class AnimatedSlot implements CommunitySlot {
  readonly player: ClipPlayer;
  private readonly reveal: ClipData;
  private readonly withdrawal: ClipData;
  private readonly card: CardModelVisual;
  private readonly defaults: { o: Object3D; p: Vector3; q: Quaternion; s: Vector3; v: boolean }[] = [];
  private isActive = false;

  constructor(
    readonly root: Object3D,
    index: number,
    meshPath: string,
  ) {
    const n = String(index + 1).padStart(2, '0');
    this.reveal = toClip(clips[`Slot_${n}`]);
    this.withdrawal = toClip(clips[`Slot_${n}_Withdrawal`]);
    this.player = new ClipPlayer(root);

    // The slot's own mesh node (one of 52 named after a card; only one is active) gets the card mesh.
    const relative = meshPath.split('/').slice(1).join('/');
    const meshNode = findPath(root, relative)!;
    meshNode.visible = true;
    this.card = new CardModelVisual(meshNode);

    // Write Defaults: anything either clip animates resets to its scene value when a state starts.
    const paths = new Set([...this.reveal.curves, ...this.withdrawal.curves].map((c) => c.path));
    for (const p of paths) {
      const o = p ? findPath(root, p) : root;
      if (o) this.defaults.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible });
    }
    root.visible = false;
  }

  get active(): boolean {
    return this.isActive;
  }

  private restoreDefaults(): void {
    for (const d of this.defaults) {
      d.o.position.copy(d.p);
      d.o.quaternion.copy(d.q);
      d.o.scale.copy(d.s);
      d.o.visible = d.v;
    }
  }

  activate(): void {
    this.isActive = true;
    this.root.visible = true;
    this.restoreDefaults();
    this.player.play(this.reveal, 0);
  }

  deactivate(): void {
    this.isActive = false;
    this.root.visible = false;
    this.player.stop();
    this.restoreDefaults();
  }

  playWithdrawal(): void {
    this.restoreDefaults();
    this.player.play(this.withdrawal, 0);
  }

  setFace(card: CardFace): void {
    this.card.setFace(card);
  }

  refreshBack(): void {
    this.card.refreshBack();
  }
}

// ---- Table ------------------------------------------------------------------------------------

export interface TableScene {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Unity-space root (mirrored on Z). */
  world: Group;
  /** Engine-seat order: [card0, card1] splines per seat. */
  seatSplines: [UnitySpline, UnitySpline][];
  slots: AnimatedSlot[];
  dealer: { dealSpeed: number; holeStagger: number };
  cardOptions: { faceUpLocalEuler: { x: number; y: number; z: number }; faceDownLocalEuler: { x: number; y: number; z: number } };
  update(dt: number): void;
}

export function buildTableScene(): TableScene {
  const s = sceneData;
  const scene = new Scene();
  const bg = s.camera.backgroundColor;
  scene.background = new Color().setRGB(bg[0], bg[1], bg[2], SRGBColorSpace);

  const world = createUnityRoot();
  scene.add(world);

  // Camera (no Cinemachine; MoreMountains shakers move it around a rest pose).
  const cam = s.camera;
  const camera = new PerspectiveCamera(cam.fieldOfView, 16 / 9, cam.near, cam.far);
  const cq = cam.worldRotation;
  applyUnityCameraPose(camera, v3(cam.worldPosition), { x: cq[0], y: cq[1], z: cq[2], w: cq[3] });

  // Lighting: the one active directional light plus Unity's default-skybox ambient (approximated).
  for (const l of s.table.lights) {
    if (!l.activeInHierarchy || !l.enabled || l.typeName !== 'Directional') continue;
    const light = new DirectionalLight(new Color().setRGB(l.color[0], l.color[1], l.color[2], SRGBColorSpace), l.intensity * Math.PI); // three.js Lambert divides by PI, Unity's does not
    const d = l.direction; // Unity world, light travels along this
    light.position.set(-d[0] * 20, -d[1] * 20, d[2] * 20); // into three space (z flipped)
    light.target.position.set(0, 0, 0);
    scene.add(light, light.target);
  }
  scene.add(new HemisphereLight(0xc4d2e6, 0x4a4238, 0.9));
  scene.add(new AmbientLight(0xffffff, 0.15));

  // Felt: Board.png on the world-space Table_Canvas (unlit UI image).
  const img = s.table.tableCanvas.images.find((i) => i.path.endsWith('/Image') && i.activeInHierarchy && i.sprite)!;
  const feltTex = new TextureLoader().load(`${import.meta.env.BASE_URL}assets/3d/${img.sprite!.texture.split('/').pop()}`);
  feltTex.colorSpace = SRGBColorSpace;
  const felt = new Mesh(new PlaneGeometry(img.rectSize[0], img.rectSize[1]), new MeshBasicMaterial({ map: feltTex, side: DoubleSide, transparent: true, alphaTest: 0.01 }));
  felt.matrixAutoUpdate = false;
  felt.matrix.fromArray(img.worldMatrix);
  felt.name = 'Table_Canvas/Image';
  world.add(felt);

  // Seat splines in engine-seat order.
  const seatSplines = s.splines.map(
    (seat) => [splineFromData(seat.card0 as unknown as RawSpline), splineFromData(seat.card1 as unknown as RawSpline)] as [UnitySpline, UnitySpline],
  );

  // Community slots, placed at their world transforms.
  const slots = s.communitySlots.map((slot, i) => {
    const root = buildHierarchy(slot.hierarchy as unknown as HNode);
    root.matrixAutoUpdate = true;
    root.position.fromArray(slot.worldPosition);
    root.quaternion.fromArray(slot.worldRotation);
    root.scale.fromArray(slot.lossyScale);
    world.add(root);
    return new AnimatedSlot(root, i, slot.cardViewSettings.meshRenderer.path);
  });

  const fu = s.card.cardView.faceUpLocalEuler;
  const fd = s.card.cardView.faceDownLocalEuler;

  return {
    scene,
    camera,
    world,
    seatSplines,
    slots,
    dealer: { dealSpeed: s.dealer.dealSpeed, holeStagger: s.dealer.holeStagger },
    cardOptions: { faceUpLocalEuler: fu, faceDownLocalEuler: fd },
    update(dt: number) {
      for (const slot of slots) slot.player.update(dt);
    },
  };
}
