import { BALL_R, BALL_M, netTop, POST_X, SURFACE_PHYS, type Surface } from './dims.ts';

/**
 * Pickleball flight, independent of the renderer (tools/simtest.ts runs it in node):
 *  - gravity, quadratic drag (Cd 0.45: the holes make a light plastic ball slow down fast)
 *  - Magnus lift from spin, C_L = 1 / (2 + v / (r·ω)) (Watts & Ferrer), weakened for a holed shell
 *  - spin decay (τ ≈ 3 s)
 *  - bounce: vertical restitution per surface; tangential friction impulse that either slides
 *    the whole contact (μ(1+e)|vy|) or grips and rolls out (thin shell, I = ⅔mr²)
 *  - the net: a cord that sags from 36 in at the posts to 34 in in the middle, bound in a soft 2 in
 *    tape — a ball that touches it bounces off a padded cylinder (it can trickle over or fall
 *    back); one that meets the mesh below is swallowed
 * Vectors are plain {x, y, z} records so the sim runs without three.
 */

export interface V3 { x: number; y: number; z: number }
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

const RHO = 1.21;
const A = Math.PI * BALL_R * BALL_R;
export const CD = 0.45;
export const KD = (0.5 * RHO * CD * A) / BALL_M; // drag: a = −KD |v| v
export const KL = (0.5 * RHO * A * 0.55) / BALL_M; // lift: a = KL · C_L · |v|² (ŵ×v̂)
const G = 9.81;
export const SPIN_TAU = 3;
/** the net's tape: radius of its padded top, and its restitution */
const TAPE_R = 0.016;
const TAPE_E = 0.22;

export type BallEvent =
  | { kind: 'bounce'; x: number; z: number; t: number; speed: number; vy: number }
  | { kind: 'net'; x: number; y: number; t: number; cord: boolean; over: boolean; speed: number }
  | { kind: 'wall'; t: number };

export class BallSim {
  p: V3 = v3(0, 1, 0);
  v: V3 = v3();
  w: V3 = v3(); // spin (rad/s)
  t = 0;
  surface: Surface = 'hard';
  /** resting / held (no physics) */
  frozen = true;
  bounces = 0;
  private prevZ = 0;
  private lastCord = -1;

  set(p: V3, v: V3, w: V3) {
    this.p = { ...p };
    this.v = { ...v };
    this.w = { ...w };
    this.frozen = false;
    this.bounces = 0;
    this.prevZ = p.z;
  }

  /** advance by dt (internally sub-stepped at ≤ 1/480 s); returns the events that happened */
  step(dt: number, events: BallEvent[] = []): BallEvent[] {
    if (this.frozen) return events;
    const n = Math.max(1, Math.ceil(dt * 480));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.sub(h, events);
    return events;
  }

  private sub(h: number, ev: BallEvent[]) {
    const p = this.p, v = this.v, w = this.w;
    // forces at the start of the step (semi-implicit: velocity first)
    const acc = accel(v, w);
    v.x += acc.x * h;
    v.y += acc.y * h;
    v.z += acc.z * h;
    const pz0 = p.z;
    p.x += v.x * h;
    p.y += v.y * h;
    p.z += v.z * h;
    const k = Math.exp(-h / SPIN_TAU);
    w.x *= k; w.y *= k; w.z *= k;
    this.t += h;
    // the tape: a padded cylinder along the top of the net
    if (Math.abs(p.x) < POST_X && Math.abs(p.z) < BALL_R + TAPE_R + 0.01) {
      const top = netTop(p.x) - TAPE_R;
      const dy = p.y - top, dz = p.z;
      const d = Math.hypot(dy, dz);
      if (d < BALL_R + TAPE_R && d > 1e-6) {
        const nx = dy / d, nz = dz / d;
        const vn = v.y * nx + v.z * nz;
        if (vn < 0) {
          const speed = Math.hypot(v.x, v.y, v.z);
          // the tape gives: little bounce, a lot of grab along it
          v.y -= (1 + TAPE_E) * vn * nx;
          v.z -= (1 + TAPE_E) * vn * nz;
          const ty = v.y - (v.y * nx + v.z * nz) * nx, tz = v.z - (v.y * nx + v.z * nz) * nz;
          v.y -= ty * 0.35; v.z -= tz * 0.35; v.x *= 0.8;
          w.x *= 0.4; w.y *= 0.4; w.z *= 0.4;
          p.y = top + nx * (BALL_R + TAPE_R);
          p.z = nz * (BALL_R + TAPE_R);
          // whether it goes over is the flight's business from here (it may drop back)
          if (this.t - this.lastCord > 0.05) ev.push({ kind: 'net', x: p.x, y: p.y, t: this.t, cord: true, over: true, speed });
          this.lastCord = this.t;
        }
      }
    }
    // the mesh: crossing z = 0 below the tape, within the posts
    if ((pz0 > 0) !== (p.z > 0) && Math.abs(p.x) < POST_X + 0.05) {
      const f = pz0 / (pz0 - p.z);
      const y = p.y - v.y * h * (1 - f);
      const x = p.x - v.x * h * (1 - f);
      if (y < netTop(x) - TAPE_R * 2) {
        const speed = Math.hypot(v.x, v.y, v.z);
        // into the net: the mesh swallows it
        p.z = pz0 > 0 ? BALL_R + 0.02 : -BALL_R - 0.02;
        v.z = -v.z * 0.08;
        v.x *= 0.25;
        v.y = Math.min(v.y * 0.3, 0.5);
        w.x *= 0.2; w.y *= 0.2; w.z *= 0.2;
        ev.push({ kind: 'net', x, y, t: this.t, cord: false, over: false, speed });
      }
    }
    this.prevZ = p.z;
    // ground
    if (p.y < BALL_R && v.y < 0) {
      const vyIn = v.y;
      p.y = BALL_R;
      const phys = SURFACE_PHYS[this.surface];
      const e = Math.max(0.5, phys.e - 0.004 * Math.max(0, -vyIn - 6));
      if (-vyIn < 0.6) {
        // rolling: no more bounces, rolling resistance
        v.y = 0;
        const s = Math.hypot(v.x, v.z);
        const dec = Math.min(s, (this.surface === 'clay' ? 2.2 : this.surface === 'grass' ? 1.5 : 1.0) * h * 4);
        if (s > 1e-6) { v.x -= (v.x / s) * dec; v.z -= (v.z / s) * dec; }
        return;
      }
      v.y = -vyIn * e;
      // contact-point velocity: v_t + w × (−r ŷ)
      const cx = v.x + BALL_R * w.z;
      const cz = v.z - BALL_R * w.x;
      const cs = Math.hypot(cx, cz);
      if (cs > 1e-6) {
        const jMax = phys.mu * (1 + e) * -vyIn;
        const jRoll = cs / 2.5;
        const j = Math.min(jMax, jRoll);
        const ux = cx / cs, uz = cz / cs;
        const dvx = -j * ux, dvz = -j * uz;
        v.x += dvx;
        v.z += dvz;
        // Δw = (3 / 2r²) · (r_vec × Δv), r_vec = (0, −r, 0)
        const kk = 3 / (2 * BALL_R);
        w.x += kk * -dvz;
        w.z += kk * dvx;
      }
      v.x *= phys.keep;
      v.z *= phys.keep;
      this.bounces++;
      ev.push({ kind: 'bounce', x: p.x, z: p.z, t: this.t, speed: Math.hypot(v.x, v.z), vy: -vyIn });
    }
  }
}

const _a = v3();
function accel(v: V3, w: V3): V3 {
  const s = Math.hypot(v.x, v.y, v.z);
  _a.x = -KD * s * v.x;
  _a.y = -KD * s * v.y - G;
  _a.z = -KD * s * v.z;
  const ws = Math.hypot(w.x, w.y, w.z);
  if (ws > 1e-3 && s > 1e-3) {
    // ŵ × v̂ scaled by C_L |v|²
    const cl = 1 / (2 + s / (BALL_R * ws));
    let cx = w.y * v.z - w.z * v.y;
    let cy = w.z * v.x - w.x * v.z;
    let cz = w.x * v.y - w.y * v.x;
    const cn = Math.hypot(cx, cy, cz);
    if (cn > 1e-9) {
      const m = (KL * cl * s * s) / cn;
      cx *= m; cy *= m; cz *= m;
      _a.x += cx; _a.y += cy; _a.z += cz;
    }
  }
  return _a;
}

/** predict a flight: positions every `dt` until the ball stops, bounces `maxBounces` times, or `tMax` passes */
export function predict(p: V3, v: V3, w: V3, surface: Surface, tMax = 4, dt = 1 / 120, maxBounces = 2): { pts: (V3 & { t: number })[]; events: BallEvent[] } {
  const b = new BallSim();
  b.surface = surface;
  b.set(p, v, w);
  const pts: (V3 & { t: number })[] = [{ ...b.p, t: 0 }];
  const events: BallEvent[] = [];
  for (let t = 0; t < tMax; t += dt) {
    b.step(dt, events);
    pts.push({ ...b.p, t: b.t });
    if (b.bounces >= maxBounces) break;
  }
  return { pts, events };
}

/** the spin vector for topspin (+) / backspin (−) of `rpm` about the axis across the flight, plus sidespin */
export function spinFor(dirX: number, dirZ: number, rpm: number, side = 0): V3 {
  const l = Math.hypot(dirX, dirZ) || 1;
  const dx = dirX / l, dz = dirZ / l;
  const om = (rpm * Math.PI * 2) / 60;
  // topspin: the top of the ball turns forward, so w × v points down: axis = (dz, 0, −dx)
  const ax = dz, az = -dx;
  const sideOm = (side * Math.PI * 2) / 60;
  return v3(ax * om, sideOm, az * om);
}
