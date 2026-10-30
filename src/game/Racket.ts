import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GFX } from '../render/gfx.ts';

/** paddle geometry constants (metres): butt at y = 0, handle along +y, the face's normal ±z */
export const RACKET = {
  length: 0.41,
  /** the grip point (centre of the hand on the handle) */
  grip: 0.06,
  /** the sweet spot, the middle of the face */
  sweet: 0.27,
  /** where the off hand rests (the paddle's throat) / joins for a two-hander */
  throat: 0.15,
  twoHand: 0.1,
  faceW: 0.2,
  faceH: 0.3,
  handle: 0.13,
};

export const PADDLE_ART = ['paddle_a.webp', 'paddle_b.webp', 'paddle_c.webp'];
const texCache = new Map<string, THREE.Texture>();
function faceTex(name: string): THREE.Texture {
  let t = texCache.get(name);
  if (!t) {
    t = new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'art/' + name);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set(name, t);
  }
  return t;
}

/**
 * A composite pickleball paddle: the printed face (the generated art, alpha-cut to the
 * paddle's outline) on both sides of a dark core stacked a few times for its 14 mm thickness,
 * a wrapped octagonal handle with a butt cap. Built with the handle along +y at the hand.
 */
export function buildRacket(art = PADDLE_ART[0], grip = '#1b1c1f'): THREE.Group {
  const R = RACKET;
  const g = new THREE.Group();
  g.name = 'paddle';
  const t = faceTex(art);
  const faceMat = GFX.lite
    ? new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, roughness: 0.38, side: THREE.FrontSide })
    : new THREE.MeshPhysicalMaterial({ map: t, alphaTest: 0.5, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25, side: THREE.FrontSide });
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x141518, alphaMap: t, alphaTest: 0.5, roughness: 0.6, side: THREE.DoubleSide });
  const fy = R.handle + R.faceH / 2 - 0.012;
  const plane = new THREE.PlaneGeometry(R.faceW, R.faceH);
  const th = 0.0075;
  // (built as three meshes — both faces, the stacked core, the handle — to keep the draw calls down)
  const front = new THREE.Mesh(mergeGeometries([
    plane.clone().translate(0, fy, th),
    plane.clone().rotateY(Math.PI).translate(0, fy, -th),
  ]), faceMat);
  const cores: THREE.BufferGeometry[] = [];
  for (let k = -2; k <= 2; k++) cores.push(plane.clone().scale(0.995, 0.995, 1).translate(0, fy, (k / 2.5) * th * 0.95));
  g.add(front, new THREE.Mesh(mergeGeometries(cores), coreMat));
  front.castShadow = true;
  front.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: t, alphaTest: 0.5 });
  // handle: an octagonal tapered grip with a cap
  const gripMat = new THREE.MeshStandardMaterial({ color: grip, roughness: 0.85 });
  const handle = new THREE.Mesh(mergeGeometries([
    new THREE.CylinderGeometry(0.0155, 0.0165, R.handle + 0.02, 8).translate(0, (R.handle + 0.02) / 2, 0),
    new THREE.CylinderGeometry(0.019, 0.017, 0.012, 8).translate(0, 0.006, 0),
  ]), gripMat);
  handle.castShadow = true;
  g.add(handle);
  return g;
}
