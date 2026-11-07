import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from 'three';
import cardMesh from '../data/card-mesh.json';
import scene from '../data/unity-scene.json';
import type { CardFace, CardVisual } from '../table/cardView';

/**
 * The real card from the Unity project: the "Card Deck.FBX" mesh (exported by tools/export-card-mesh.mjs
 * in Unity mesh space) with CardLibrary's materials — slot 0 back, slot 1 this card's face, slot 2 edge,
 * and the grey "folded" material on every slot once the seat folds.
 */

const ASSET_BASE = `${import.meta.env.BASE_URL}assets/3d/`;
const loader = new TextureLoader();
const textures = new Map<string, Texture>();

function texture(unityPath: string): Texture {
  const file = unityPath.split('/').pop()!;
  let t = textures.get(file);
  if (!t) {
    t = loader.load(ASSET_BASE + encodeURIComponent(file));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    textures.set(file, t);
  }
  return t;
}

type UnityMat = { textures?: Record<string, { texture: string }>; floats?: Record<string, number>; colors?: Record<string, number[]> };

/** Built-in Standard shader → MeshStandardMaterial (albedo, metallic, smoothness). */
function standardMaterial(mat: UnityMat, mapPath?: string): MeshStandardMaterial {
  const tex = mapPath ?? mat.textures?._MainTex?.texture;
  const c = mat.colors?._Color ?? [1, 1, 1, 1];
  const m = new MeshStandardMaterial({
    map: tex ? texture(tex) : null,
    metalness: mat.floats?._Metallic ?? 0,
    roughness: 1 - (mat.floats?._Glossiness ?? 0.5),
  });
  m.color.setRGB(c[0], c[1], c[2], SRGBColorSpace);
  return m;
}

const lib = scene.card.library;
const entries = lib.entries as { index: number; faceTexture: string }[];

let geometry: BufferGeometry | null = null;
function cardGeometry(): BufferGeometry {
  if (geometry) return geometry;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(cardMesh.position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(cardMesh.normal), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(cardMesh.uv), 2));
  cardMesh.submeshes.forEach((s, i) => g.addGroup(s.start, s.count, i));
  g.computeBoundingSphere();
  geometry = g;
  return g;
}

let shared: { back: MeshStandardMaterial; edge: MeshStandardMaterial; folded: MeshStandardMaterial; faces: MeshStandardMaterial[] } | null = null;
function materials() {
  if (shared) return shared;
  const faceMat = (path: string) => standardMaterial(lib.back as UnityMat, path);
  shared = {
    back: standardMaterial(lib.back as UnityMat),
    edge: standardMaterial(lib.edge as UnityMat),
    folded: standardMaterial(lib.folded as UnityMat),
    faces: entries.map((e) => faceMat(e.faceTexture)),
  };
  return shared;
}

/** Card.Index: suit * 13 + (rank - 2). */
export function cardIndex(card: CardFace): number {
  return card.suit * 13 + (card.rank - 2);
}

type Node = { name: string; localPosition: number[]; localRotation?: number[]; localScale: number[]; children?: Node[] };

function applyLocal(o: Object3D, n: Node): void {
  o.name = n.name;
  o.position.fromArray(n.localPosition);
  if (n.localRotation) o.quaternion.fromArray(n.localRotation);
  o.scale.fromArray(n.localScale);
}

/** The prefab's "Card Deck" node chain (Card Deck → Card_Visual mesh), as authored in Card.prefab. */
const cardDeckNode = (scene.card.hierarchy.children as Node[]).find((c) => c.name === 'Card Deck')!;
const cardVisualNode = cardDeckNode.children!.find((c) => c.name === 'Card_Visual')!;

/** A card's visual: the "Card Deck" subtree, ready to parent under a card root (CardView transform). */
export class CardModelVisual implements CardVisual {
  readonly object: Object3D;
  readonly mesh: Mesh;
  private face = 0;
  private greyed = false;

  /**
   * @param meshParent when given (community slots), the mesh is added there instead of building the
   * prefab's own node chain — the slot already has its Card Deck / mesh-node hierarchy.
   */
  constructor(meshParent?: Object3D) {
    const m = materials();
    this.mesh = new Mesh(cardGeometry(), [m.back, m.faces[0], m.edge]);
    this.mesh.castShadow = true;
    this.mesh.name = 'CardMesh';
    if (meshParent) {
      meshParent.add(this.mesh);
      this.object = new Group();
    } else {
      const deck = new Group();
      applyLocal(deck, cardDeckNode);
      const visual = new Group();
      applyLocal(visual, cardVisualNode);
      visual.add(this.mesh);
      deck.add(visual);
      this.object = deck;
    }
  }

  setFace(card: CardFace): void {
    this.face = cardIndex(card);
    if (!this.greyed) this.applyMaterials();
  }

  setGreyedOut(): void {
    this.greyed = true;
    const f = materials().folded;
    this.mesh.material = [f, f, f];
  }

  refreshBack(): void {
    if (this.greyed) this.setGreyedOut();
    else this.applyMaterials();
  }

  private applyMaterials(): void {
    const m = materials();
    this.mesh.material = [m.back, m.faces[this.face] ?? m.faces[0], m.edge];
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}

/**
 * THEME HOOK (theming module): CardLibrary.ApplyBackTexture / ApplyFoldedTexture. Every card shares the back and
 * folded materials, so swapping their texture re-skins all cards at once (call SplineCardDealer.refreshCardBacks
 * afterwards, as ThemeManager.ApplyCardBacks does). A url of null leaves that texture as it is. The new texture is
 * swapped in once it has loaded, so the cards never flash blank.
 */
export function setCardBackTextures(backUrl: string | null, foldedUrl: string | null): void {
  const m = materials();
  const swap = (mat: MeshStandardMaterial, url: string | null) => {
    if (!url) return;
    const t = loader.load(url, () => {
      if (mat.userData.themeUrl !== url) return; // a later theme won the race
      const old = mat.map;
      mat.map = t;
      mat.needsUpdate = true;
      if (old && old.userData.themeOwned) old.dispose();
    });
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    t.userData.themeOwned = true;
    mat.userData.themeUrl = url;
  };
  swap(m.back, backUrl);
  swap(m.folded, foldedUrl);
}

/** Preloads every card texture so the first deal doesn't pop. */
export function preloadCardTextures(): void {
  materials();
}

export function quatFromArray(a: number[]): Quaternion {
  return new Quaternion(a[0], a[1], a[2], a[3]);
}
