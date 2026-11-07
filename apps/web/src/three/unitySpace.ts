import { Group, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Q4, V3 } from '../anim/unitySpline';

/**
 * Unity is left-handed (Y up, Z forward); three.js is right-handed. Rather than converting every
 * position and rotation the animations produce, the whole table lives under one root mirrored on Z.
 * Inside it, objects use Unity's raw world values (positions, quaternions, Euler angles via 'YXZ'
 * which is Unity's Z-then-X-then-Y order) and the code reads like the C# it was ported from.
 * three.js flips triangle winding for negative-determinant transforms, so meshes still render the
 * right way round. Only the camera sits outside the mirror, converted once.
 */
export function createUnityRoot(): Group {
  const root = new Group();
  root.name = 'UnityWorld';
  root.scale.set(1, 1, -1);
  return root;
}

/** Unity world point → three.js world point. */
export function toThreePoint(p: V3): Vector3 {
  return new Vector3(p.x, p.y, -p.z);
}

/** Places a three.js camera where a Unity camera with this world pose would be, looking the same way. */
export function applyUnityCameraPose(camera: PerspectiveCamera, position: V3, rotation: Q4): void {
  const q = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
  const fwd = new Vector3(0, 0, 1).applyQuaternion(q); // Unity camera looks down its +Z
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const pos = toThreePoint(position);
  camera.position.copy(pos);
  camera.up.set(up.x, up.y, -up.z);
  camera.lookAt(pos.clone().add(new Vector3(fwd.x, fwd.y, -fwd.z)));
}
