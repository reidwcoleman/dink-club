import * as THREE from 'three';
import { netTop, POST_X, NET_POST } from '../sim/dims.ts';

/**
 * The net: a sagging polyester mesh (a knotted-square canvas texture whose mip chain
 * averages into a see-through haze at distance), the white headband over the cord, the
 * centre strap, and the posts with their winders.
 * `shake(x, y, energy)` ripples it when a ball hits it.
 */
export class Net {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private base: Float32Array;
  private ripple = { x: 0, y: 0, e: 0, t: 0 };

  constructor(postColor = '#1d3a2b') {
    this.group.name = 'net';
    // ---- mesh (cells 4.4 cm; texture tile = 4 cells)
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(22,22,24,1)';
    g.lineWidth = 7;
    for (let i = 0; i <= 4; i++) {
      const p = i * 64;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
    }
    // knots
    g.fillStyle = 'rgba(14,14,16,1)';
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { g.beginPath(); g.arc(i * 64, j * 64, 6.5, 0, 7); g.fill(); }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.premultiplyAlpha = false;
    const cell = 0.044 * 4;
    const W = POST_X * 2, NX = 96, NY = 12;
    const geo = new THREE.PlaneGeometry(W, 1, NX, NY);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const v = pos.getY(i) + 0.5; // 0 bottom … 1 top
      const top = netTop(x) - 0.04;
      const y = 0.03 + v * (top - 0.03);
      // the mesh bellies slightly toward the bottom
      const belly = Math.sin(v * Math.PI) * 0.012 * (1 - Math.abs(x) / POST_X);
      pos.setXYZ(i, x, y, belly);
      uv.setXY(i, (x + W / 2) / cell, y / cell);
    }
    geo.computeVertexNormals();
    this.base = Float32Array.from(pos.array as Float32Array);
    const netMat = new THREE.MeshStandardMaterial({
      map: t,
      transparent: true,
      alphaTest: 0.02,
      side: THREE.DoubleSide,
      roughness: 0.9,
      depthWrite: false,
      color: 0xffffff,
    });
    this.mesh = new THREE.Mesh(geo, netMat);
    this.mesh.castShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: 0.35 });
    this.group.add(this.mesh);

    // ---- headband (white tape, 6.3 cm, over the cord) following the cord's sag
    const tape = new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: 0.55 });
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 80; i++) {
      const x = -POST_X + (i / 80) * POST_X * 2;
      const y = netTop(x);
      pts.push(new THREE.Vector3(x, y - 0.03, 0));
    }
    const bandGeo = ribbon(pts, 0.063, 0.012);
    const band = new THREE.Mesh(bandGeo, tape);
    band.castShadow = true;
    band.receiveShadow = true;
    this.group.add(band);
    // centre strap
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, netTop(0) - 0.01, 0.014), tape);
    strap.position.set(0, (netTop(0) - 0.01) / 2, 0);
    strap.castShadow = true;
    this.group.add(strap);
    // bottom cable
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, POST_X * 2, 6).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
    cable.position.y = 0.03;
    this.group.add(cable);

    // ---- posts + winders, singles sticks
    const postMat = new THREE.MeshStandardMaterial({ color: postColor, roughness: 0.35, metalness: 0.4 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.18, metalness: 1 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.042, NET_POST + 0.02, 20), postMat);
      post.position.set(s * (POST_X + 0.02), (NET_POST + 0.02) / 2, 0);
      post.castShadow = true;
      post.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.041, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), postMat);
      cap.position.set(s * (POST_X + 0.02), NET_POST + 0.02, 0);
      const winder = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.09, 12).rotateX(Math.PI / 2), chrome);
      winder.position.set(s * (POST_X + 0.02), 0.62, s * 0.06);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.09, 0.012), chrome);
      handle.position.set(s * (POST_X + 0.02), 0.58, s * 0.105);
      this.group.add(post, cap, winder, handle);
    }
  }

  /** a ball hit the net at (x, y) with this much energy (m/s) */
  shake(x: number, y: number, e: number) {
    this.ripple = { x, y, e: Math.min(1, e / 25), t: 0 };
  }

  update(dt: number) {
    const r = this.ripple;
    if (r.e <= 0.001) return;
    r.t += dt;
    const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const damp = Math.exp(-r.t * 3.2);
    for (let i = 0; i < pos.count; i++) {
      const x = this.base[i * 3], y = this.base[i * 3 + 1];
      const d = Math.hypot(x - r.x, (y - r.y) * 1.5);
      const w = Math.exp(-d * d * 1.8) * Math.sin(r.t * 22 - d * 6) * 0.09 * r.e * damp;
      pos.setZ(i, this.base[i * 3 + 2] + w);
    }
    pos.needsUpdate = true;
    if (damp < 0.01) {
      r.e = 0;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, this.base[i * 3 + 2]);
    }
  }
}

/** a flat tape of height h and thickness th, hung below a polyline */
function ribbon(pts: THREE.Vector3[], h: number, th: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-th / 2, -h / 2);
  shape.lineTo(th / 2, -h / 2);
  shape.lineTo(th / 2, h / 2);
  shape.lineTo(-th / 2, h / 2);
  shape.closePath();
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.ExtrudeGeometry(shape, { steps: 120, bevelEnabled: false, extrudePath: curve });
  return g;
}
