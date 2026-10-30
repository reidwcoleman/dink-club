import { BALL_R, BALL_M } from './dims.ts';
import { type V3, v3 } from './Ball.ts';

/**
 * The ball meeting the paddle. A pickleball paddle is a stiff honeycomb panel with a gritty
 * face, and the ball a hollow plastic shell: over the ~1 ms of contact
 *  - the velocity along the face normal reverses with the impact's restitution (≈ 0.42 for a
 *    polymer-core paddle and an outdoor ball, a little less when hit very hard),
 *  - the sliding of the ball across the face is gripped by friction, which slows the slide and
 *    turns it into spin (a thin shell, I = ⅔ m r²: at most 3/5 of the slide can go before it rolls).
 * So a block of a hard ball comes back at ~40% of its pace, a dink needs a push, and spin comes
 * from the paddle's path crossing the face (brush up = topspin, chop down = slice).
 * Vectors are world space; the paddle velocity is the sweet spot's at contact.
 */

/** restitution of the ball on the paddle face (normal speeds) */
export function paddleE(normalSpeed: number): number {
  return Math.max(0.3, 0.44 - Math.max(0, normalSpeed - 15) * 0.006);
}
/** grit: how much of the sliding gets gripped (≤ 0.6, rolling) */
export const PADDLE_GRIP = 0.5;

export interface Impact {
  v: V3;
  w: V3;
  /** the normal impact speed (how hard it was struck) */
  normal: number;
}

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (a: V3, b: V3, k = 1): V3 => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const scale = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
export const norm = (a: V3): V3 => { const l = len(a) || 1; return v3(a.x / l, a.y / l, a.z / l); };

/**
 * One contact. `n` is the hitting face's normal (pointing where the ball goes), `u` the paddle's
 * velocity, `vIn` / `wIn` the incoming ball.
 */
export function impact(vIn: V3, wIn: V3, u: V3, n: V3): Impact {
  // the ball relative to the paddle; its approach speed along the normal is −rn
  const r = add(vIn, u, -1);
  const rn = dot(r, n);
  const rt = add(r, n, -rn);
  // the contact point's slide also has the incoming spin in it: w × (−R n)
  const slide = add(rt, cross(wIn, scale(n, -BALL_R)));
  const e = paddleE(-rn);
  const vn = -e * Math.min(0, rn) + Math.max(0, rn);
  // friction impulse against the slide (per unit mass)
  const dvt = scale(slide, -PADDLE_GRIP);
  const v = add(add(add(u, n, vn), rt), dvt);
  // Δw = (r_c × J) / I with r_c = −R n, J = m Δv, I = ⅔ m R²
  const dw = scale(cross(scale(n, -BALL_R), dvt), 3 / (2 * BALL_R * BALL_R));
  // the shell keeps a little of what it came in with (it was gripped too)
  const w = add(scale(wIn, 0.25), dw);
  void BALL_M;
  return { v, w, normal: -rn };
}

/**
 * The flat stroke that sends the ball off at `want`: the face normal and the paddle speed along
 * it (the paddle moving square through the ball). Solved by fixed point: the face must point
 * along what the paddle adds to the ball, which depends on the face.
 */
export function faceFor(vIn: V3, want: V3): { n: V3; speed: number } {
  let n = norm(add(want, vIn, -1));
  let s = 0;
  for (let i = 0; i < 8; i++) {
    const vn = dot(vIn, n);
    const vt = add(vIn, n, -vn);
    // a flat hit keeps (1 − grip) of the incoming slide
    n = norm(add(want, vt, -(1 - PADDLE_GRIP)));
    const vn2 = dot(vIn, n);
    const wn = dot(want, n);
    // wn = s + e (s − vn2)  →  s = (wn + e vn2) / (1 + e)
    const e = paddleE(Math.max(0, s - vn2));
    s = (wn + e * vn2) / (1 + e);
  }
  return { n, speed: s };
}

/** rotate v about a unit axis by angle a (Rodrigues) */
export function rotate(v: V3, axis: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  const k = norm(axis);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return v3(v.x * c + kv.x * s + k.x * kd, v.y * c + kv.y * s + k.y * kd, v.z * c + kv.z * s + k.z * kd);
}
