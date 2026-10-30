import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';

/**
 * The Rocketbox conversion, run in headless Chrome by tools/build_rocketbox.mjs:
 * FBX (3ds Max Biped, cm) + 2K TGA textures → a small quantized GLB per avatar (metres,
 * y up, facing +z, bind pose), a diffuse atlas (body | head), a normal + specular atlas,
 * the hair cards (RGBA), a cloth mask, and per-gender animation GLBs (rotation tracks,
 * resampled, keyframe-reduced, int16 quaternions).
 */

const SRC = '/assets-src/rocketbox/';

// ------------------------------------------------------------------------------------ bones
/** the bones kept: the body, the fingers, the eyes and upper lids (the face rig folds into the head) */
const KEEP = /^Bip01(_Pelvis|_Spine\d?|_Neck|_Head|_[LR]_(Clavicle|UpperArm|Forearm|Hand|Finger\d+|Thigh|Calf|Foot|Toe0)|_[LR]Eye|_[LR]EyeBlinkTop)?$/;

const FING = ['0', '01', '02', '1', '11', '12', '2', '21', '22', '3', '31', '32', '4', '41', '42'];
/** the kept bones in one canonical order (every avatar's skin indexes the same list) */
export const BONES = [
  'Bip01', 'Bip01_Pelvis', 'Bip01_Spine',
  ...['L', 'R'].flatMap((s) => ['Thigh', 'Calf', 'Foot', 'Toe0'].map((b) => `Bip01_${s}_${b}`)),
  'Bip01_Spine1', 'Bip01_Spine2', 'Bip01_Neck', 'Bip01_Head', 'Bip01_LEye', 'Bip01_REye', 'Bip01_LEyeBlinkTop', 'Bip01_REyeBlinkTop',
  ...['L', 'R'].flatMap((s) => [...['Clavicle', 'UpperArm', 'Forearm', 'Hand'].map((b) => `Bip01_${s}_${b}`), ...FING.map((f) => `Bip01_${s}_Finger${f}`)]),
];

/** body part of a bone: 0 head, 1 neck, 2 torso, 3 upper arm, 4 forearm, 5 hand, 6 thigh, 7 calf, 8 foot */
export function partOf(name: string): number {
  if (/Head|Eye/.test(name)) return 0;
  if (/Neck/.test(name)) return 1;
  if (/UpperArm/.test(name)) return 3;
  if (/Forearm/.test(name)) return 4;
  if (/Hand|Finger/.test(name)) return 5;
  if (/Thigh/.test(name)) return 6;
  if (/Calf/.test(name)) return 7;
  if (/Foot|Toe/.test(name)) return 8;
  return 2;
}

// ------------------------------------------------------------------------------------ GLB writer
type TA = Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array;
const CT = (a: TA) => (a instanceof Float32Array ? 5126 : a instanceof Int8Array ? 5120 : a instanceof Uint8Array ? 5121 : a instanceof Int16Array ? 5122 : a instanceof Uint16Array ? 5123 : 5125);
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

class GLB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any = { asset: { version: '2.0', generator: 'CenterCourt build_people' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [], nodes: [], scenes: [{ nodes: [] }], scene: 0 };
  private parts: Uint8Array[] = [];
  private len = 0;
  view(data: ArrayBufferView, target?: number, stride?: number): number {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.len += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.parts.push(bytes.slice());
    const v: Record<string, number> = { buffer: 0, byteOffset: this.len, byteLength: bytes.byteLength };
    if (target) v.target = target;
    if (stride) v.byteStride = stride;
    this.len += bytes.byteLength;
    this.json.bufferViews.push(v);
    return this.json.bufferViews.length - 1;
  }
  accessor(data: TA, type: string, o: { normalized?: boolean; target?: number; minmax?: boolean; count?: number; stride?: number } = {}): number {
    const n = NCOMP[type];
    const count = o.count ?? data.length / n;
    const acc: Record<string, unknown> = { bufferView: this.view(data, o.target, o.stride), componentType: CT(data), count, type };
    if (o.normalized) acc.normalized = true;
    if (o.minmax) {
      const mn = new Array(n).fill(Infinity), mx = new Array(n).fill(-Infinity);
      const step = o.stride ? o.stride / data.BYTES_PER_ELEMENT : n;
      for (let i = 0; i < count; i++)
        for (let c = 0; c < n; c++) {
          const v = data[i * step + c];
          mn[c] = Math.min(mn[c], v);
          mx[c] = Math.max(mx[c], v);
        }
      acc.min = mn;
      acc.max = mx;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  /** accessors packed into one shared buffer view per component type (small animation tracks: far less JSON) */
  private pools = new Map<string, { parts: TA[]; bytes: number; accs: Record<string, unknown>[] }>();
  pooled(data: TA, type: string, o: { normalized?: boolean; minmax?: boolean } = {}): number {
    const n = NCOMP[type];
    const key = data.constructor.name;
    let pool = this.pools.get(key);
    if (!pool) this.pools.set(key, (pool = { parts: [], bytes: 0, accs: [] }));
    // keep every accessor aligned to its element size × components (4-byte minimum)
    const al = Math.max(4, data.BYTES_PER_ELEMENT * n);
    const pad = (al - (pool.bytes % al)) % al;
    if (pad) {
      pool.parts.push(new (data.constructor as new (n: number) => TA)(pad / data.BYTES_PER_ELEMENT));
      pool.bytes += pad;
    }
    const acc: Record<string, unknown> = { bufferView: -1, byteOffset: pool.bytes, componentType: CT(data), count: data.length / n, type };
    if (o.normalized) acc.normalized = true;
    if (o.minmax) {
      acc.min = [Math.min(...Array.from(data))];
      acc.max = [Math.max(...Array.from(data))];
    }
    pool.parts.push(data);
    pool.bytes += data.byteLength;
    pool.accs.push(acc);
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }
  bytes(): Uint8Array {
    for (const pool of this.pools.values()) {
      const all = new Uint8Array(pool.bytes);
      let o = 0;
      for (const p of pool.parts) {
        all.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
        o += p.byteLength;
      }
      const view = this.view(all);
      for (const a of pool.accs) a.bufferView = view;
    }
    this.pools.clear();
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.len += pad;
    }
    this.json.buffers[0].byteLength = this.len;
    let js = JSON.stringify(this.json);
    while (js.length % 4) js += ' ';
    const jb = new TextEncoder().encode(js);
    const total = 12 + 8 + jb.length + 8 + this.len;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jb.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(jb, 20);
    let o = 20 + jb.length;
    dv.setUint32(o, this.len, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    o += 8;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------ helpers
const mgr = new THREE.LoadingManager();
mgr.setURLModifier((u) => (/\.(tga|png|jpe?g|dds)$/i.test(u) ? 'data:,' : u));

async function loadFBX(url: string): Promise<THREE.Group> {
  const o = await new FBXLoader(mgr).loadAsync(url);
  o.updateMatrixWorld(true);
  return o;
}

interface Img { w: number; h: number; data: Uint8ClampedArray }

async function loadTGA(url: string): Promise<Img | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  const t = new TGALoader().parse(await r.arrayBuffer()) as unknown as { data: Uint8Array; width: number; height: number; flipY: boolean };
  const w = t.width, h = t.height;
  const out = new Uint8ClampedArray(w * h * 4);
  // (TGALoader already hands the rows over top row first)
  out.set(t.data);
  return { w, h, data: out };
}

async function resize(img: Img, w: number, h: number): Promise<Img> {
  const bm = await createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bm, 0, 0);
  return { w, h, data: g.getImageData(0, 0, w, h).data };
}

async function encode(img: Img, type: string, quality?: number): Promise<Uint8Array> {
  const c = new OffscreenCanvas(img.w, img.h);
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0);
  const b = await c.convertToBlob({ type, quality });
  return new Uint8Array(await b.arrayBuffer());
}

/** rasterize UV triangles (0..1, image v down) into a coverage / label map */
function rasterUV(w: number, h: number, tris: { uv: number[]; label: number }[], pad = 1): Int16Array {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.lineWidth = pad;
  g.lineJoin = 'round';
  for (const t of tris) {
    const col = `rgb(${(t.label + 1) * 25},0,0)`;
    g.fillStyle = col;
    g.strokeStyle = col;
    g.beginPath();
    g.moveTo(t.uv[0] * w, t.uv[1] * h);
    g.lineTo(t.uv[2] * w, t.uv[3] * h);
    g.lineTo(t.uv[4] * w, t.uv[5] * h);
    g.closePath();
    g.fill();
    if (pad > 0) g.stroke();
  }
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Int16Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.round(d[i * 4] / 25) - 1;
  return out;
}

/** grow the covered texels' colours outward (mip levels don't bleed the black background in), then fill with the mean */
function dilate(img: Img, covered: Uint8Array, passes: number, channels = 3) {
  const { w, h, data } = img;
  let cov = covered.slice();
  const mean = [0, 0, 0, 0];
  let n = 0;
  for (let i = 0; i < w * h; i++)
    if (cov[i]) {
      for (let c = 0; c < 4; c++) mean[c] += data[i * 4 + c];
      n++;
    }
  for (let c = 0; c < 4; c++) mean[c] = n ? mean[c] / n : 0;
  for (let p = 0; p < passes; p++) {
    const next = cov.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cov[i]) continue;
        let r = 0, gg = 0, b = 0, a = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!cov[j]) continue;
            r += data[j * 4];
            gg += data[j * 4 + 1];
            b += data[j * 4 + 2];
            a += data[j * 4 + 3];
            k++;
          }
        if (k) {
          data[i * 4] = r / k;
          data[i * 4 + 1] = gg / k;
          data[i * 4 + 2] = b / k;
          if (channels > 3) data[i * 4 + 3] = a / k;
          next[i] = 1;
        }
      }
    cov = next;
  }
  for (let i = 0; i < w * h; i++)
    if (!cov[i]) for (let c = 0; c < channels; c++) data[i * 4 + c] = mean[c];
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = channels > 3 ? data[i * 4 + 3] : 255;
}

function blit(dst: Img, src: Img, ox: number) {
  for (let y = 0; y < src.h; y++) dst.data.set(src.data.subarray(y * src.w * 4, (y + 1) * src.w * 4), (y * dst.w + ox) * 4);
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

// ------------------------------------------------------------------------------------ an avatar
interface Out { files: Record<string, string>; meta: Record<string, unknown> }

export async function convertAvatar(name: string, opts: { tex?: number; ntex?: number; hair?: number } = {}): Promise<Out> {
  const TEX = opts.tex ?? 1024, NTEX = opts.ntex ?? 512, HAIR = opts.hair ?? 768;
  const dir = `${SRC}avatars/${name}/`;
  const fbx = await loadFBX(dir + name + '.fbx');
  const meshes: THREE.SkinnedMesh[] = [];
  fbx.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  const log: string[] = [];
  // ---- the bind skeleton, in metres
  const bindW = new Map<string, THREE.Matrix4>();
  const parentOf = new Map<string, string | null>();
  for (const m of meshes) {
    m.skeleton.bones.forEach((b, i) => {
      if (!bindW.has(b.name)) bindW.set(b.name, m.skeleton.boneInverses[i].clone().invert());
    });
  }
  // every bone (skinning or not) with its parent chain, to find kept ancestors
  const allBones = new Map<string, THREE.Bone>();
  fbx.traverse((o) => {
    if ((o as THREE.Bone).isBone) allBones.set(o.name, o as THREE.Bone);
  });
  const keptOf = (n: string): string => {
    let b: THREE.Object3D | null | undefined = allBones.get(n);
    while (b && !KEEP.test(b.name)) b = b.parent;
    return b ? b.name : 'Bip01_Head';
  };
  const kept: string[] = [];
  fbx.traverse((o) => {
    if ((o as THREE.Bone).isBone && KEEP.test(o.name)) kept.push(o.name);
  });
  if (kept.length !== BONES.length || kept.some((n) => !BONES.includes(n))) throw new Error(`${name}: unexpected skeleton ${kept.join(',')}`);
  kept.sort((a, b) => BONES.indexOf(a) - BONES.indexOf(b));
  for (const n of kept) {
    let p = allBones.get(n)!.parent;
    while (p && !((p as THREE.Bone).isBone && KEEP.test(p.name))) p = p.parent;
    parentOf.set(n, p ? p.name : null);
    if (!bindW.has(n)) {
      // not a skinning bone (Bip01 itself): its world matrix as loaded
      bindW.set(n, allBones.get(n)!.matrixWorld.clone());
    }
  }
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const W2 = new Map<string, THREE.Matrix4>();
  let maxScaleErr = 0;
  for (const n of kept) {
    bindW.get(n)!.decompose(t, q, s);
    maxScaleErr = Math.max(maxScaleErr, Math.abs(s.x - 1), Math.abs(s.y - 1), Math.abs(s.z - 1));
    W2.set(n, new THREE.Matrix4().compose(t.clone().multiplyScalar(0.01), q.clone(), new THREE.Vector3(1, 1, 1)));
  }
  log.push(`bones kept ${kept.length}/${allBones.size}, bind scale err ${maxScaleErr.toFixed(4)}`);
  // rest (as loaded) vs bind
  {
    let err = 0;
    for (const n of kept) {
      const b = allBones.get(n)!;
      const a = b.matrixWorld.elements, c = bindW.get(n)!.elements;
      for (let i = 12; i < 15; i++) err = Math.max(err, Math.abs(a[i] - c[i]));
    }
    log.push(`rest vs bind (cm) ${err.toFixed(3)}`);
  }
  const boneIndex = new Map(kept.map((n, i) => [n, i]));

  // ---- geometry: gather per primitive
  type Prim = 'skin' | 'hair';
  const P: Record<Prim, { pos: number[]; nrm: number[]; uv: number[]; ji: number[]; jw: number[] }> = {
    skin: { pos: [], nrm: [], uv: [], ji: [], jw: [] },
    hair: { pos: [], nrm: [], uv: [], ji: [], jw: [] },
  };
  const uvTris: Record<'body' | 'head' | 'hair', { uv: number[]; label: number }[]> = { body: [], head: [], hair: [] };
  const matNames = new Set<string>();
  let hatTris = 0;
  const v = new THREE.Vector3(), nn = new THREE.Vector3();
  const headY = new THREE.Vector3().setFromMatrixPosition(W2.get('Bip01_Head')!).y;
  const eyeP = new THREE.Vector3().setFromMatrixPosition(W2.get('Bip01_LEye')!);
  /** uvs (head texture) of the cheeks: the skin reference */
  const cheekUV: number[][] = [];
  const neckY = new THREE.Vector3().setFromMatrixPosition(W2.get('Bip01_Neck')!).y;
  for (const m of meshes) {
    const g = m.geometry;
    const pa = g.getAttribute('position'), na = g.getAttribute('normal'), ua = g.getAttribute('uv');
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    const nm = new THREE.Matrix3().getNormalMatrix(m.bindMatrix);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: pa.count, materialIndex: 0 }];
    for (const gr of groups) {
      const mname = mats[gr.materialIndex ?? 0].name.toLowerCase();
      matNames.add(mname);
      const kind: 'body' | 'head' | 'hair' | 'hat' | null = /hat/.test(mname) ? 'hat' : /opacity|hair|lash/.test(mname) ? 'hair' : /head/.test(mname) ? 'head' : /body/.test(mname) ? 'body' : null;
      if (!kind) {
        log.push(`unknown material ${mname} (${gr.count / 3} tris) dropped`);
        continue;
      }
      if (kind === 'hat') {
        hatTris += gr.count / 3;
        continue;
      }
      for (let tri = gr.start; tri < gr.start + gr.count; tri += 3) {
        const tv: { p: number[]; n: number[]; uv: number[]; ji: number[]; jw: number[]; part: number }[] = [];
        for (let k = 0; k < 3; k++) {
          const i = tri + k;
          v.fromBufferAttribute(pa, i).applyMatrix4(m.bindMatrix).multiplyScalar(0.01);
          nn.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
          // weights onto the kept bones
          const acc = new Map<number, number>();
          for (let c = 0; c < 4; c++) {
            const w = sw.getComponent(i, c);
            if (w <= 0) continue;
            const bn = keptOf(m.skeleton.bones[si.getComponent(i, c)].name);
            const bi = boneIndex.get(bn)!;
            acc.set(bi, (acc.get(bi) ?? 0) + w);
          }
          const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
          const sum = top.reduce((x, e) => x + e[1], 0) || 1;
          const ji = [0, 0, 0, 0], jw = [0, 0, 0, 0];
          let left = 255;
          top.forEach(([b, w], c) => {
            ji[c] = b;
            jw[c] = c === top.length - 1 ? left : Math.round((w / sum) * 255);
            left -= jw[c];
          });
          const uvx = ua.getX(i), uvy = 1 - ua.getY(i);
          tv.push({ p: [v.x, v.y, v.z], n: [nn.x, nn.y, nn.z], uv: [uvx, uvy], ji, jw, part: partOf(kept[ji[0]]) });
        }
        // a pilot's cap painted on the body: body-textured triangles moving with the head, above the brows
        if (kind === 'body' && tv.every((x) => x.part === 0) && tv.some((x) => x.p[1] > headY + 0.06)) {
          hatTris++;
          continue;
        }
        const prim: Prim = kind === 'hair' ? 'hair' : 'skin';
        const label = kind === 'head' ? (tv.every((x) => x.p[1] > neckY + 0.02) ? 0 : Math.max(...tv.map((x) => x.part)) === 0 ? 1 : Math.min(...tv.map((x) => x.part === 0 ? 9 : x.part))) : Math.round(tv.map((x) => x.part).sort((a, b) => a - b)[1]);
        uvTris[kind].push({ uv: tv.flatMap((x) => [fract(x.uv[0]), fract(x.uv[1])]), label });
        if (kind === 'head')
          for (const x of tv) {
            const dy = x.p[1] - eyeP.y, ax = Math.abs(x.p[0]);
            if (dy < -0.055 || dy > -0.02 || ax < 0.025 || ax > 0.055 || x.p[2] < eyeP.z - 0.02) continue;
            cheekUV.push([fract(x.uv[0]), fract(x.uv[1])]);
          }
        for (const x of tv) {
          const D = P[prim];
          D.pos.push(...x.p);
          D.nrm.push(...x.n);
          const u = fract(x.uv[0]), w = fract(x.uv[1]);
          D.uv.push(kind === 'body' ? u * 0.5 : kind === 'head' ? 0.5 + u * 0.5 : u, w);
          D.ji.push(...x.ji);
          D.jw.push(...x.jw);
        }
      }
    }
  }
  if (hatTris) log.push(`hat triangles dropped: ${hatTris}`);
  log.push(`materials: ${[...matNames].join(', ')}`);

  // ---- GLB
  const glb = new GLB();
  const J = glb.json;
  J.extensionsUsed = ['KHR_mesh_quantization'];
  J.extensionsRequired = ['KHR_mesh_quantization'];
  // bone nodes
  kept.forEach((n) => {
    const par = parentOf.get(n);
    const local = par ? W2.get(par)!.clone().invert().multiply(W2.get(n)!) : W2.get(n)!.clone();
    local.decompose(t, q, s);
    J.nodes.push({ name: n, translation: [t.x, t.y, t.z].map((x) => +x.toFixed(6)), rotation: [q.x, q.y, q.z, q.w].map((x) => +x.toFixed(7)) });
  });
  kept.forEach((n, i) => {
    const kids = kept.map((c, j) => (parentOf.get(c) === n ? j : -1)).filter((j) => j >= 0);
    if (kids.length) J.nodes[i].children = kids;
  });
  const ibm = new Float32Array(kept.length * 16);
  kept.forEach((n, i) => ibm.set(W2.get(n)!.clone().invert().elements, i * 16));
  J.skins = [{ joints: kept.map((_, i) => i), inverseBindMatrices: glb.accessor(ibm, 'MAT4'), skeleton: 0 }];
  const prims: unknown[] = [];
  let verts = 0, tris = 0;
  for (const prim of ['skin', 'hair'] as Prim[]) {
    const D = P[prim];
    const n0 = D.pos.length / 3;
    if (!n0) continue;
    // weld
    const map = new Map<string, number>();
    const idx = new Uint32Array(n0);
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], ji: number[] = [], jw: number[] = [];
    for (let i = 0; i < n0; i++) {
      const qn = [0, 1, 2].map((c) => Math.round(D.nrm[i * 3 + c] * 127));
      const qu = [0, 1].map((c) => Math.round(Math.min(1, Math.max(0, D.uv[i * 2 + c])) * 65535));
      const key = `${D.pos[i * 3].toFixed(5)},${D.pos[i * 3 + 1].toFixed(5)},${D.pos[i * 3 + 2].toFixed(5)},${qn},${qu},${D.ji.slice(i * 4, i * 4 + 4)},${D.jw.slice(i * 4, i * 4 + 4)}`;
      let j = map.get(key);
      if (j === undefined) {
        j = pos.length / 3;
        map.set(key, j);
        pos.push(D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2]);
        nrm.push(...qn, 0);
        uv.push(...qu);
        ji.push(...D.ji.slice(i * 4, i * 4 + 4));
        jw.push(...D.jw.slice(i * 4, i * 4 + 4));
      }
      idx[i] = j;
    }
    const nv = pos.length / 3;
    verts += nv;
    tris += n0 / 3;
    const attributes = {
      POSITION: glb.accessor(new Float32Array(pos), 'VEC3', { target: 34962, minmax: true }),
      NORMAL: glb.accessor(new Int8Array(nrm), 'VEC3', { target: 34962, normalized: true, stride: 4, count: nv }),
      TEXCOORD_0: glb.accessor(new Uint16Array(uv), 'VEC2', { target: 34962, normalized: true }),
      JOINTS_0: glb.accessor(new Uint8Array(ji), 'VEC4', { target: 34962 }),
      WEIGHTS_0: glb.accessor(new Uint8Array(jw), 'VEC4', { target: 34962, normalized: true }),
    };
    const indices = glb.accessor(nv < 65536 ? new Uint16Array(idx) : idx, 'SCALAR', { target: 34963 });
    J.materials ??= [];
    J.materials.push({ name: prim });
    prims.push({ attributes, indices, material: J.materials.length - 1 });
  }
  J.meshes = [{ name, primitives: prims }];
  J.nodes.push({ name: 'body', mesh: 0, skin: 0 });
  J.scenes[0].nodes = [0, J.nodes.length - 1];
  const glbBytes = glb.bytes();

  // ---- textures
  const files: Record<string, string> = {};
  const texOf = async (kind: string) => {
    const cands = (await (await fetch(`/__rb/ls?dir=${encodeURIComponent('avatars/' + name)}`)).json()) as string[];
    const f = cands.find((c) => c.toLowerCase().endsWith(`_${kind}.tga`));
    return f ? loadTGA(dir + f) : null;
  };
  const [bc, hc, bn, hn, bs, hs, op] = await Promise.all(['body_color', 'head_color', 'body_normal', 'head_normal', 'body_specular', 'head_specular', 'opacity_color'].map(texOf));
  // coverage + part labels in the atlas halves
  const labelsB = rasterUV(TEX, TEX, uvTris.body, 1.5);
  const labelsH = rasterUV(TEX, TEX, uvTris.head, 1.5);
  const cov = (L: Int16Array) => Uint8Array.from(L, (x) => (x >= 0 ? 1 : 0));
  // diffuse atlas
  const atlas: Img = { w: TEX * 2, h: TEX, data: new Uint8ClampedArray(TEX * 2 * TEX * 4) };
  const body = await resize(bc!, TEX, TEX), head = await resize(hc!, TEX, TEX);
  // the cloth mask (body half from colour vs the hands' skin; head half: the chest below the collar line)
  const mask = clothMask(body, labelsB, head, labelsH);
  dilate(body, cov(labelsB), 12);
  dilate(head, cov(labelsH), 12);
  blit(atlas, body, 0);
  blit(atlas, head, TEX);
  files[`${name}_c.webp`] = b64(await encode(atlas, 'image/webp', 0.84));
  // normal (xy) + specular (b) atlas
  const nat: Img = { w: NTEX * 2, h: NTEX, data: new Uint8ClampedArray(NTEX * 2 * NTEX * 4) };
  const lbN = rasterUV(NTEX, NTEX, uvTris.body, 1.5), lhN = rasterUV(NTEX, NTEX, uvTris.head, 1.5);
  for (const [nimg, simg, lab, ox] of [[bn, bs, lbN, 0], [hn, hs, lhN, NTEX]] as [Img | null, Img | null, Int16Array, number][]) {
    const nr = nimg ? await resize(nimg, NTEX, NTEX) : null;
    const sr = simg ? await resize(simg, NTEX, NTEX) : null;
    const out: Img = { w: NTEX, h: NTEX, data: new Uint8ClampedArray(NTEX * NTEX * 4) };
    for (let i = 0; i < NTEX * NTEX; i++) {
      out.data[i * 4] = nr ? nr.data[i * 4] : 128;
      out.data[i * 4 + 1] = nr ? nr.data[i * 4 + 1] : 128;
      out.data[i * 4 + 2] = sr ? (sr.data[i * 4] * 0.3 + sr.data[i * 4 + 1] * 0.59 + sr.data[i * 4 + 2] * 0.11) : 60;
      out.data[i * 4 + 3] = 255;
    }
    dilate(out, cov(lab), 8);
    blit(nat, out, ox);
  }
  files[`${name}_n.webp`] = b64(await encode(nat, 'image/webp', 0.9));
  // mask atlas (R: cloth)
  files[`${name}_m.png`] = b64(await encode(mask, 'image/png'));
  // hair cards
  let hairMean = [0.1, 0.07, 0.05];
  if (op && P.hair.pos.length) {
    const h = await resize(op, HAIR, HAIR);
    // the colour under the alpha, spread out a little so the filtered edges aren't black
    const covH = Uint8Array.from({ length: HAIR * HAIR }, (_, i) => (h.data[i * 4 + 3] > 24 ? 1 : 0));
    const alpha = Uint8Array.from({ length: HAIR * HAIR }, (_, i) => h.data[i * 4 + 3]);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < HAIR * HAIR; i++)
      if (h.data[i * 4 + 3] > 200) {
        r += h.data[i * 4];
        g += h.data[i * 4 + 1];
        b += h.data[i * 4 + 2];
        n++;
      }
    if (n) hairMean = [r / n / 255, g / n / 255, b / n / 255];
    dilate(h, covH, 4);
    for (let i = 0; i < HAIR * HAIR; i++) h.data[i * 4 + 3] = alpha[i];
    files[`${name}_h.webp`] = b64(await encode(h, 'image/webp', 0.82));
  }
  // skin reference: the cheeks (linear), else the hands
  let skinRef = handSkin(body, labelsB);
  if (cheekUV.length > 3) {
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (const [u, w] of cheekUV) {
      const i = (Math.min(TEX - 1, Math.floor(w * TEX)) * TEX + Math.min(TEX - 1, Math.floor(u * TEX))) * 4;
      rs.push(head.data[i]);
      gs.push(head.data[i + 1]);
      bs.push(head.data[i + 2]);
    }
    const med = (a: number[]) => (a.sort((x, y) => x - y), a[a.length >> 1]);
    skinRef = [lin(med(rs) / 255), lin(med(gs) / 255), lin(med(bs) / 255)];
  }
  const bb = new THREE.Box3();
  for (let i = 0; i < P.skin.pos.length; i += 3) bb.expandByPoint(v.set(P.skin.pos[i], P.skin.pos[i + 1], P.skin.pos[i + 2]));
  files[`${name}.glb`] = b64(glbBytes);
  const meta = {
    name,
    female: /Female/.test(name),
    bones: kept.length,
    boneNames: kept,
    verts,
    tris,
    height: +bb.max.y.toFixed(3),
    skin: skinRef.map((x) => +x.toFixed(4)),
    shirt: mask.shirtMean.map((x) => +x.toFixed(4)),
    hair: hairMean.map((x) => +x.toFixed(4)),
    hasHair: P.hair.pos.length > 0 && !!op,
    log,
  };
  return { files, meta };
}

function fract(x: number) {
  return x - Math.floor(x);
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** the median skin colour of the hands (linear rgb) */
function handSkin(img: Img, labels: Int16Array): number[] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== 5) continue;
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    if (r + g + b < 60) continue;
    rs.push(r);
    gs.push(g);
    bs.push(b);
  }
  const med = (a: number[]) => (a.sort((x, y) => x - y), a.length ? a[a.length >> 1] : 150);
  return [lin(med(rs) / 255), lin(med(gs) / 255), lin(med(bs) / 255)];
}

/**
 * The cloth mask at half resolution (grey: 0 skin … 255 cloth).
 */
function clothMask(body: Img, lb: Int16Array, head: Img, lh: Int16Array): Img & { shirtMean: number[] } {
  const S = body.w;
  const M = S / 4;
  const R = S / M;
  const out: Img & { shirtMean: number[] } = { w: M * 2, h: M, data: new Uint8ClampedArray(M * 2 * M * 4), shirtMean: [0.5, 0.5, 0.5] };
  // skin reference: hands (body) — chroma and brightness
  let sr = 0, sg = 0, sb = 0, sn = 0;
  const chroma = (r: number, g: number, b: number) => {
    const s = r + g + b + 1;
    return [r / s, g / s, (r + g + b) / 3];
  };
  for (let i = 0; i < lb.length; i++)
    if (lb[i] === 5) {
      const r = body.data[i * 4], g = body.data[i * 4 + 1], b = body.data[i * 4 + 2];
      if (r + g + b < 60) continue;
      sr += r;
      sg += g;
      sb += b;
      sn++;
    }
  const ref = chroma(sr / Math.max(1, sn), sg / Math.max(1, sn), sb / Math.max(1, sn));
  const cls = (img: Img, labels: Int16Array, isHead: boolean, ox: number) => {
    let tr = 0, tg = 0, tb = 0, tn = 0;
    for (let y = 0; y < M; y++)
      for (let x = 0; x < M; x++) {
        // R×R box; the label most of it has
        let r = 0, g = 0, b = 0, lab = -1;
        const votes = new Int16Array(10);
        for (let k = 0; k < R * R; k++) {
          const i = (y * R + Math.floor(k / R)) * S + x * R + (k % R);
          r += img.data[i * 4];
          g += img.data[i * 4 + 1];
          b += img.data[i * 4 + 2];
          if (labels[i] >= 0) votes[labels[i]]++;
        }
        let best = 0;
        for (let k = 0; k < 10; k++) if (votes[k] > best) { best = votes[k]; lab = k; }
        r /= R * R;
        g /= R * R;
        b /= R * R;
        const c = chroma(r, g, b);
        const dc = Math.hypot(c[0] - ref[0], c[1] - ref[1]) * 9;
        const dl = Math.max(0, Math.abs(Math.log((c[2] + 4) / (ref[2] + 4))) - 0.45) * 2.2;
        let cloth = Math.min(1, Math.max(0, (dc + dl - 0.25) / 0.3));
        if (lab === 5 || lab < 0) cloth = 0;
        if (isHead && lab <= 1) cloth = 0;
        const o = (y * M * 2 + ox + x) * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = cloth * 255;
        out.data[o + 3] = 255;
        if (cloth > 0.9 && (lab === 2 || lab === 3)) {
          tr += lin(r / 255);
          tg += lin(g / 255);
          tb += lin(b / 255);
          tn++;
        }
      }
    return [tr, tg, tb, tn];
  };
  const a = cls(body, lb, false, 0);
  cls(head, lh, true, M);
  // two 3×3 medians: no speckle from leg hair, freckles, prints
  for (let pass = 0; pass < 2; pass++) {
    const src = Uint8Array.from({ length: M * 2 * M }, (_, i) => out.data[i * 4]);
    const win: number[] = [];
    for (let y = 1; y < M - 1; y++)
      for (let x = 1; x < M * 2 - 1; x++) {
        win.length = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win.push(src[(y + dy) * M * 2 + x + dx]);
        win.sort((p, q) => p - q);
        const v = win[4];
        const o = (y * M * 2 + x) * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
      }
  }
  if (a[3] > 20) out.shirtMean = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
  return out;
}

// ------------------------------------------------------------------------------------ animations
export interface ClipSpec {
  /** our name for it */
  name: string;
  /** the Rocketbox clip (without m_ / f_ and .max.fbx) */
  src: string;
  /** seconds to keep: [start, end] (default: all) */
  range?: [number, number];
  /** cross-fade the end into the start over this many seconds (for a clean loop) */
  loop?: number;
  fps?: number;
  /** remove the travel (walks, runs): the root's horizontal drift */
  inPlace?: boolean;
}

/**
 * Per gender, one small binary (RBA1): u32 magic, u32 header length, the header JSON
 * { bones, clips: [{ name, duration, speed, tracks: [[bone, keys, timeOffset, quatOffset]…],
 * root: [keys, timeOffset, posOffset] | null }] }, then u16 times (ms), i16 quaternions
 * (×32767) and f32 root positions, each section 4-byte aligned.
 */
export async function convertAnims(gender: 'm' | 'f', specs: ClipSpec[], bones: string[], tol = { body: 0.009, finger: 0.035 }): Promise<Out> {
  const log: string[] = [];
  const bi = new Map(bones.map((n, i) => [n, i]));
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
  const T16: number[] = [], Q16: number[] = [], P32: number[] = [];
  const clips: unknown[] = [];
  let keysTotal = 0;
  for (const spec of specs) {
    const url = `${SRC}anims/${gender}_${spec.src}.max.fbx`;
    const fbx = await loadFBX(url);
    const clip = fbx.animations[0];
    // the reference skeleton's root height (the clip's root position is relative to it)
    let rootRest = new THREE.Vector3();
    fbx.traverse((o) => {
      if (o.name === 'Bip01') rootRest = o.position.clone();
    });
    const fps = spec.fps ?? 15;
    const t0 = spec.range?.[0] ?? 0;
    const t1 = Math.min(clip.duration, spec.range?.[1] ?? clip.duration);
    const F = spec.loop ?? 0;
    const T = t1 - t0 - F;
    const n = Math.max(2, Math.round(T * fps) + 1);
    const times = Float32Array.from({ length: n }, (_, i) => (i / (n - 1)) * T);
    const tracks: number[][] = [];
    let root: number[] | null = null;
    let keys = 0;
    let speed = 0;
    for (const track of clip.tracks) {
      const [node, prop] = track.name.split('.');
      const b = bi.get(node);
      if (b === undefined) continue;
      if (prop === 'quaternion') {
        const it = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
        const at = (tt: number, out: THREE.Quaternion) => out.fromArray(it.evaluate(tt) as unknown as number[]);
        const qs: THREE.Quaternion[] = [];
        for (let i = 0; i < n; i++) {
          const tt = times[i];
          at(t0 + tt, qa);
          if (F > 0 && tt < F) {
            // loop: the start blends from what follows the end
            at(t0 + T + tt, qb);
            qc.copy(qb).slerp(qa, smooth(tt / F));
            qs.push(qc.clone().normalize());
          } else qs.push(qa.clone().normalize());
        }
        // hemisphere continuity
        for (let i = 1; i < n; i++) if (qs[i].dot(qs[i - 1]) < 0) qs[i].set(-qs[i].x, -qs[i].y, -qs[i].z, -qs[i].w);
        const keep = reduce(qs, /Finger/.test(node) ? tol.finger : tol.body);
        tracks.push([b, keep.length, T16.length, Q16.length]);
        for (const i of keep) {
          T16.push(Math.round(times[i] * 1000));
          Q16.push(...[qs[i].x, qs[i].y, qs[i].z, qs[i].w].map((x) => Math.round(x * 32767)));
        }
        keys += keep.length;
      } else if (prop === 'position' && node === 'Bip01') {
        const it = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
        const P: number[][] = [];
        for (let i = 0; i < n; i++) {
          const tt = times[i];
          const a = Array.from(it.evaluate(t0 + tt) as unknown as number[]);
          if (F > 0 && tt < F) {
            const c = Array.from(it.evaluate(t0 + T + tt) as unknown as number[]);
            const k = smooth(tt / F);
            P.push(a.map((x, j) => c[j] + (x - c[j]) * k));
          } else P.push(a);
        }
        // relative to the reference rest height, in metres; the travel taken out (a straight line from the first to the last frame)
        root = [n, T16.length, P32.length];
        for (let i = 0; i < n; i++) {
          const u = i / (n - 1);
          let x = P[i][0] - P[0][0], z = P[i][2] - P[0][2];
          if (spec.inPlace) {
            x -= (P[n - 1][0] - P[0][0]) * u;
            z -= (P[n - 1][2] - P[0][2]) * u;
          }
          T16.push(Math.round(times[i] * 1000));
          P32.push(+(x * 0.01).toFixed(4), +((P[i][1] - rootRest.y) * 0.01).toFixed(4), +(z * 0.01).toFixed(4));
        }
        keys += n;
        const travel = Math.hypot(P[n - 1][0] - P[0][0], P[n - 1][2] - P[0][2]) * 0.01;
        if (travel > 0.05) log.push(`${spec.name}: travel ${travel.toFixed(2)} m over ${T.toFixed(2)} s (${(travel / T).toFixed(2)} m/s)`);
        speed = travel / T;
      }
    }
    clips.push({ name: spec.name, duration: +T.toFixed(3), speed: +speed.toFixed(3), tracks, root });
    keysTotal += keys;
    log.push(`${spec.name} ← ${gender}_${spec.src}: ${T.toFixed(2)} s of ${clip.duration.toFixed(2)}, ${keys} keys`);
  }
  log.push(`keys ${keysTotal}`);
  let js = JSON.stringify({ bones, clips });
  while ((js.length + 8) % 4) js += ' ';
  const jb = new TextEncoder().encode(js);
  const t16 = new Uint16Array(T16.length + (T16.length % 2));
  t16.set(T16);
  const q16 = Int16Array.from(Q16);
  const p32 = Float32Array.from(P32);
  const out = new Uint8Array(8 + jb.length + 12 + t16.byteLength + q16.byteLength + p32.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x31414252, true);
  dv.setUint32(4, jb.length, true);
  out.set(jb, 8);
  let o = 8 + jb.length;
  dv.setUint32(o, t16.length, true);
  dv.setUint32(o + 4, q16.length, true);
  dv.setUint32(o + 8, p32.length, true);
  o += 12;
  for (const arr of [t16, q16, p32]) {
    out.set(new Uint8Array(arr.buffer), o);
    o += arr.byteLength;
  }
  return { files: { [`anims_${gender}.bin`]: b64(out) }, meta: { bytes: out.length, log } };
}

function smooth(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** greedy keyframe reduction: drop keys the neighbours' slerp reproduces within `tol` (radians) */
function reduce(qs: THREE.Quaternion[], tol: number): number[] {
  const n = qs.length;
  const keep = [0];
  const q = new THREE.Quaternion();
  let a = 0;
  // constant track
  let still = true;
  for (let i = 1; i < n && still; i++) if (qs[i].angleTo(qs[0]) > tol) still = false;
  if (still) return [0];
  while (a < n - 1) {
    let b = a + 2;
    // extend the segment while every key in between is within tolerance
    for (; b < n; b++) {
      let ok = true;
      for (let k = a + 1; k < b && ok; k++) {
        q.slerpQuaternions(qs[a], qs[b], (k - a) / (b - a));
        if (q.angleTo(qs[k]) > tol) ok = false;
      }
      if (!ok) break;
    }
    a = b - 1;
    keep.push(a);
  }
  return keep;
}

// ------------------------------------------------------------------------------------ hooks for the build script
const W = window as unknown as Record<string, unknown>;
W.__rbAvatar = (name: string, opts?: { tex?: number; ntex?: number; hair?: number }) => convertAvatar(name, opts);
W.__rbAnims = (g: 'm' | 'f', specs: ClipSpec[], bones: string[]) => convertAnims(g, specs, bones);
W.__ready = true;
