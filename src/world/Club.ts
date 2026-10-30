import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GFX } from '../render/gfx.ts';
import { HW, FLOOR_HX, FLOOR_HZ, POST_X, NET_POST } from '../sim/dims.ts';
import { lin, rng, noiseTexture } from '../render/noise.ts';
import type { Venue } from './venues.ts';

/** a seat the crowd can sit in (world position of the seat, facing direction) */
export interface SeatSpot {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  tier: number;
  row: number;
  /** 0..1 how much roof is overhead (shades the impostors) */
  cover: number;
}

/** courts sit side by side across x, one every SPACING metres (the main court at x = 0) */
export const SPACING = FLOOR_HX * 2 + 0.6;
/** the outer fence of the complex */
export const FENCE = { x: SPACING * 1.5, zFar: -FLOOR_HZ, zNear: 17 };
const FENCE_H = 3.6;
const SCREEN_H = 1.9;

const ART = import.meta.env.BASE_URL + 'art/';
const loader = new THREE.TextureLoader();
function art(name: string, srgb = true): Promise<THREE.Texture> {
  return loader.loadAsync(ART + name).then((t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/**
 * The club around the court: a fenced bank of three courts (the neighbours with their own
 * nets and divider netting), windscreens printed with the club's banners, a chain-link fence
 * over them, LED light poles, aluminium bleachers under shade sails behind the far baseline
 * (the crowd sits there), the clubhouse with warm windows and its sign, palms, hedges,
 * festoon lights strung over the spectators, a distant tree line, and the courtside bits
 * (scoreboard, benches, coolers, paddle bags).
 */
export class Club {
  readonly group = new THREE.Group();
  readonly seats: SeatSpot[] = [];
  /** emissive materials that glow at dusk / night (bulbs, windows, fixtures) */
  private glow: { mat: THREE.MeshStandardMaterial; day: number; night: number }[] = [];
  private board: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null = null;
  /** every frond of every palm in one instanced draw (pos, yaw, pitch, scale, phase per frond) */
  private fronds: { mesh: THREE.InstancedMesh; data: { p: THREE.Vector3; yaw: number; pitch: number; s: number; ph: number }[] } | null = null;
  private t = 0;
  private frame = 0;
  logo: THREE.Texture | null = null;

  constructor(readonly venue: Venue) {
    this.group.name = 'club';
  }

  async build() {
    const [bannerA, bannerB, frond, logo] = await Promise.all([art('banner_a.jpg'), art('banner_b.jpg'), art('frond.webp'), art('logo.webp')]);
    this.logo = logo;
    this.ground();
    this.fences(bannerA, bannerB);
    this.neighbours();
    this.lightPoles();
    this.bleachers();
    this.clubhouse(logo);
    this.palms(frond);
    this.hedges();
    this.festoons();
    this.treeline();
    this.copses();
    this.courtside();
    this.bake();
  }

  /** static meshes that share a material become one mesh (draw calls are what a TV box's CPU runs out of) */
  private bake() {
    this.group.updateMatrixWorld(true);
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    for (const o of [...this.group.children]) {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material) || m.children.length) continue;
      const list = byMat.get(m.material as THREE.Material) ?? [];
      list.push(m);
      byMat.set(m.material as THREE.Material, list);
    }
    for (const [mat, list] of byMat) {
      if (list.length < 2) continue;
      const geos = list.map((m) => {
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        return g.applyMatrix4(m.matrix);
      });
      const merged = new THREE.Mesh(mergeGeo(geos), mat);
      merged.castShadow = list.some((m) => m.castShadow);
      merged.receiveShadow = list.some((m) => m.receiveShadow);
      merged.renderOrder = list[0].renderOrder;
      for (const m of list) this.group.remove(m);
      this.group.add(merged);
    }
  }

  // ---------------------------------------------------------------------------------- ground
  private ground() {
    // grass outside the complex (the court plane covers the fenced area)
    const nz = noiseTexture();
    const m = new THREE.MeshStandardMaterial({ color: lin('#4f7a3a'), roughness: 0.95 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNoise = { value: nz };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;\nuniform sampler2D uNoise;')
        .replace('#include <map_fragment>', /* glsl */ `
          vec4 n1 = texture2D( uNoise, vGW.xz * 0.03 );
          vec4 n2 = texture2D( uNoise, vGW.xz * 0.4 );
          vec4 n3 = texture2D( uNoise, vGW.xz * 3.1 );
          diffuseColor.rgb *= ( 0.75 + 0.5 * n1.r ) * ( 0.85 + 0.3 * n2.g ) * ( 0.9 + 0.2 * n3.b );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.25, 1.15, 0.7 ), smoothstep( 0.55, 0.8, n1.g ) * 0.6 );`);
    };
    m.customProgramCacheKey = () => 'grass-v1';
    const g = new THREE.Mesh(new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2), m);
    g.position.y = -0.01;
    g.receiveShadow = true;
    this.group.add(g);
    // a concrete apron + path between the far fence and the clubhouse
    const conc = new THREE.MeshStandardMaterial({ color: lin('#b9b3a8'), roughness: 0.85 });
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(FENCE.x * 2 + 2, 16).rotateX(-Math.PI / 2), conc);
    apron.position.set(0, 0.0, FENCE.zFar - 8);
    apron.receiveShadow = true;
    this.group.add(apron);
  }

  // ---------------------------------------------------------------------------------- fences
  private fences(bannerA: THREE.Texture, bannerB: THREE.Texture) {
    const v = this.venue;
    const steel = new THREE.MeshStandardMaterial({ color: lin(v.steel), roughness: 0.45, metalness: 0.6 });
    // chain link: a diamond mesh canvas, alpha-tested; mips fade it to a haze far away
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.strokeStyle = '#2b2e31';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(0, 64); g.lineTo(64, 0); g.lineTo(128, 64); g.lineTo(64, 128); g.closePath();
    g.moveTo(-64, 64); g.lineTo(0, 128); g.moveTo(128, 0); g.lineTo(192, 64);
    g.moveTo(64, -64); g.lineTo(0, 0); g.moveTo(128, 128); g.lineTo(64, 192);
    g.stroke();
    const linkTex = new THREE.CanvasTexture(c);
    linkTex.wrapS = linkTex.wrapT = THREE.RepeatWrapping;
    linkTex.colorSpace = THREE.SRGBColorSpace;
    linkTex.anisotropy = 8;
    const link = new THREE.MeshStandardMaterial({ map: linkTex, transparent: true, alphaTest: 0.12, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.5, depthWrite: false });
    const plain = new THREE.MeshStandardMaterial({ color: lin(v.screen), roughness: 0.9, side: THREE.DoubleSide });
    const bA = new THREE.MeshStandardMaterial({ map: bannerA, roughness: 0.85, side: THREE.DoubleSide });
    const bB = new THREE.MeshStandardMaterial({ map: bannerB, roughness: 0.85, side: THREE.DoubleSide });
    const cell = 0.06; // a 6 cm diamond

    const posts: THREE.BufferGeometry[] = [];
    /** a fence run from a to b (x/z on the floor); `open` leaves the windscreen off between u0..u1 metres */
    const run = (ax: number, az: number, bx: number, bz: number, opts: { banners?: boolean; open?: [number, number] } = {}) => {
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      const yaw = Math.atan2(-dz, dx);
      const mid = new THREE.Vector3((ax + bx) / 2, 0, (az + bz) / 2);
      // chain link full height
      const lg = new THREE.PlaneGeometry(len, FENCE_H);
      const uv = lg.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * len) / cell, (uv.getY(i) * FENCE_H) / cell);
      const lm = new THREE.Mesh(lg, link);
      lm.position.copy(mid).setY(FENCE_H / 2);
      lm.rotation.y = yaw;
      lm.renderOrder = 1;
      this.group.add(lm);
      // windscreen panels (banners every other panel where asked)
      const panels = Math.max(1, Math.round(len / 4.6));
      const pw = len / panels;
      for (let k = 0; k < panels; k++) {
        const u0 = k * pw, u1 = u0 + pw;
        if (opts.open && u1 > opts.open[0] && u0 < opts.open[1]) continue;
        const banner = opts.banners && k % 2 === 1;
        const mat = banner ? (k % 4 === 1 ? bA : bB) : plain;
        const pm = new THREE.Mesh(new THREE.PlaneGeometry(pw - 0.06, SCREEN_H), mat);
        const cx = ax + dx * (u0 + pw / 2), cz = az + dz * (u0 + pw / 2);
        pm.position.set(cx, SCREEN_H / 2 + 0.05, cz);
        pm.rotation.y = yaw;
        pm.receiveShadow = true;
        pm.castShadow = true;
        this.group.add(pm);
      }
      // posts every ~3 m, top + mid rails
      const n = Math.max(1, Math.round(len / 3));
      for (let k = 0; k <= n; k++) {
        const p = new THREE.CylinderGeometry(0.045, 0.045, FENCE_H + 0.05, 10);
        p.translate(ax + dx * (len * k) / n, (FENCE_H + 0.05) / 2, az + dz * (len * k) / n);
        posts.push(p);
      }
      for (const y of [FENCE_H, SCREEN_H + 0.05]) {
        const r = new THREE.CylinderGeometry(0.025, 0.025, len, 8).rotateZ(Math.PI / 2).rotateY(yaw);
        r.translate(mid.x, y, mid.z);
        posts.push(r);
      }
    };
    const X = FENCE.x, Zf = FENCE.zFar, Zn = FENCE.zNear;
    // far fence: open (no windscreen) in front of the bleachers
    run(-X, Zf, X, Zf, { banners: true, open: [X - 8.2, X + 8.2] });
    run(X, Zf, X, Zn, { banners: true });
    run(-X, Zn, -X, Zf, { banners: true });
    run(X, Zn, -X, Zn, {});
    const pm = new THREE.Mesh(mergeGeo(posts), steel);
    pm.castShadow = true;
    this.group.add(pm);

    // dividers between the courts: waist-high black netting on a rail
    const div: THREE.BufferGeometry[] = [];
    const netMat = new THREE.MeshStandardMaterial({ color: 0x0d0f10, roughness: 0.9, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false });
    for (const sx of [-1, 1]) {
      const x = sx * SPACING / 2;
      const len = Zn - 4 - Zf;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.95), netMat);
      m.rotation.y = Math.PI / 2;
      m.position.set(x, 0.5, (Zf + Zn - 4) / 2);
      this.group.add(m);
      const rail = new THREE.CylinderGeometry(0.022, 0.022, len, 8).rotateX(Math.PI / 2);
      rail.translate(x, 1.0, (Zf + Zn - 4) / 2);
      div.push(rail);
      for (let z = Zf; z <= Zn - 4 + 0.01; z += 3) {
        const p = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 8);
        p.translate(x, 0.5, z);
        div.push(p);
      }
    }
    const dm = new THREE.Mesh(mergeGeo(div), steel);
    dm.castShadow = true;
    this.group.add(dm);
  }

  // ---------------------------------------------------------------------------------- neighbour courts
  private neighbours() {
    // their nets (the court plane paints their lines)
    for (const sx of [-1, 1]) {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(POST_X * 2, NET_POST - 0.05), new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.9, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.y = (NET_POST - 0.05) / 2 + 0.03;
      const band = new THREE.Mesh(new THREE.BoxGeometry(POST_X * 2, 0.06, 0.012), new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: 0.5 }));
      band.position.y = NET_POST - 0.02;
      band.castShadow = true;
      g.add(mesh, band);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, NET_POST + 0.02, 10), new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.4, metalness: 0.5 }));
        post.position.set(s * (POST_X + 0.02), (NET_POST + 0.02) / 2, 0);
        post.castShadow = true;
        g.add(post);
      }
      g.position.x = sx * SPACING;
      this.group.add(g);
    }
  }

  // ---------------------------------------------------------------------------------- light poles
  private lightPoles() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x8e959b, roughness: 0.35, metalness: 0.85 });
    const head = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5, metalness: 0.4 });
    const lens = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff4e2, emissiveIntensity: 0, roughness: 0.2 });
    this.glow.push({ mat: lens, day: 0, night: 6 });
    const parts: THREE.BufferGeometry[] = [], heads: THREE.BufferGeometry[] = [], lenses: THREE.BufferGeometry[] = [];
    const H = 8.2;
    for (const px of [-SPACING * 1.5, -SPACING / 2, SPACING / 2, SPACING * 1.5]) for (const pz of [FENCE.zFar - 0.25, 10.2]) {
      const p = new THREE.CylinderGeometry(0.07, 0.11, H, 12);
      p.translate(px, H / 2, pz);
      parts.push(p);
      // two LED heads on a cross arm, tilted toward the court centre
      for (const off of [-0.45, 0.45]) {
        const toCx = -Math.sign(px) * (Math.abs(px) < SPACING ? 1 : 0);
        const hx = px + off, hz = pz;
        const tilt = 0.55 * Math.sign(-pz);
        const b = new THREE.BoxGeometry(0.62, 0.1, 0.42).rotateX(tilt).rotateY(toCx * 0.3);
        b.translate(hx, H + 0.05, hz);
        heads.push(b);
        const l = new THREE.PlaneGeometry(0.54, 0.34).rotateX(Math.PI / 2 + tilt).rotateY(toCx * 0.3);
        l.translate(hx, H - 0.005, hz + Math.sign(-pz) * 0.02);
        lenses.push(l);
      }
      const arm = new THREE.BoxGeometry(1.3, 0.06, 0.06);
      arm.translate(px, H + 0.12, pz);
      parts.push(arm);
    }
    const pm = new THREE.Mesh(mergeGeo(parts), steel);
    pm.castShadow = true;
    const hm = new THREE.Mesh(mergeGeo(heads), head);
    hm.castShadow = true;
    const lm = new THREE.Mesh(mergeGeo(lenses), lens);
    lm.material.side = THREE.DoubleSide;
    this.group.add(pm, hm, lm);
  }

  // ---------------------------------------------------------------------------------- bleachers
  private bleachers() {
    const alu = new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.32, metalness: 0.85 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x6d7378, roughness: 0.5, metalness: 0.7 });
    const W = 15.5, ROWS = 6, D = 0.62, RISE = 0.42;
    const z0 = FENCE.zFar - 1.1;
    const planks: THREE.BufferGeometry[] = [], legs: THREE.BufferGeometry[] = [];
    for (let r = 0; r < ROWS; r++) {
      const z = z0 - r * D, y = 0.45 + r * RISE;
      // seat plank + foot plank
      const s = new THREE.BoxGeometry(W, 0.045, 0.27);
      s.translate(0, y, z - 0.12);
      planks.push(s);
      const f = new THREE.BoxGeometry(W, 0.035, 0.22);
      f.translate(0, y - 0.4, z + 0.15);
      planks.push(f);
      for (let k = 0; k < Math.floor(W / 0.56); k++) {
        const x = -W / 2 + 0.3 + k * 0.56;
        this.seats.push({ x, y: y + 0.02, z: z - 0.12, nx: 0, nz: 1, tier: 0, row: r, cover: 0.55 });
      }
    }
    for (let k = 0; k <= 6; k++) {
      const x = -W / 2 + 0.2 + (k * (W - 0.4)) / 6;
      // a sloped stringer and the uprights
      const len = Math.hypot(ROWS * D, ROWS * RISE);
      const st = new THREE.BoxGeometry(0.06, 0.18, len).rotateX(Math.atan2(RISE, D));
      st.translate(x, 0.2 + (ROWS * RISE) / 2, z0 - (ROWS * D) / 2 + 0.2);
      legs.push(st);
      for (const r of [0, 3, ROWS - 1]) {
        const y = 0.45 + r * RISE;
        const up = new THREE.BoxGeometry(0.05, y, 0.05);
        up.translate(x, y / 2, z0 - r * D - 0.12);
        legs.push(up);
      }
    }
    // back rail
    const br = new THREE.CylinderGeometry(0.025, 0.025, W, 8).rotateZ(Math.PI / 2);
    br.translate(0, 0.45 + ROWS * RISE + 0.6, z0 - ROWS * D + 0.2);
    legs.push(br);
    const pm = new THREE.Mesh(mergeGeo(planks), alu);
    pm.castShadow = pm.receiveShadow = true;
    const lm = new THREE.Mesh(mergeGeo(legs), frame);
    lm.castShadow = true;
    this.group.add(pm, lm);
    // shade sails: three tensioned triangles over the stands
    const cols = ['#ff7a59', '#f6ead2', '#2aa3a0'];
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xe9e7e2, roughness: 0.4, metalness: 0.3 });
    const zc = z0 - (ROWS * D) / 2;
    const sails: [number, number, number][][] = [
      [[-9, 5.2, z0 + 0.4], [-1.5, 4.6, z0 - 4.6], [-8.2, 6.4, z0 - 5.2]],
      [[-3.5, 5.6, z0 + 0.6], [4.2, 5.0, z0 + 0.2], [0.4, 6.6, z0 - 5.0]],
      [[2.0, 4.8, z0 - 4.8], [9.2, 5.4, z0 + 0.3], [8.6, 6.2, z0 - 5.0]],
    ];
    void zc;
    sails.forEach((tri, i) => {
      const g = sailGeo(tri.map((p) => new THREE.Vector3(...p)), 0.35);
      const m = new THREE.MeshStandardMaterial({ color: lin(cols[i]), roughness: 0.85, side: THREE.DoubleSide, transparent: false });
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      for (const p of tri) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, p[1] + 0.3, 10), poleMat);
        pole.position.set(p[0] + Math.sign(p[0] || 1) * 0.05, (p[1] + 0.3) / 2, p[2]);
        pole.castShadow = true;
        this.group.add(pole);
      }
    });
  }

  // ---------------------------------------------------------------------------------- clubhouse
  private clubhouse(logo: THREE.Texture) {
    const z = FENCE.zFar - 15.5;
    const stucco = worldPattern(new THREE.MeshStandardMaterial({ color: lin('#e4cfb2'), roughness: 0.92 }), 'stucco', /* glsl */ `
      vec4 a = texture2D( uNoise, vGW.xy * vec2( 0.09, 0.12 ) + vGW.z * 0.05 );
      vec4 b = texture2D( uNoise, vGW.xy * 1.7 + vGW.zx * 1.3 );
      float grime = smoothstep( 1.4, 0.0, vGW.y ) * 0.22 + smoothstep( 0.55, 0.85, a.r ) * 0.08;
      diffuseColor.rgb *= ( 0.94 + 0.1 * a.g ) * ( 0.95 + 0.08 * b.b ) * ( 1.0 - grime );`);
    const trim = new THREE.MeshStandardMaterial({ color: lin('#2b4a5e'), roughness: 0.6 });
    // terracotta: courses of barrel tiles down the slope, each tile shaded round, the odd one off-colour
    const roofM = worldPattern(new THREE.MeshStandardMaterial({ color: lin('#b8643f'), roughness: 0.75 }), 'tiles', /* glsl */ `
      vec2 tp = vec2( ( vGW.x + vGW.z ) / 0.26, vGW.y / 0.11 );
      float row = floor( tp.y );
      float fx = fract( tp.x + 0.5 * mod( row, 2.0 ) );
      float fy = fract( tp.y );
      float barrel = sin( fx * 3.14159 );
      vec4 tn = texture2D( uNoise, vec2( floor( tp.x ) * 0.071, row * 0.113 ) );
      diffuseColor.rgb *= ( 0.55 + 0.5 * barrel ) * ( 0.75 + 0.3 * smoothstep( 0.0, 0.25, fy ) ) * ( 0.85 + 0.3 * tn.r );
      diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.8, 0.75, 0.7 ), step( 0.8, tn.g ) * 0.6 );`);
    const wood = new THREE.MeshStandardMaterial({ color: lin('#8a5a36'), roughness: 0.7 });
    const W = 24, H = 7.6, D = 9;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), stucco);
    body.position.set(0, H / 2, z - D / 2);
    body.castShadow = body.receiveShadow = true;
    this.group.add(body);
    // a low hipped roof
    const roof = new THREE.Mesh(hipRoof(W + 1.2, D + 1.2, 1.8), roofM);
    roof.position.set(0, H, z - D / 2);
    roof.castShadow = true;
    this.group.add(roof);
    // windows: glass over a lit room (a painted interior: ceiling lights, a counter, chairs,
    // people), the panes split by mullions; the glass reflects the sky
    const room = interiorTexture();
    const win = new THREE.MeshStandardMaterial({ color: lin('#9aa3ab'), map: room, emissive: 0xffffff, emissiveMap: room, emissiveIntensity: 0.4, roughness: 0.06, metalness: 0.35, envMapIntensity: 1.4 });
    this.glow.push({ mat: win, day: 0.25, night: 2.2 });
    const wins: THREE.BufferGeometry[] = [], frames: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 7; k++) {
      const x = -W / 2 + 2.2 + k * ((W - 4.4) / 6);
      if (k === 3) {
        // the doors
        const d = new THREE.PlaneGeometry(2.4, 2.6);
        d.translate(x, 1.3, z + 0.02);
        wins.push(d);
        continue;
      }
      const w = new THREE.PlaneGeometry(2.1, 1.7);
      w.translate(x, 2.1, z + 0.02);
      wins.push(w);
      const f = new THREE.BoxGeometry(2.3, 0.1, 0.12);
      f.translate(x, 1.2, z + 0.06);
      frames.push(f, f.clone().translate(0, 1.8, 0));
    }
    // the upper floor: a row of tall windows behind a balcony rail, a trim band between the floors
    for (let k = 0; k < 9; k++) {
      const x = -W / 2 + 1.7 + k * ((W - 3.4) / 8);
      const w = new THREE.PlaneGeometry(1.6, 1.9);
      w.translate(x, 5.4, z + 0.02);
      wins.push(w);
    }
    const band = new THREE.BoxGeometry(W + 0.2, 0.35, 0.3);
    band.translate(0, 3.9, z + 0.1);
    frames.push(band);
    const deck = new THREE.BoxGeometry(W - 2, 0.16, 1.5);
    deck.translate(0, 4.1, z + 0.75);
    frames.push(deck);
    const rail = new THREE.BoxGeometry(W - 2, 0.06, 0.06);
    rail.translate(0, 5.0, z + 1.48);
    frames.push(rail);
    for (let k = 0; k <= 22; k++) {
      const b = new THREE.BoxGeometry(0.04, 0.9, 0.04);
      b.translate(-W / 2 + 1 + k * ((W - 2) / 22), 4.6, z + 1.48);
      frames.push(b);
    }
    this.group.add(new THREE.Mesh(mergeGeo(wins), win));
    const fm = new THREE.Mesh(mergeGeo(frames), trim);
    this.group.add(fm);
    // the sign: the club logo on the fascia
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 7.4 * (702 / 1200)), new THREE.MeshStandardMaterial({ map: logo, transparent: true, alphaTest: 0.4, roughness: 0.5, emissive: 0xffffff, emissiveMap: logo, emissiveIntensity: 0.05 }));
    this.glow.push({ mat: sign.material as THREE.MeshStandardMaterial, day: 0.05, night: 0.6 });
    sign.position.set(0, H + 1.4, z + 0.35);
    this.group.add(sign);
    // pergola across the front
    const per: THREE.BufferGeometry[] = [];
    for (let k = 0; k <= 8; k++) {
      const x = -W / 2 + 1 + k * ((W - 2) / 8);
      const p = new THREE.BoxGeometry(0.18, 2.9, 0.18);
      p.translate(x, 1.45, z + 3.2);
      per.push(p);
    }
    for (let k = 0; k < 26; k++) {
      const x = -W / 2 + 0.5 + k * ((W - 1) / 25);
      const s = new THREE.BoxGeometry(0.08, 0.2, 3.6);
      s.translate(x, 3.0, z + 1.6);
      per.push(s);
    }
    for (const zz of [z + 3.2, z + 0.3]) {
      const b = new THREE.BoxGeometry(W - 1.2, 0.22, 0.14);
      b.translate(0, 2.85, zz);
      per.push(b);
    }
    const pm = new THREE.Mesh(mergeGeo(per), wood);
    pm.castShadow = pm.receiveShadow = true;
    this.group.add(pm);
    // café tables + umbrellas on the patio
    const R = rng(7);
    const umb = ['#ff7a59', '#2aa3a0', '#f6ead2', '#ffb347'];
    for (let k = 0; k < 6; k++) {
      const x = -W / 2 + 2.5 + k * 3.8 + (R() - 0.5);
      const zz = z + 5.4 + (R() - 0.5) * 1.2;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 20), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
      t.position.set(x, 0.74, zz);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.6, roughness: 0.4 }));
      leg.position.set(x, 1.2, zz);
      const u = new THREE.Mesh(new THREE.ConeGeometry(1.25, 0.45, 8, 1, true), new THREE.MeshStandardMaterial({ color: lin(umb[k % 4]), roughness: 0.8, side: THREE.DoubleSide }));
      u.position.set(x, 2.35, zz);
      for (const o of [t, leg, u]) { o.castShadow = true; this.group.add(o); }
    }
  }

  // ---------------------------------------------------------------------------------- palms
  private palms(frondTex: THREE.Texture) {
    const R = rng(21);
    // bark: rings of old frond bases on a canvas
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#7a6650';
    g.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 256; y += 8) {
      g.fillStyle = `rgba(40,30,20,${0.35 + Math.random() * 0.2})`;
      g.fillRect(0, y, 64, 2 + Math.random() * 2);
      g.fillStyle = `rgba(200,180,150,${0.15 + Math.random() * 0.15})`;
      g.fillRect(0, y + 3, 64, 2);
    }
    const bark = new THREE.CanvasTexture(c);
    bark.wrapS = bark.wrapT = THREE.RepeatWrapping;
    bark.colorSpace = THREE.SRGBColorSpace;
    const trunkMat = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 });
    const frondMat = new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.65 });
    // light passing through the leaves: a touch of translucency via emissive from the map
    frondMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3( 0.06, 0.08, 0.02 );');
    };
    frondMat.customProgramCacheKey = () => 'frond-v1';
    const frondGeo = frondGeometry();
    const trunks: THREE.BufferGeometry[] = [];
    const fronds: { p: THREE.Vector3; yaw: number; pitch: number; s: number; ph: number }[] = [];
    const spots: [number, number][] = [];
    // behind the clubhouse and around the patio, down both sides, the far corners
    for (let k = 0; k < 9; k++) spots.push([-30 + k * 7.5 + (R() - 0.5) * 3, FENCE.zFar - 28 - R() * 6]);
    for (const x of [-15, -10.5, 10.5, 15]) spots.push([x, FENCE.zFar - 9.5 + (R() - 0.5)]);
    for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) spots.push([sx * (FENCE.x + 3 + R() * 3), FENCE.zFar + 2 + k * 6 + R() * 2]);
    for (const [x, z] of spots) {
      const h = 7 + R() * 5;
      const lean = (R() - 0.5) * 0.35, leanDir = R() * Math.PI * 2;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const u = i / 8;
        const off = Math.sin(lean) * h * u * u;
        pts.push(new THREE.Vector3(x + Math.cos(leanDir) * off, u * h, z + Math.sin(leanDir) * off));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tg = new THREE.TubeGeometry(curve, 16, 0.2, 8, false);
      // taper: thinner toward the crown
      const pa = tg.getAttribute('position') as THREE.BufferAttribute;
      const ua = tg.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) {
        const u = ua.getX(i);
        const ctr = curve.getPoint(u);
        const k = 1.25 - 0.45 * u;
        pa.setXYZ(i, ctr.x + (pa.getX(i) - ctr.x) * k, pa.getY(i), ctr.z + (pa.getZ(i) - ctr.z) * k);
        ua.setXY(i, ua.getY(i), u * h * 1.5);
      }
      tg.computeVertexNormals();
      trunks.push(tg);
      const top = pts[8];
      const n = 14;
      for (let i = 0; i < n; i++) {
        const yaw = (i / n) * Math.PI * 2 + R() * 0.4;
        const pitch = i % 2 ? 0.15 + R() * 0.3 : -0.25 - R() * 0.35;
        fronds.push({ p: top.clone(), yaw, pitch, s: 2.2 + R() * 0.9, ph: R() * 10 });
      }
    }
    // one draw for all the trunks, one for all the fronds
    const tm = new THREE.Mesh(mergeGeo(trunks), trunkMat);
    tm.castShadow = true;
    this.group.add(tm);
    const im = new THREE.InstancedMesh(frondGeo, frondMat, fronds.length);
    im.castShadow = true;
    im.frustumCulled = false;
    this.group.add(im);
    this.fronds = { mesh: im, data: fronds };
    this.swayFronds();
  }

  private swayFronds() {
    const f = this.fronds;
    if (!f) return;
    const e = new THREE.Euler(0, 0, 0, 'YXZ'), q = new THREE.Quaternion(), m = new THREE.Matrix4(), sc = new THREE.Vector3();
    f.data.forEach((d, i) => {
      e.set(0, d.yaw, d.pitch + Math.sin(this.t * 1.3 + d.ph) * 0.035 + Math.sin(this.t * 0.37 + d.ph * 2) * 0.03);
      q.setFromEuler(e);
      m.compose(d.p, q, sc.setScalar(d.s));
      f.mesh.setMatrixAt(i, m);
    });
    f.mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------- hedges
  private hedges() {
    const nz = noiseTexture();
    const m = new THREE.MeshStandardMaterial({ color: lin('#355d2c'), roughness: 0.95 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNoise = { value: nz };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vHW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvHW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vHW;\nuniform sampler2D uNoise;')
        .replace('#include <map_fragment>', /* glsl */ `
          vec4 a = texture2D( uNoise, vHW.xy * 1.7 + vHW.z * 0.9 );
          vec4 b = texture2D( uNoise, vHW.zy * 2.3 + vHW.x * 0.7 );
          float leaf = a.b * 0.6 + b.b * 0.4;
          diffuseColor.rgb *= 0.55 + 0.9 * leaf;
          diffuseColor.rgb *= mix( 0.7, 1.1, smoothstep( 0.0, 1.4, vHW.y ) );`);
    };
    m.customProgramCacheKey = () => 'hedge-v1';
    const parts: THREE.BufferGeometry[] = [];
    const box = (x: number, z: number, w: number, d: number, h: number) => {
      const b = new THREE.BoxGeometry(w, h, d, 4, 2, 4);
      b.translate(x, h / 2, z);
      parts.push(b);
    };
    const X = FENCE.x;
    for (const sx of [-1, 1]) box(sx * (X + 1.0), (FENCE.zFar + FENCE.zNear) / 2, 1.2, FENCE.zNear - FENCE.zFar, 1.5);
    box(-X + 4, FENCE.zFar - 1.0, 8, 1.2, 1.3);
    box(X - 4, FENCE.zFar - 1.0, 8, 1.2, 1.3);
    const mesh = new THREE.Mesh(mergeGeo(parts), m);
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------------------------- festoon lights
  private festoons() {
    const bulbs: THREE.Vector3[] = [];
    const wire: THREE.Vector3[][] = [];
    const strand = (a: THREE.Vector3, b: THREE.Vector3, sag: number, every = 0.55) => {
      const len = a.distanceTo(b);
      const n = Math.max(2, Math.round(len / every));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = a.clone().lerp(b, u);
        p.y -= sag * 4 * u * (1 - u);
        pts.push(p);
        if (i > 0 && i < n) bulbs.push(p.clone().setY(p.y - 0.09));
      }
      wire.push(pts);
    };
    // zig-zag over the bleachers between the sail poles and the light poles, then along the patio
    const zf = FENCE.zFar;
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const top = [P(-16, 6.2, zf - 0.3), P(-9, 5.6, zf - 6.5), P(-3.5, 6.0, zf - 0.4), P(1.5, 6.0, zf - 6.3), P(6.5, 6.0, zf - 0.4), P(11, 5.6, zf - 6.5), P(16, 6.2, zf - 0.3)];
    for (let i = 0; i < top.length - 1; i++) strand(top[i], top[i + 1], 0.8);
    const pz = zf - 12.5;
    for (let i = 0; i < 4; i++) strand(P(-12 + i * 6, 3.2, pz), P(-6 + i * 6, 3.2, pz), 0.5);
    // down the side fences
    for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) {
      const z0 = zf + k * 6.6;
      strand(P(sx * FENCE.x, FENCE_H + 0.3, z0), P(sx * FENCE.x, FENCE_H + 0.3, z0 + 6.6), 0.6);
    }
    const bulbMat = new THREE.MeshStandardMaterial({ color: lin('#fff1cc'), emissive: lin('#ffc977'), emissiveIntensity: 1, roughness: 0.3 });
    this.glow.push({ mat: bulbMat, day: 0.6, night: 9 });
    const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 10, 8), bulbMat, bulbs.length);
    const m4 = new THREE.Matrix4();
    bulbs.forEach((b, i) => inst.setMatrixAt(i, m4.makeTranslation(b.x, b.y, b.z)));
    this.group.add(inst);
    const wg: THREE.BufferGeometry[] = wire.map((pts) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.008, 4, false));
    this.group.add(new THREE.Mesh(mergeGeo(wg), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 })));
  }

  // ---------------------------------------------------------------------------------- distant tree line
  private treeline() {
    // a cylinder band far out whose top edge is cut per pixel: rounded canopies with palms poking
    // above them, darker at the base and hazed toward the sky colour with distance
    // two rings: the woods round the club at 90 m, and a line of hazy hills far behind them
    const g = new THREE.CylinderGeometry(90, 90, 26, 256, 1, true);
    g.translate(0, 12, 0);
    this.treeMat = new THREE.ShaderMaterial({
      uniforms: { uCol: { value: lin('#2a3d33') }, uHaze: { value: lin('#c9a98d') }, uHazeK: { value: 0.35 }, uNoise: { value: noiseTexture() }, uHills: { value: 0 }, uScale: { value: 0.6 } },
      side: THREE.BackSide,
      fog: false,
      defines: GFX.lite ? { LITE: 1 } : {},
      vertexShader: /* glsl */ `
        varying vec3 vP;
        void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol, uHaze; uniform float uHazeK, uHills, uScale; uniform sampler2D uNoise;
        varying vec3 vP;
        float n1( float x ) { return texture2D( uNoise, vec2( x, 0.37 ) ).r; }
        void main() {
          float a = atan( vP.z, vP.x ) / 6.2831853 + 0.5;
          // canopy line: broad hills of trees + bumpy crowns + a few tall palms
          float h = 7.0 + 9.0 * n1( a * 3.0 ) + 4.0 * n1( a * 23.0 );
          if ( uHills > 0.5 ) {
            // long soft ridges, fading into the sky
            h = 14.0 + 30.0 * n1( a * 2.0 + 0.61 ) + 9.0 * n1( a * 9.0 + 0.2 );
            if ( vP.y > h ) discard;
            float th = clamp( vP.y / h, 0.0, 1.0 );
            vec3 hc = mix( uCol * 1.6, uHaze, 0.72 + 0.12 * th );
            gl_FragColor = vec4( hc, 1.0 );
            #include <colorspace_fragment>
            return;
          }
          h *= uScale * 1.35;
          #ifndef LITE
          // crowns: rounded bumps of single trees along the top
          float ca = a * 300.0 + 2.5 * n1( a * 41.0 );
          float cr = fract( ca );
          float ci = floor( ca );
          float cw = 0.55 + 0.45 * n1( ci * 0.0137 + 0.21 );
          h += ( 0.8 + 2.4 * n1( ci * 0.0291 + 0.5 ) ) * sqrt( max( 0.0, 1.0 - pow( ( cr * 2.0 - 1.0 ) / cw, 2.0 ) ) );
          float palm = smoothstep( 0.76, 0.86, n1( a * 61.0 + 0.3 ) );
          float crown = 1.0 - smoothstep( 0.0, 0.006, abs( fract( a * 61.0 * 9.0 ) - 0.5 ) * 0.04 );
          h += palm * ( 6.0 + 4.0 * n1( a * 400.0 ) ) * ( 0.35 + 0.65 * crown );
          #endif
          if ( vP.y > h ) discard;
          float t = clamp( vP.y / max( h, 1.0 ), 0.0, 1.0 );
          #ifdef LITE
          vec3 c = uCol * ( 0.65 + 0.5 * t );
          #else
          vec3 c = uCol * ( 0.65 + 0.5 * t ) * ( 0.85 + 0.3 * texture2D( uNoise, vec2( a * 90.0, vP.y * 0.05 ) ).g );
          // each crown: lit on one side, in shade on the other
          c *= 0.85 + 0.35 * cr * t;
          #endif
          c = mix( c, uHaze, uHazeK * ( 1.0 - 0.6 * t ) );
          gl_FragColor = vec4( c, 1.0 );
          #include <colorspace_fragment>
        }`,
    }) as unknown as THREE.MeshBasicMaterial;
    const m = new THREE.Mesh(g, this.treeMat);
    m.name = 'treeline';
    // after the opaque club: whatever stands in front of it is never shaded
    m.renderOrder = 1;
    this.group.add(m);
    this.hillMat = this.treeMat.clone() as unknown as THREE.ShaderMaterial;
    this.hillMat.uniforms.uHills.value = 1;
    const hg = new THREE.CylinderGeometry(300, 300, 80, 128, 1, true);
    hg.translate(0, 38, 0);
    const hills = new THREE.Mesh(hg, this.hillMat);
    hills.name = 'hills';
    hills.renderOrder = 2;
    this.group.add(hills);
  }
  /** clumps of trees and shrubs out on the grass between the club and the woods */
  private copses() {
    const R = rng(31);
    const geo = mergeVertices(new THREE.IcosahedronGeometry(1, GFX.lite ? 1 : 2).deleteAttribute('normal').deleteAttribute('uv'));
    // lumpy: push the vertices in and out a little
    const pa = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pa, i);
      const k = 1 + 0.18 * Math.sin(v.x * 5.1 + v.y * 3.7) * Math.cos(v.z * 4.3 - v.y * 2.1);
      pa.setXYZ(i, v.x * k, v.y * k * 0.85, v.z * k);
    }
    geo.computeVertexNormals();
    // leaf clumps: light and dark masses across each crown, darker deep inside
    const leaf = worldPattern(new THREE.MeshStandardMaterial({ color: lin('#3d5a2e'), roughness: 0.9 }), 'leaf', /* glsl */ `
      vec4 la = texture2D( uNoise, vGW.xz * 0.33 + vGW.y * 0.21 );
      vec4 lb = texture2D( uNoise, vGW.xy * 1.3 + vGW.zy * 0.9 );
      diffuseColor.rgb *= ( 0.55 + 0.7 * smoothstep( 0.25, 0.75, la.g ) ) * ( 0.78 + 0.44 * lb.r );`);
    const N = GFX.lite ? 70 : 150;
    const im = new THREE.InstancedMesh(geo, leaf, N);
    const trunkG = new THREE.CylinderGeometry(0.14, 0.22, 1, 6);
    const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: lin('#4a3626'), roughness: 0.9 }), N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    let n = 0;
    for (let tries = 0; n < N && tries < N * 20; tries++) {
      const ang = R() * Math.PI * 2, r = 36 + R() * 50;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      // keep the club and the near grounds clear
      if (Math.abs(x) < FENCE.x + 8 && z > FENCE.zFar - 34 && z < FENCE.zNear + 10) continue;
      // clumps: most trees stand near another
      const tree = R() < 0.6;
      const sz = tree ? 2.4 + R() * 2.8 : 0.9 + R() * 1.2;
      const lift = tree ? 2.2 + R() * 3.5 : 0.3;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 6.28);
      m.compose(new THREE.Vector3(x, lift + sz * 0.6, z), q, new THREE.Vector3(sz * (0.9 + R() * 0.3), sz * (0.8 + R() * 0.4), sz * (0.9 + R() * 0.3)));
      im.setMatrixAt(n, m);
      im.setColorAt(n, col.setRGB(0.75 + R() * 0.4, 0.85 + R() * 0.35, 0.6 + R() * 0.3));
      m.compose(new THREE.Vector3(x, (lift + sz * 0.3) / 2, z), q, new THREE.Vector3(tree ? 1 : 0.01, lift + sz * 0.3, tree ? 1 : 0.01));
      trunks.setMatrixAt(n, m);
      n++;
    }
    im.count = trunks.count = n;
    im.castShadow = false;
    im.receiveShadow = false;
    this.group.add(im, trunks);
  }

  private treeMat!: THREE.MeshBasicMaterial;

  private hillMat!: THREE.ShaderMaterial;
  private get treeU() { return (this.treeMat as unknown as THREE.ShaderMaterial).uniforms; }

  // ---------------------------------------------------------------------------------- courtside
  private courtside() {
    // the scoreboard: an LED panel on a post beside the net (faces the near end)
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const ctx = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.board = { ctx, tex };
    const panel = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.2, roughness: 0.4 });
    this.glow.push({ mat: panel, day: 1.4, night: 1.0 });
    const bx = HW + 1.45;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.82, 0.12), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.3 }));
    housing.position.set(-bx, 1.75, 0);
    housing.castShadow = true;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.38, 0.69), panel);
    face.position.set(-bx, 1.75, 0.065);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 8), new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.4, metalness: 0.6 }));
    post.position.set(-bx, 0.7, 0);
    post.castShadow = true;
    this.group.add(housing, face, post);
    this.score('', '', '0-0-2', 'Love all');
    // benches with coolers and paddle bags on the right of the net
    const benchMat = new THREE.MeshStandardMaterial({ color: lin('#e8e2d6'), roughness: 0.6 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.6 });
    for (const sz of [-1, 1]) {
      const z = sz * 2.0, x = HW + 1.55;
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 1.8), benchMat);
      top.position.set(x, 0.45, z);
      top.castShadow = top.receiveShadow = true;
      this.group.add(top);
      for (const dz of [-0.8, 0.8]) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.43, 0.04), legMat);
        l.position.set(x, 0.215, z + dz);
        this.group.add(l);
      }
      // cooler
      const cool = new THREE.Mesh(new RoundedBox(0.5, 0.42, 0.34, 0.05), new THREE.MeshStandardMaterial({ color: lin(sz > 0 ? '#e94f37' : '#2aa3a0'), roughness: 0.45 }));
      cool.position.set(x + 0.05, 0.21, z + sz * 1.25);
      cool.castShadow = true;
      const lid = new THREE.Mesh(new RoundedBox(0.52, 0.08, 0.36, 0.03), new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4 }));
      lid.position.set(x + 0.05, 0.44, z + sz * 1.25);
      // a paddle bag on the bench
      const bag = new THREE.Mesh(new RoundedBox(0.32, 0.22, 0.72, 0.08), new THREE.MeshStandardMaterial({ color: lin(sz > 0 ? '#1b2a4a' : '#232323'), roughness: 0.7 }));
      bag.position.set(x, 0.58, z - sz * 0.3);
      bag.castShadow = true;
      // water bottles
      for (let k = 0; k < 2; k++) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 12), new THREE.MeshStandardMaterial({ color: lin(k ? '#ff8a1f' : '#9fd8ff'), roughness: 0.2 }));
        b.position.set(x - 0.1 + k * 0.08, 0.59, z + sz * 0.45 + k * 0.1);
        b.castShadow = true;
        this.group.add(b);
      }
      this.group.add(cool, lid, bag);
    }
    // a ball basket on a stand by the far-left corner
    const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.42, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.5, side: THREE.DoubleSide, wireframe: false }));
    basket.position.set(-HW - 1.4, 0.75, -FLOOR_HZ + 1.2);
    basket.castShadow = true;
    this.group.add(basket);
    const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.037, 10, 8), new THREE.MeshStandardMaterial({ color: lin('#e9f23a'), roughness: 0.5 }), 26);
    const R = rng(3), m4 = new THREE.Matrix4();
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2, r = R() * 0.16;
      m4.makeTranslation(-HW - 1.4 + Math.cos(a) * r, 0.86 + R() * 0.12, -FLOOR_HZ + 1.2 + Math.sin(a) * r);
      balls.setMatrixAt(i, m4);
    }
    this.group.add(balls);
  }

  /** the scoreboard: two names, the pickleball call ("4-2-1"), and a line under it */
  score(near: string, far: string, call: string, sub = '') {
    if (!this.board) return;
    const { ctx, tex } = this.board;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#ff8a1f';
    ctx.font = '700 30px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(sub.toUpperCase(), 256, 226);
    ctx.fillStyle = '#ffe46b';
    ctx.font = '800 112px Inter, sans-serif';
    ctx.fillText(call, 256, 150);
    ctx.fillStyle = '#9fd8ff';
    ctx.font = '600 26px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(near.toUpperCase(), 22, 40);
    ctx.textAlign = 'right';
    ctx.fillText(far.toUpperCase(), 490, 40);
    tex.needsUpdate = true;
  }

  /** dusk / night: windows, bulbs and fixtures come up (0 = midday … 1 = night) */
  setNight(k: number, exposure: number) {
    for (const g of this.glow) g.mat.emissiveIntensity = (g.day + (g.night - g.day) * k) / Math.max(0.15, exposure) * 0.35;
    // the tree line reads as a dark silhouette against the sky, lighter in the day haze
    const u = this.treeU;
    const inv = 1 / Math.max(0.3, exposure);
    (u.uCol.value as THREE.Color).copy(lin(k > 0.8 ? '#0a120e' : k > 0.3 ? '#22382a' : '#36503f')).multiplyScalar(inv);
    (u.uHaze.value as THREE.Color).copy(lin(k > 0.8 ? '#141a26' : k > 0.3 ? '#d7a98a' : '#a9bccb')).multiplyScalar(inv * 0.8);
    u.uHazeK.value = k > 0.8 ? 0.15 : 0.26;
    const hu = this.hillMat.uniforms;
    (hu.uCol.value as THREE.Color).copy(u.uCol.value as THREE.Color);
    (hu.uHaze.value as THREE.Color).copy(u.uHaze.value as THREE.Color).multiplyScalar(1.12);
  }

  update(dt: number) {
    this.t += dt;
    // a breeze in the palms (every other frame is plenty)
    if ((this.frame = (this.frame + 1) % 2) === 0) this.swayFronds();
  }
}

// ------------------------------------------------------------------------------------ geometry helpers

/** a palm frond: a strip along +x from the stem, drooping, folded along its rib; uv maps the diagonal frond image */
function frondGeometry(): THREE.BufferGeometry {
  const NS = 10, NT = 4;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const stem = new THREE.Vector2(0.03, 0.04), tip = new THREE.Vector2(0.96, 0.97);
  const axis = tip.clone().sub(stem);
  const perp = new THREE.Vector2(-axis.y, axis.x).normalize().multiplyScalar(0.27);
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    for (let j = 0; j <= NT; j++) {
      const t = (j / NT) * 2 - 1;
      const x = s * 1.0;
      const y = -0.42 * s * s - Math.abs(t) * 0.07 * Math.sin(s * Math.PI);
      const z = t * 0.21;
      pos.push(x, y, z);
      const u = stem.clone().addScaledVector(axis, s).addScaledVector(perp, t);
      uv.push(u.x, u.y);
    }
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < NT; j++) {
    const a = i * (NT + 1) + j, b = a + NT + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** a tensioned shade sail: a triangle whose edges curve inward (catenary cut), slightly dished */
function sailGeo(c: THREE.Vector3[], cut: number): THREE.BufferGeometry {
  const N = 14;
  const pos: number[] = [], idx: number[] = [];
  const centroid = c[0].clone().add(c[1]).add(c[2]).multiplyScalar(1 / 3);
  const P = (a: number, b: number) => {
    // barycentric (a, b, 1-a-b), pulled toward the centroid near the edges' middles
    const g = 1 - a - b;
    const p = c[0].clone().multiplyScalar(a).addScaledVector(c[1], b).addScaledVector(c[2], g);
    const edge = Math.min(a, b, g);
    const mid = 4 * Math.max(a * b, b * g, g * a) * (edge < 0.02 ? 1 : 1);
    const pull = cut * mid * (1 - Math.min(1, edge * 6));
    p.lerp(centroid, pull * 0.6);
    p.y -= 0.35 * Math.min(a, b, g) * 3;
    return p;
  };
  const id = (i: number, j: number) => (i * (2 * N + 3 - i)) / 2 + j;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) {
    const p = P(i / N, j / N);
    pos.push(p.x, p.y, p.z);
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N - i; j++) {
    idx.push(id(i, j), id(i + 1, j), id(i, j + 1));
    if (j < N - i - 1) idx.push(id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** a low hipped roof over a W × D rectangle */
function hipRoof(W: number, D: number, H: number): THREE.BufferGeometry {
  const r = Math.min(W, D) / 2;
  const a = [-W / 2, 0, -D / 2], b = [W / 2, 0, -D / 2], c = [W / 2, 0, D / 2], d = [-W / 2, 0, D / 2];
  const e = [-W / 2 + r, H, 0], f = [W / 2 - r, H, 0];
  const tris = [d, c, f, d, f, e, b, a, e, b, e, f, a, d, e, c, b, f];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

/** a box with bevelled edges */
class RoundedBox extends THREE.BufferGeometry {
  constructor(w: number, h: number, d: number, r: number) {
    super();
    const shape = new THREE.Shape();
    const x = -w / 2 + r, y = -h / 2 + r, ww = w - 2 * r, hh = h - 2 * r;
    shape.moveTo(x, y - r);
    shape.lineTo(x + ww, y - r);
    shape.quadraticCurveTo(x + ww + r, y - r, x + ww + r, y);
    shape.lineTo(x + ww + r, y + hh);
    shape.quadraticCurveTo(x + ww + r, y + hh + r, x + ww, y + hh + r);
    shape.lineTo(x, y + hh + r);
    shape.quadraticCurveTo(x - r, y + hh + r, x - r, y + hh);
    shape.lineTo(x - r, y);
    shape.quadraticCurveTo(x - r, y - r, x, y - r);
    const g = new THREE.ExtrudeGeometry(shape, { depth: d - 2 * r, bevelEnabled: true, bevelSize: r, bevelThickness: r, bevelSegments: 2, curveSegments: 4 });
    g.translate(0, 0, -(d - 2 * r) / 2);
    this.copy(g);
  }
}

export function mergeGeo(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of parts) {
    const pa = g.getAttribute('position'), na = g.getAttribute('normal'), ua = g.getAttribute('uv');
    if (!na) g.computeVertexNormals();
    const nn = g.getAttribute('normal');
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i));
      uv.push(ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
    else for (let i = 0; i < pa.count; i++) idx.push(i + base);
    base += pa.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(base > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return out;
}

/** the clubhouse's rooms seen through the glass: warm walls, ceiling lights, a counter, chairs, a few people, mullions */
function interiorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const g = c.getContext('2d')!;
  const R = rng(11);
  // back wall and floor, lit from above
  const wall = g.createLinearGradient(0, 0, 0, 192);
  wall.addColorStop(0, '#f3c98a');
  wall.addColorStop(0.55, '#c98d55');
  wall.addColorStop(0.56, '#6b4a33');
  wall.addColorStop(1, '#3a281c');
  g.fillStyle = wall;
  g.fillRect(0, 0, 256, 192);
  // ceiling lights
  for (let x = 20; x < 256; x += 56) {
    const l = g.createRadialGradient(x + 12, 10, 1, x + 12, 10, 40);
    l.addColorStop(0, 'rgba(255,240,200,0.95)');
    l.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = l;
    g.fillRect(x - 30, 0, 84, 60);
    g.fillStyle = '#fff6dc';
    g.fillRect(x, 6, 24, 4);
  }
  // shelves / framed pictures on the wall
  for (let x = 8; x < 250; x += 40 + R() * 30) {
    g.fillStyle = `hsl(${Math.floor(R() * 360)},35%,${30 + R() * 25}%)`;
    g.fillRect(x, 40 + R() * 20, 16 + R() * 14, 14 + R() * 10);
  }
  // a counter, chairs and people (silhouettes)
  g.fillStyle = '#4a3020';
  g.fillRect(150, 112, 96, 30);
  for (let k = 0; k < 7; k++) {
    const x = 10 + R() * 230, h = 46 + R() * 18;
    g.fillStyle = `hsl(${Math.floor(R() * 360)},30%,${18 + R() * 22}%)`;
    g.fillRect(x, 140 - h + 14, 14, h);
    g.beginPath();
    g.arc(x + 7, 140 - h + 6, 7, 0, Math.PI * 2);
    g.fillStyle = '#5a3c2c';
    g.fill();
  }
  for (let x = 6; x < 250; x += 34) {
    g.fillStyle = '#2b1d14';
    g.fillRect(x, 136, 18, 4);
    g.fillRect(x + 2, 140, 3, 18);
    g.fillRect(x + 13, 140, 3, 18);
  }
  // mullions and the frame
  g.fillStyle = '#1d2a33';
  g.fillRect(0, 0, 256, 7);
  g.fillRect(0, 185, 256, 7);
  g.fillRect(0, 0, 7, 192);
  g.fillRect(249, 0, 7, 192);
  g.fillRect(125, 0, 6, 192);
  g.fillRect(0, 74, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** a material with a pattern painted from world position (fragment GLSL: vGW, uNoise, diffuseColor) */
function worldPattern<T extends THREE.MeshStandardMaterial>(m: T, key: string, glsl: string): T {
  const nz = noiseTexture();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNoise = { value: nz };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvec4 gwp = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\ngwp = instanceMatrix * gwp;\n#endif\nvGW = ( modelMatrix * gwp ).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;\nuniform sampler2D uNoise;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + glsl);
  };
  m.customProgramCacheKey = () => 'wp-' + key;
  return m;
}
