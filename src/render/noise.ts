import * as THREE from 'three';

/** a seeded PRNG (mulberry32) */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A tileable noise texture: four fbm octave mixes in r, g, b, a (value noise on a wrapped
 * lattice), at `size`², repeat-wrapped with mipmaps. r: broad, g: medium, b: fine, a: cellular-ish.
 */
let shared: THREE.DataTexture | null = null;
export function noiseTexture(size = 512): THREE.DataTexture {
  if (shared) return shared;
  const R = rng(1337);
  const lattice = (n: number) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = R();
    return g;
  };
  const sample = (g: Float32Array, n: number, x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % n) + n) % n, i1 = (i0 + 1) % n, j0 = ((yi % n) + n) % n, j1 = (j0 + 1) % n;
    const a = g[j0 * n + i0], b = g[j0 * n + i1], c = g[j1 * n + i0], d = g[j1 * n + i1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const fbm = (base: number, oct: number, gain = 0.5) => {
    const layers = Array.from({ length: oct }, (_, o) => ({ n: base << o, g: lattice(base << o) }));
    return (u: number, v: number) => {
      let s = 0, amp = 1, norm = 0;
      for (const L of layers) {
        s += sample(L.g, L.n, u * L.n, v * L.n) * amp;
        norm += amp;
        amp *= gain;
      }
      return s / norm;
    };
  };
  const fr = fbm(4, 5, 0.55), fg = fbm(16, 4, 0.5), fb = fbm(64, 3, 0.5);
  // cellular: distance to jittered points on a wrapped grid
  const CN = 24;
  const pts = Array.from({ length: CN * CN }, () => [R(), R()]);
  const cell = (u: number, v: number) => {
    const x = u * CN, y = v * CN;
    const xi = Math.floor(x), yi = Math.floor(y);
    let d = 9;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i, cy = yi + j;
        const p = pts[(((cy % CN) + CN) % CN) * CN + (((cx % CN) + CN) % CN)];
        const dx = cx + p[0] - x, dy = cy + p[1] - y;
        d = Math.min(d, dx * dx + dy * dy);
      }
    return Math.min(1, Math.sqrt(d));
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, o = (y * size + x) * 4;
      data[o] = Math.round(fr(u, v) * 255);
      data[o + 1] = Math.round(fg(u, v) * 255);
      data[o + 2] = Math.round(fb(u, v) * 255);
      data[o + 3] = Math.round(cell(u, v) * 255);
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return (shared = t);
}

const loader = new THREE.TextureLoader();
const cache = new Map<string, Promise<THREE.Texture>>();
/** a repeat-wrapped texture from public/tex */
export function tex(name: string, srgb: boolean, aniso = 8): Promise<THREE.Texture> {
  const key = name + srgb;
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(import.meta.env.BASE_URL + 'tex/' + name).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso;
      return t;
    });
    cache.set(key, p);
  }
  return p;
}

/** sRGB hex → linear THREE.Color */
export function lin(hex: string | number): THREE.Color {
  return new THREE.Color(hex as THREE.ColorRepresentation);
}
