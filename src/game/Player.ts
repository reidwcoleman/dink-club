import * as THREE from 'three';
import { PlayerRig, type StrokeKind, angleDiff } from './PlayerRig.ts';
import { HL, NVZ, FLOOR_HX, FLOOR_HZ } from '../sim/dims.ts';
import type { BallEvent, V3 } from '../sim/Ball.ts';
import type { ShotType } from './Input.ts';
import type { Puppet } from '../people/Puppet.ts';

/** contact geometry: how far the ball is beside / ahead of the body for each stroke (a paddle is short) */
export const REACH = { fhLat: 0.62, bhLat: 0.56, smashLat: 0.25, ahead: 0.38, volleyAhead: 0.5, smashAhead: 0.35 };

export interface Skill {
  speed: number; // top speed m/s
  accel: number;
  power: number; // 0..1 multiplier on pace
  accuracy: number; // 0..1
  spin: number; // 0..1
  reaction: number; // seconds
}

export const PRO: Skill = { speed: 5.0, accel: 16, power: 0.9, accuracy: 0.85, spin: 0.85, reaction: 0.16 };

export interface Plan {
  /** absolute time of contact (game clock) */
  tContact: number;
  ball: THREE.Vector3; // where the ball will be
  body: THREE.Vector3; // where the player should stand
  kind: StrokeKind;
  forehand: boolean;
  volley: boolean;
  smash: boolean;
  bounced: boolean;
  /** how late the player will be getting there (s, ≤ 0 is on time) */
  late: number;
  swung: boolean;
}

/** one player: position, movement, the plan for the incoming ball, the swing */
export class Player {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** +1 near end (+z), −1 far end */
  side: 1 | -1 = 1;
  plan: Plan | null = null;
  /** chosen shot for the plan (AI decides at planning; the human by button) */
  shot: { type: ShotType; aimX: number; aimD: number; power: number; pressT: number; released: boolean; rpm?: number; label?: string } | null = null;
  moveTarget: THREE.Vector3 | null = null;
  /** the realistic body drawn over the rig */
  puppet: Puppet | null = null;
  stamina = 1;
  private planCooldown = 0;

  constructor(readonly index: 0 | 1, readonly name: string, readonly rig: PlayerRig, readonly human: boolean, public skill: Skill = PRO) {}

  /** the direction the player faces (toward the other end) */
  get facingYaw(): number {
    return this.side === 1 ? Math.PI : 0;
  }
  get fwd(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -this.side);
  }
  get right(): THREE.Vector3 {
    // facing −z (near end) the right hand is +x
    return new THREE.Vector3(this.side, 0, 0);
  }

  place(x: number, z: number) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.rig.pos.copy(this.pos);
    this.rig.vel.set(0, 0, 0);
    this.rig.yaw = this.facingYaw;
  }

  /**
   * where to meet the incoming ball: scan its predicted flight for the best contact — after one
   * bounce on this side (or a volley / smash when it's up at the net), a comfortable height,
   * reachable in time; forehand or backhand by which is closer (forehand favoured)
   */
  planIntercept(pts: (V3 & { t: number })[], events: BallEvent[], now: number, allowVolley: boolean): Plan | null {
    const s = this.side;
    const bounces = events.filter((e) => e.kind === 'bounce') as Extract<BallEvent, { kind: 'bounce' }>[];
    const myBounce = bounces.find((b) => b.z * s > 0);
    const secondBounce = myBounce ? bounces.find((b) => b.t > myBounce.t + 0.01) : undefined;
    const fwd = this.fwd, right = this.right;
    let best: Plan | null = null;
    let bestScore = Infinity;
    const vmax = this.skill.speed;
    const react = this.skill.reaction;
    for (let i = 1; i < pts.length; i += 2) {
      const p = pts[i];
      if (p.z * s < 0.35) continue;
      if (secondBounce && p.t >= secondBounce.t - 0.02) break;
      const bounced = !!myBounce && p.t > myBounce.t;
      const volley = !bounced;
      if (volley && !allowVolley) continue;
      if (volley && !myBounce) {
        // a ball that will land out is left alone (it's the opponent's error)
      }
      const smash = p.y > 1.75;
      if (p.y < 0.12 || p.y > 2.6) continue;
      const rising = i + 1 < pts.length && pts[i + 1].y > p.y;
      if (smash && bounced && (p.y > 2.3 || rising)) continue;
      const ball = new THREE.Vector3(p.x, p.y, p.z);
      for (const fh of [true, false]) {
        if (smash && !fh) continue;
        const lat = smash ? REACH.smashLat : fh ? REACH.fhLat : REACH.bhLat;
        const ahead = smash ? REACH.smashAhead : volley ? REACH.volleyAhead : REACH.ahead;
        const body = ball.clone().addScaledVector(right, fh ? -lat : lat).addScaledVector(fwd, -ahead);
        body.y = 0;
        // the kitchen: no volleying with a foot in it
        if (volley && body.z * s < NVZ + 0.08) continue;
        body.x = THREE.MathUtils.clamp(body.x, -FLOOR_HX + 0.4, FLOOR_HX - 0.4);
        body.z = THREE.MathUtils.clamp(body.z, -FLOOR_HZ + 0.5, FLOOR_HZ - 0.5);
        const dist = body.distanceTo(this.pos);
        const tNeed = react + dist / vmax + Math.min(0.3, (vmax / this.skill.accel) * 0.5) * Math.min(1, dist / 2);
        const late = tNeed - p.t;
        const hPen = smash ? 0.3 : Math.abs(p.y - (bounced ? 0.75 : 0.95)) * 1.4;
        const score = Math.max(0, late) * 12 + hPen + dist * 0.1 + (fh ? 0 : 0.15) + (volley && !smash ? 0.1 : 0) + p.t * 0.05;
        if (score < bestScore) {
          bestScore = score;
          const kind: StrokeKind = smash ? 'smash' : volley ? (fh ? 'fhVolley' : 'bhVolley') : fh ? 'fh' : 'bh';
          best = { tContact: now + p.t, ball, body, kind, forehand: fh, volley, smash, bounced, late, swung: false };
        }
      }
    }
    return best;
  }

  /** move toward a velocity (m/s) with the player's acceleration limits */
  drive(dt: number, want: THREE.Vector3) {
    const vmax = this.skill.speed * (0.8 + 0.2 * this.stamina);
    if (want.length() > vmax) want.setLength(vmax);
    const dv = want.clone().sub(this.vel);
    const braking = want.lengthSq() < this.vel.lengthSq();
    const a = (braking ? this.skill.accel * 1.25 : this.skill.accel) * dt;
    if (dv.length() > a) dv.setLength(a);
    this.vel.add(dv);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -FLOOR_HX + 0.35, FLOOR_HX - 0.35);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -FLOOR_HZ + 0.4, FLOOR_HZ - 0.4);
    // never across the net
    if (this.pos.z * this.side < 0.45) this.pos.z = 0.45 * this.side;
  }

  /** arrive at a point: the velocity that gets there and stops */
  seek(target: THREE.Vector3, urgency = 1): THREE.Vector3 {
    const d = target.clone().sub(this.pos);
    d.y = 0;
    const dist = d.length();
    if (dist < 0.02) return new THREE.Vector3();
    // v = sqrt(2 a d) caps the approach so the player can stop there
    const v = Math.min(this.skill.speed * urgency, Math.sqrt(2 * this.skill.accel * 0.9 * dist));
    return d.multiplyScalar(v / dist);
  }

  /** the rig follows the simulation */
  syncRig(dt: number, look: THREE.Vector3) {
    const r = this.rig;
    r.pos.copy(this.pos);
    r.vel.copy(this.vel);
    // square to the net, turned a little toward the ball when it's wide
    const toBall = Math.atan2(look.x - this.pos.x, look.z - this.pos.z);
    const base = this.facingYaw;
    const d = THREE.MathUtils.clamp(angleDiff(base, toBall), -0.5, 0.5);
    const want = r.inStroke ? r.yaw : base + d * 0.35;
    r.yaw += angleDiff(r.yaw, want) * Math.min(1, dt * 6);
    r.look.copy(look);
    r.update(dt);
  }

  /** the recovery spot after a shot: at the kitchen line or back at the baseline, shading toward where the ball went */
  recoverySpot(ballX: number, atNet = false): THREE.Vector3 {
    const x = THREE.MathUtils.clamp(ballX * 0.4, -1.4, 1.4);
    return new THREE.Vector3(x, 0, this.side * (atNet ? NVZ + 0.3 : HL + 0.5));
  }

  tickPlanCooldown(dt: number): boolean {
    this.planCooldown -= dt;
    if (this.planCooldown <= 0) {
      this.planCooldown = 0.12;
      return true;
    }
    return false;
  }
}


