import * as THREE from 'three';
import { BALL_R } from '../sim/dims.ts';
import type { V3 } from '../sim/Ball.ts';

/**
 * The ball as seen: a holed plastic pickleball spinning with the sim's spin vector, a motion
 * streak for fast balls (what a broadcast camera's shutter shows), a squash on the bounce
 * frame, and a flash where the paddle meets it.
 */
export class BallView {
  readonly mesh: THREE.Mesh;
  readonly streak: THREE.Mesh;
  private q = new THREE.Quaternion();
  private squash = 0;
  private prev = new THREE.Vector3();
  /** the ball is drawn larger than life so it reads from the broadcast camera */
  static readonly VIS = 1.45;
  readonly shadow: THREE.Mesh;
  readonly marker: THREE.Mesh;
  private markerT = 0;
  readonly flashSprite: THREE.Sprite;
  private flashT = 1;
  private flashK = 0;

  constructor() {
    const mat = new THREE.MeshPhysicalMaterial({
      map: feltTexture(),
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      emissive: new THREE.Color(0.32, 0.36, 0.04),
      emissiveIntensity: 0.25,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * BallView.VIS, 32, 20), mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ball';
    const smat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 0.9, 0.2), transparent: true, opacity: 0.35, depthWrite: false });
    this.streak = new THREE.Mesh(new THREE.CylinderGeometry(BALL_R * 0.85, BALL_R * 0.85, 1, 12, 1, true).rotateX(Math.PI / 2), smat);
    this.streak.visible = false;
    this.streak.renderOrder = 3;
    // a soft contact shadow straight under the ball (depth cue), and the landing marker
    const blob = (inner: number, outer: number, color: string, op: number) => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(64, 64, inner * 64, 64, 64, outer * 64);
      gr.addColorStop(0, color);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      return new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: op, depthWrite: false, toneMapped: false });
    };
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blob(0.0, 1.0, 'rgba(0,0,0,0.9)', 0.55));
    this.shadow.renderOrder = 2;
    this.shadow.visible = false;
    const ring = document.createElement('canvas');
    ring.width = ring.height = 256;
    const rg = ring.getContext('2d')!;
    rg.strokeStyle = 'rgba(255,255,255,1)';
    rg.lineWidth = 14;
    rg.beginPath();
    rg.arc(128, 128, 100, 0, Math.PI * 2);
    rg.stroke();
    rg.fillStyle = 'rgba(255,255,255,0.22)';
    rg.beginPath();
    rg.arc(128, 128, 94, 0, Math.PI * 2);
    rg.fill();
    const rt = new THREE.CanvasTexture(ring);
    this.marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: rt, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false, color: new THREE.Color(1.0, 0.95, 0.5) }));
    this.marker.renderOrder = 2;
    this.marker.visible = false;
    const fc = document.createElement('canvas');
    fc.width = fc.height = 128;
    const fg = fc.getContext('2d')!;
    const fgr = fg.createRadialGradient(64, 64, 0, 64, 64, 64);
    fgr.addColorStop(0, 'rgba(255,255,230,1)');
    fgr.addColorStop(0.25, 'rgba(255,240,150,0.55)');
    fgr.addColorStop(0.6, 'rgba(255,200,90,0.12)');
    fgr.addColorStop(1, 'rgba(255,200,90,0)');
    fg.fillStyle = fgr;
    fg.fillRect(0, 0, 128, 128);
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(fc), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.flashSprite.visible = false;
    this.flashSprite.renderOrder = 4;
  }

  /** the paddle meets the ball: a quick bloom (k 0..1 by pace) */
  flash(p: V3, k: number) {
    this.flashSprite.position.set(p.x, p.y, p.z);
    this.flashT = 0;
    this.flashK = k;
    this.flashSprite.visible = true;
  }

  /** the landing marker: where the ball will bounce on the human's side */
  setMarker(at: { x: number; z: number } | null, dt: number) {
    if (!at) {
      this.marker.visible = false;
      return;
    }
    this.markerT += dt;
    this.marker.visible = true;
    this.marker.position.set(at.x, 0.03, at.z);
    const k = 0.62 + Math.sin(this.markerT * 9) * 0.05;
    this.marker.scale.set(k, 1, k);
  }

  bounce() {
    this.squash = 1;
  }

  /** a shot off a hot paddle: a long orange trail */
  hot = false;

  update(p: V3, w: V3, v: V3, dt: number, cameraPos: THREE.Vector3) {
    if (this.flashT < 1) {
      this.flashT += dt / 0.22;
      const u = Math.min(1, this.flashT);
      const sz = (0.25 + 0.55 * this.flashK) * (0.6 + u * 0.9);
      this.flashSprite.scale.set(sz, sz, 1);
      this.flashSprite.material.opacity = (1 - u) * (1 - u) * (0.5 + this.flashK);
      if (u >= 1) this.flashSprite.visible = false;
    }
    this.mesh.position.set(p.x, p.y, p.z);
    const live = p.y > BALL_R * 1.4 || Math.hypot(v.x, v.z) > 1;
    this.shadow.visible = live && this.mesh.visible && p.y < 14;
    const hgt = Math.max(0, p.y - BALL_R);
    this.shadow.position.set(p.x, 0.02, p.z);
    const sr = 0.2 + hgt * 0.05;
    this.shadow.scale.set(sr, 1, sr);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.6 - hgt * 0.07);
    const ws = Math.hypot(w.x, w.y, w.z);
    if (ws > 0.01) {
      this.q.setFromAxisAngle(new THREE.Vector3(w.x / ws, w.y / ws, w.z / ws), ws * dt);
      this.mesh.quaternion.premultiply(this.q);
    }
    // squash on impact (a frame or two)
    const s = this.squash;
    this.mesh.scale.set(1 + s * 0.18, 1 - s * 0.3, 1 + s * 0.18);
    this.squash = Math.max(0, this.squash - dt * 20);
    // motion streak behind a fast ball: length ≈ distance covered in half a frame's exposure
    const speed = Math.hypot(v.x, v.y, v.z);
    const dist = cameraPos.distanceTo(this.mesh.position);
    // spin shows in the streak's colour: warm for topspin, cool for slice
    const vh = Math.hypot(v.x, v.z) || 1;
    const rpm = ((w.x * v.z - w.z * v.x) / vh) * 9.55;
    const spinK = Math.min(1, Math.max(0, Math.abs(rpm) - 300) / 1600);
    const sm = this.streak.material as THREE.MeshBasicMaterial;
    sm.color.setRGB(0.75, 0.9, 0.2).lerp(rpm > 0 ? SPIN_TOP : SPIN_BACK, spinK);
    if (this.hot) sm.color.setRGB(1, 0.42, 0.08);
    if ((speed > 12 || (speed > 6 && spinK > 0.2) || (this.hot && speed > 4)) && dist > 3) {
      const len = Math.min(this.hot ? 1.6 : 1.1, speed * (1 / 60) * (0.55 + spinK * 0.9 + (this.hot ? 1.2 : 0)));
      this.streak.visible = true;
      this.streak.position.set(p.x - (v.x / speed) * len * 0.5, p.y - (v.y / speed) * len * 0.5, p.z - (v.z / speed) * len * 0.5);
      this.streak.scale.set(1, 1, len);
      this.streak.lookAt(p.x, p.y, p.z);
      sm.opacity = this.hot ? 0.6 : Math.max(Math.min(0.35, (speed - 12) / 60), spinK * 0.5);
    } else this.streak.visible = false;
    this.prev.set(p.x, p.y, p.z);
  }
}

const SPIN_TOP = new THREE.Color(1.0, 0.5, 0.12), SPIN_BACK = new THREE.Color(0.25, 0.8, 1.0);

/** an outdoor pickleball: smooth optic-yellow plastic with 40 round holes (equirect map) */
function feltTexture(): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#e2ee2c');
  grd.addColorStop(0.5, '#eaf33a');
  grd.addColorStop(1, '#dbe828');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  // 40 holes spread evenly (a Fibonacci sphere), each drawn as the ellipse it maps to
  const n = 40;
  for (let k = 0; k < n; k++) {
    const y = 1 - (2 * (k + 0.5)) / n;
    const lat = Math.asin(y);
    const lon = (k * Math.PI * (3 - Math.sqrt(5))) % (Math.PI * 2);
    const cx = (lon / (Math.PI * 2)) * W, cy = (0.5 - lat / Math.PI) * H;
    const r = 0.17; // hole radius (rad)
    const ry = (r / Math.PI) * H, rx = Math.min(W / 2, (r / (Math.PI * 2)) * W / Math.max(0.12, Math.cos(lat)));
    for (const dx of [-W, 0, W]) {
      g.fillStyle = '#7d8a10';
      g.beginPath();
      g.ellipse(cx + dx, cy, rx * 1.18, ry * 1.18, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#2c3008';
      g.beginPath();
      g.ellipse(cx + dx, cy, rx, ry, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
