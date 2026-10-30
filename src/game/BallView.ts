import * as THREE from 'three';
import { BALL_R } from '../sim/dims.ts';
import type { V3 } from '../sim/Ball.ts';

/**
 * The ball as seen: optic-yellow felt (a fuzzy sheen over a noisy fibre albedo) with the
 * white seam, spinning with the sim's spin vector; a motion streak for fast balls (what a
 * broadcast camera's shutter shows), and a squash on the bounce frame.
 */
export class BallView {
  readonly mesh: THREE.Mesh;
  readonly streak: THREE.Mesh;
  private q = new THREE.Quaternion();
  private squash = 0;
  private prev = new THREE.Vector3();
  /** the ball is drawn larger than life so it reads from the broadcast camera */
  static readonly VIS = 1.7;
  readonly shadow: THREE.Mesh;
  readonly marker: THREE.Mesh;
  private markerT = 0;

  constructor() {
    const mat = new THREE.MeshPhysicalMaterial({
      map: feltTexture(),
      roughness: 0.92,
      metalness: 0,
      sheen: 1,
      sheenRoughness: 0.35,
      sheenColor: new THREE.Color(0.9, 1.0, 0.45),
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

  update(p: V3, w: V3, v: V3, dt: number, cameraPos: THREE.Vector3) {
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
    if (speed > 12 && dist > 3) {
      const len = Math.min(1.1, speed * (1 / 60) * 0.55);
      this.streak.visible = true;
      this.streak.position.set(p.x - (v.x / speed) * len * 0.5, p.y - (v.y / speed) * len * 0.5, p.z - (v.z / speed) * len * 0.5);
      this.streak.scale.set(1, 1, len);
      this.streak.lookAt(p.x, p.y, p.z);
      (this.streak.material as THREE.MeshBasicMaterial).opacity = Math.min(0.35, (speed - 12) / 60);
    } else this.streak.visible = false;
    this.prev.set(p.x, p.y, p.z);
  }
}

function feltTexture(): THREE.CanvasTexture {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const n = Math.random() * 0.22 + Math.sin(x * 0.9 + y * 0.3) * 0.02;
      const o = (y * W + x) * 4;
      img.data[o] = 205 + n * 60 - 20;
      img.data[o + 1] = 228 + n * 40 - 15;
      img.data[o + 2] = 48 + n * 30;
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  // the seam: the classic curve on an equirect map (a tennis ball's seam is a closed curve
  // swinging ±~40° in latitude twice around)
  g.strokeStyle = 'rgba(244,246,236,0.95)';
  g.lineWidth = 7;
  g.beginPath();
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const lat = Math.sin(u * Math.PI * 4) * 0.42 * (0.85 + 0.15 * Math.cos(u * Math.PI * 8));
    const x = u * W, y = (0.5 - lat / Math.PI) * H;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
