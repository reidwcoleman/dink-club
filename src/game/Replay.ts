import * as THREE from 'three';
import type { Player } from './Player.ts';

/**
 * The replay recorder: every frame of play stores the ball and both players' full poses
 * (root transform, every bone's local rotation, the root bone's translation), 12 s deep.
 * Playback writes them back — the rig and mixer are bypassed — so a replay is the rally
 * exactly as it happened, from any camera, at any speed.
 */
const SECONDS = 12;
const FPS = 60;

interface Frame {
  t: number;
  ball: THREE.Vector3;
  ballQ: THREE.Quaternion;
  bodies: { pos: THREE.Vector3; rot: number; innerY: number; rootBone: THREE.Vector3; q: Float32Array }[];
}

export class Replay {
  private frames: Frame[] = [];
  private acc = 0;
  playing = false;
  playT = 0;
  private startT = 0;
  private endT = 0;
  speed = 0.45;
  /** landmarks of the recording: the time of each bounce and strike (for the director) */
  marks: { t: number; kind: 'hit' | 'bounce'; x: number; z: number }[] = [];

  constructor(readonly players: Player[], readonly ball: THREE.Object3D) {}

  clear() {
    this.frames.length = 0;
    this.marks.length = 0;
  }

  record(dt: number, clock: number) {
    this.acc += dt;
    if (this.acc < 1 / FPS - 1e-4) return;
    this.acc = 0;
    const f: Frame = {
      t: clock,
      ball: this.ball.position.clone(),
      ballQ: this.ball.quaternion.clone(),
      bodies: this.players.map((p) => {
        const h = p.rig.human;
        const bones = h.skeleton.bones;
        const q = new Float32Array(bones.length * 4);
        bones.forEach((b, i) => b.quaternion.toArray(q, i * 4));
        return { pos: h.root.position.clone(), rot: h.root.rotation.y, innerY: h.inner.position.y, rootBone: bones[0].position.clone(), q };
      }),
    };
    this.frames.push(f);
    while (this.frames.length > SECONDS * FPS) this.frames.shift();
  }

  mark(kind: 'hit' | 'bounce', clock: number, x: number, z: number) {
    this.marks.push({ t: clock, kind, x, z });
    while (this.marks.length && this.frames.length && this.marks[0].t < this.frames[0].t) this.marks.shift();
  }

  get duration() {
    return this.frames.length ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0;
  }

  /** play from `from` seconds before the end to `to` seconds before the end */
  start(fromBack: number, toBack = 0.3, speed = 0.45) {
    if (this.frames.length < 30) return false;
    const end = this.frames[this.frames.length - 1].t;
    this.startT = Math.max(this.frames[0].t, end - fromBack);
    this.endT = end - toBack;
    this.playT = this.startT;
    this.speed = speed;
    this.playing = true;
    return true;
  }

  stop() {
    this.playing = false;
  }

  /** advance playback; false when finished. Poses the players and the ball. */
  step(dt: number): boolean {
    if (!this.playing) return false;
    this.playT += dt * this.speed;
    if (this.playT >= this.endT) {
      this.playing = false;
      return false;
    }
    this.apply(this.playT);
    return true;
  }

  private apply(t: number) {
    const F = this.frames;
    let lo = 0, hi = F.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (F[m].t <= t) lo = m;
      else hi = m;
    }
    const a = F[lo], b = F[hi];
    const u = THREE.MathUtils.clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
    this.ball.position.lerpVectors(a.ball, b.ball, u);
    this.ball.quaternion.slerpQuaternions(a.ballQ, b.ballQ, u);
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    this.players.forEach((p, k) => {
      const h = p.rig.human;
      const A = a.bodies[k], B = b.bodies[k];
      h.root.position.lerpVectors(A.pos, B.pos, u);
      h.root.rotation.set(0, A.rot + Math.atan2(Math.sin(B.rot - A.rot), Math.cos(B.rot - A.rot)) * u, 0);
      h.inner.position.y = A.innerY + (B.innerY - A.innerY) * u;
      const bones = h.skeleton.bones;
      bones[0].position.lerpVectors(A.rootBone, B.rootBone, u);
      for (let i = 0; i < bones.length; i++) {
        qa.fromArray(A.q, i * 4);
        qb.fromArray(B.q, i * 4);
        bones[i].quaternion.slerpQuaternions(qa, qb, u);
      }
      h.root.updateMatrixWorld(true);
    });
  }

  /** the ball's position at a recorded time */
  ballAt(t: number): THREE.Vector3 | null {
    const f = this.frames.find((x) => x.t >= t);
    return f ? f.ball.clone() : null;
  }

  /** the recorded ball path between two times (for the Hawk-Eye trace) */
  path(t0: number, t1: number): THREE.Vector3[] {
    return this.frames.filter((f) => f.t >= t0 && f.t <= t1).map((f) => f.ball.clone());
  }
}

/** the Hawk-Eye graphic: the ball's path as a glowing trace, its footprint, and the call */
export class HawkEye {
  readonly group = new THREE.Group();
  private trace: THREE.Mesh | null = null;
  private mark: THREE.Mesh;
  private label: HTMLElement;

  constructor(parent: HTMLElement) {
    this.group.visible = false;
    this.mark = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8ff5a, transparent: true, opacity: 0.85, depthWrite: false }));
    this.mark.renderOrder = 5;
    this.group.add(this.mark);
    this.label = document.createElement('div');
    this.label.className = 'hawkeye';
    parent.appendChild(this.label);
  }

  show(path: THREE.Vector3[], bounce: { x: number; z: number }, inside: boolean, marginMm: number) {
    this.hide();
    if (path.length > 2) {
      const curve = new THREE.CatmullRomCurve3(path);
      this.trace = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(200, path.length * 2), 0.018, 8, false), new THREE.MeshBasicMaterial({ color: 0xf2ff7a, transparent: true, opacity: 0.55, depthWrite: false }));
      this.trace.renderOrder = 5;
      this.group.add(this.trace);
    }
    // footprint: the compressed contact, elongated along the flight
    const last = path[path.length - 1] ?? new THREE.Vector3(bounce.x, 0, bounce.z);
    const prev = path[path.length - 4] ?? last;
    const heading = Math.atan2(last.x - prev.x, last.z - prev.z);
    this.mark.position.set(bounce.x, 0.004, bounce.z);
    this.mark.scale.set(0.028, 1, 0.052);
    this.mark.rotation.y = heading;
    (this.mark.material as THREE.MeshBasicMaterial).color.set(inside ? 0xe8ff5a : 0xff5a4a);
    this.group.visible = true;
    this.label.innerHTML = `<span class="lbl">HAWK-EYE</span><span class="call ${inside ? 'in' : 'out'}">${inside ? 'IN' : 'OUT'}</span><span class="mm">${Math.abs(Math.round(marginMm))} mm</span>`;
    this.label.classList.add('on');
  }

  hide() {
    if (this.trace) {
      this.group.remove(this.trace);
      this.trace.geometry.dispose();
      this.trace = null;
    }
    this.group.visible = false;
    this.label.classList.remove('on');
  }
}
