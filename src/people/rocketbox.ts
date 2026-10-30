import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The Microsoft Rocketbox avatars (MIT), as tools/build_rocketbox.mjs converted them into
 * public/models/rocketbox: per avatar a quantized GLB (metres, bind pose, 57 Biped bones in
 * one canonical order), a diffuse atlas (body | head), a normal (xy) + specular (b) atlas,
 * the hair cards, a cloth mask; per gender one animation GLB.
 *
 * Loading is lazy and per avatar. A "body" can wear another avatar's head (same gender):
 * the head half of the mesh (head texture: face, neck, the chest's V) and the hair are
 * moved from the head's skeleton onto the body's at bind time, so a race suit or a team
 * kit can go on many faces.
 */

const BASE = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/') + 'people/';

export interface AvatarMeta {
  name: string;
  female: boolean;
  bones: number;
  verts: number;
  tris: number;
  height: number;
  /** the hands' skin colour (linear) */
  skin: [number, number, number];
  /** the shirt's mean colour (linear) */
  shirt: [number, number, number];
  hair: [number, number, number];
  hasHair: boolean;
  bytes: number;
  files: string[];
}

export interface RbIndex {
  avatars: Record<string, AvatarMeta>;
  anims: Record<'m' | 'f', { bytes: number; file: string }>;
}

/** one loaded avatar: geometry (plain float attributes), bind skeleton, textures */
export interface RbAvatar {
  meta: AvatarMeta;
  /** bone names in skin order, their parents (index, −1 root), bind-pose locals */
  names: string[];
  parents: number[];
  local: { p: THREE.Vector3; q: THREE.Quaternion }[];
  /** bind world matrices and their inverses */
  bindW: THREE.Matrix4[];
  boneInverses: THREE.Matrix4[];
  skin: THREE.BufferGeometry;
  hair: THREE.BufferGeometry | null;
  map: THREE.Texture;
  normal: THREE.Texture;
  mask: THREE.Texture;
  hairMap: THREE.Texture | null;
}

let indexP: Promise<RbIndex> | null = null;
export function rbIndex(): Promise<RbIndex> {
  return (indexP ??= fetch(BASE + 'index.json').then((r) => r.json()));
}

const tl = new THREE.TextureLoader();
function tex(file: string, srgb: boolean): Promise<THREE.Texture> {
  return tl.loadAsync(BASE + file).then((t) => {
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    t.name = file;
    return t;
  });
}

/** a geometry's attributes as plain float arrays (skinIndex as uint16), indexed */
function plain(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = src.getAttribute('position').count;
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['skinWeight', 4]] as const) {
    const a = src.getAttribute(name);
    const out = new Float32Array(n * size);
    for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) out[i * size + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  const si = src.getAttribute('skinIndex');
  const idx = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) idx[i * 4 + c] = si.getComponent(i, c);
  g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index!.array as ArrayLike<number>), 1));
  return g;
}

const avatarP = new Map<string, Promise<RbAvatar>>();

export function loadAvatar(name: string): Promise<RbAvatar> {
  let p = avatarP.get(name);
  if (!p) {
    p = (async () => {
      const idx = await rbIndex();
      const meta = idx.avatars[name];
      if (!meta) throw new Error(`no rocketbox avatar ${name}`);
      const [g, map, normal, mask, hairMap] = await Promise.all([
        new GLTFLoader().loadAsync(BASE + name + '.glb'),
        tex(name + '_c.webp', true),
        tex(name + '_n.webp', false),
        tex(name + '_m.png', false),
        meta.hasHair ? tex(name + '_h.webp', true) : Promise.resolve(null),
      ]);
      let skinMesh: THREE.SkinnedMesh | null = null, hairMesh: THREE.SkinnedMesh | null = null;
      g.scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        if ((m.material as THREE.Material).name === 'hair') hairMesh = m;
        else skinMesh = m;
      });
      const sk = skinMesh as unknown as THREE.SkinnedMesh;
      const bones = sk.skeleton.bones;
      const names = bones.map((b) => b.name);
      const parents = bones.map((b) => bones.indexOf(b.parent as THREE.Bone));
      const local = bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }));
      const boneInverses = sk.skeleton.boneInverses.map((m) => m.clone());
      const bindW = boneInverses.map((m) => m.clone().invert());
      const av: RbAvatar = {
        meta, names, parents, local, bindW, boneInverses,
        skin: plain(sk.geometry),
        hair: hairMesh ? plain((hairMesh as THREE.SkinnedMesh).geometry) : null,
        map, normal, mask, hairMap,
      };
      g.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      return av;
    })();
    avatarP.set(name, p);
  }
  return p;
}

// ------------------------------------------------------------------------------------ head swap
/**
 * Move a geometry bound to one avatar's bind skeleton onto another's: each vertex is
 * skinned by (target bind × source bind⁻¹) per bone — the pose the target's skeleton would
 * put it in if its bones carried the source's vertices.
 */
export function retarget(src: THREE.BufferGeometry, from: RbAvatar, to: RbAvatar): THREE.BufferGeometry {
  const g = src.clone();
  const pa = g.getAttribute('position') as THREE.BufferAttribute;
  const na = g.getAttribute('normal') as THREE.BufferAttribute;
  const si = g.getAttribute('skinIndex') as THREE.BufferAttribute;
  const sw = g.getAttribute('skinWeight') as THREE.BufferAttribute;
  const M = from.bindW.map((w, i) => to.bindW[i].clone().multiply(from.boneInverses[i]));
  const p = new THREE.Vector3(), n = new THREE.Vector3(), acc = new THREE.Vector3(), accN = new THREE.Vector3(), t = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) {
    p.fromBufferAttribute(pa, i);
    n.fromBufferAttribute(na, i);
    acc.set(0, 0, 0);
    accN.set(0, 0, 0);
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c);
      if (w <= 0) continue;
      const m = M[si.getComponent(i, c)];
      acc.addScaledVector(t.copy(p).applyMatrix4(m), w);
      accN.addScaledVector(t.copy(n).transformDirection(m), w);
    }
    pa.setXYZ(i, acc.x, acc.y, acc.z);
    accN.normalize();
    na.setXYZ(i, accN.x, accN.y, accN.z);
  }
  return g;
}

/** the triangles of a geometry whose texture lies in one half of the atlas (u < 0.5: body, else head) */
export function atlasHalf(g: THREE.BufferGeometry, head: boolean): number[] {
  const uv = g.getAttribute('uv');
  const idx = g.index!.array;
  const out: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const u = (uv.getX(idx[t]) + uv.getX(idx[t + 1]) + uv.getX(idx[t + 2])) / 3;
    if (u >= 0.5 === head) out.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  return out;
}

/** merge (body geometry, its triangles) + (head geometry, its triangles) into one compact geometry */
export function mergeParts(parts: { g: THREE.BufferGeometry; tris: number[] }[]): THREE.BufferGeometry {
  const names = Object.keys(parts[0].g.attributes);
  const remap = parts.map(() => new Map<number, number>());
  const index: number[] = [];
  let n = 0;
  parts.forEach((pt, k) => {
    for (const v of pt.tris) {
      let j = remap[k].get(v);
      if (j === undefined) remap[k].set(v, (j = n++));
      index.push(j);
    }
  });
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const a0 = parts[0].g.getAttribute(name) as THREE.BufferAttribute;
    const size = a0.itemSize;
    const Arr = a0.array.constructor as new (n: number) => Float32Array;
    const arr = new Arr(n * size);
    parts.forEach((pt, k) => {
      const a = pt.g.getAttribute(name) as THREE.BufferAttribute;
      for (const [v, j] of remap[k]) for (let c = 0; c < size; c++) arr[j * size + c] = a.array[v * size + c];
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, a0.normalized));
  }
  out.setIndex(n > 65535 ? new THREE.BufferAttribute(Uint32Array.from(index), 1) : new THREE.BufferAttribute(Uint16Array.from(index), 1));
  return out;
}

// ------------------------------------------------------------------------------------ animations
export interface RbClips {
  clips: Map<string, THREE.AnimationClip>;
  /** metres per second the clip travels (walks, runs), by name */
  speed: Map<string, number>;
}

/**
 * A gender's clips (RBA1, see tools/build_rocketbox.mjs): rotation tracks, plus the root's
 * offset from its rest position as `Bip01.position` (the Person adds its own rest).
 */
const animP = new Map<string, Promise<RbClips>>();
export function loadAnims(g: 'm' | 'f'): Promise<RbClips> {
  let p = animP.get(g);
  if (!p) {
    p = fetch(BASE + `anims_${g}.bin`)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x31414252) throw new Error('bad anims file');
        const jl = dv.getUint32(4, true);
        const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl))) as {
          bones: string[];
          clips: { name: string; duration: number; speed: number; tracks: number[][]; root: number[] | null }[];
        };
        let o = 8 + jl;
        const nt = dv.getUint32(o, true), nq = dv.getUint32(o + 4, true), np = dv.getUint32(o + 8, true);
        o += 12;
        const T = new Uint16Array(buf, o, nt);
        o += nt * 2;
        const Q = new Int16Array(buf, o, nq);
        o += nq * 2;
        const P = new Float32Array(buf.slice(o, o + np * 4));
        const out: RbClips = { clips: new Map(), speed: new Map() };
        for (const c of head.clips) {
          const tracks: THREE.KeyframeTrack[] = [];
          for (const [b, n, to, qo] of c.tracks) {
            const times = new Float32Array(n), vals = new Float32Array(n * 4);
            for (let i = 0; i < n; i++) {
              times[i] = T[to + i] / 1000;
              for (let k = 0; k < 4; k++) vals[i * 4 + k] = Q[qo + i * 4 + k] / 32767;
            }
            tracks.push(new THREE.QuaternionKeyframeTrack(`${head.bones[b]}.quaternion`, times, vals));
          }
          if (c.root) {
            const [n, to, po] = c.root;
            const times = new Float32Array(n);
            for (let i = 0; i < n; i++) times[i] = T[to + i] / 1000;
            tracks.push(new THREE.VectorKeyframeTrack('Bip01.position', times, P.slice(po, po + n * 3)));
          }
          out.clips.set(c.name, new THREE.AnimationClip(c.name, c.duration, tracks));
          out.speed.set(c.name, c.speed);
        }
        return out;
      });
    animP.set(g, p);
  }
  return p;
}
