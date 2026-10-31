import { BALL_R, netTop, type Surface } from './dims.ts';
import { spinFor, accel, spinKeep, type V3, v3 } from './Ball.ts';

/**
 * The shot solver: which launch velocity lands a ball struck at p0 with this pace and spin
 * on the target? It flies the real drag + Magnus model (no net) and searches the elevation
 * (range is single-peaked in elevation: a low branch for drives, a high one for lobs), then
 * corrects the azimuth for sidespin drift. If the ball can't clear the net with the margin
 * asked for, the pace comes down until it can — what a player does to make a shot.
 */

export interface ShotSpec {
  speed: number;
  rpm: number;
  side?: number;
  arc?: 'low' | 'high';
  /** required height of the ball's bottom over the cord (m) */
  clear?: number;
  /** don't lower the pace to make the shot (a flat-out swing that may miss) */
  commit?: boolean;
  /** a touch shot (dink / drop): if it can't get there over the net, add pace rather than take it off */
  soft?: boolean;
}

export interface ShotSolution {
  v: V3;
  w: V3;
  speed: number;
  land: { x: number; z: number };
  netClear: number;
  ok: boolean;
  elev: number;
}


/** fly without the net until the first ground contact: landing point, and the height when crossing z = 0 */
export function flyToGround(p0: V3, v0: V3, w0: V3, dt = 1 / 240, tMax = 5): { x: number; z: number; t: number; netY: number; netX: number } {
  let px = p0.x, py = p0.y, pz = p0.z, vx = v0.x, vy = v0.y, vz = v0.z;
  const wx = w0.x, wy = w0.y, wz = w0.z;
  let netY = Infinity, netX = 0;
  let t = 0;
  let sx = wx, sy = wy, sz = wz;
  const vv = v3(), ww = v3();
  while (t < tMax) {
    const s = Math.hypot(vx, vy, vz);
    vv.x = vx; vv.y = vy; vv.z = vz; ww.x = sx; ww.y = sy; ww.z = sz;
    const a = accel(vv, ww);
    const ax = a.x, ay = a.y, az = a.z;
    vx += ax * dt; vy += ay * dt; vz += az * dt;
    const opz = pz, opy = py, opx = px;
    px += vx * dt; py += vy * dt; pz += vz * dt;
    const decay = spinKeep(s, dt);
    sx *= decay; sy *= decay; sz *= decay;
    t += dt;
    if ((opz > 0) !== (pz > 0)) {
      const f = opz / (opz - pz);
      netY = opy + (py - opy) * f;
      netX = opx + (px - opx) * f;
    }
    if (py <= BALL_R) {
      const f = (opy - BALL_R) / Math.max(1e-6, opy - py);
      return { x: opx + (px - opx) * f, z: opz + (pz - opz) * f, t: t - dt * (1 - f), netY, netX };
    }
  }
  return { x: px, z: pz, t, netY, netX };
}

export function solveShot(p0: V3, target: { x: number; z: number }, spec: ShotSpec, _surface: Surface = 'hard'): ShotSolution {
  const clear = spec.clear ?? 0.05;
  let speed = spec.speed;
  let best: ShotSolution | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    let sol = solveAtSpeed(p0, target, speed, spec);
    const good = (s: ShotSolution) => s.netClear >= clear && Math.hypot(s.land.x - target.x, s.land.z - target.z) < 0.6;
    let ok = good(sol);
    if (!ok && spec.soft) {
      // a touch shot from below the tape loops up and over: try the high branch
      const hi = solveAtSpeed(p0, target, speed, { ...spec, arc: 'high' });
      if (good(hi) && hi.elev < 1.0) { sol = hi; ok = true; }
    }
    sol.ok = ok;
    if (ok) return sol;
    if (!best || sol.netClear > best.netClear) best = sol;
    if (spec.commit) return sol;
    // can't get there (into a headwind, say): hit harder; into the net at this pace: ease off
    // for a higher arc
    const short = Math.hypot(sol.land.x - p0.x, sol.land.z - p0.z) < Math.hypot(target.x - p0.x, target.z - p0.z) - 0.6;
    if (spec.soft || short) speed *= 1.12;
    else speed *= 0.9;
    if (speed < 3) break;
  }
  return best!;
}

function solveAtSpeed(p0: V3, target: { x: number; z: number }, speed: number, spec: ShotSpec): ShotSolution {
  const dx = target.x - p0.x, dz = target.z - p0.z;
  const D = Math.hypot(dx, dz);
  let az = Math.atan2(dz, dx);
  const arc = spec.arc ?? 'low';
  let elev = 0;
  let res = { x: 0, z: 0, t: 0, netY: 0, netX: 0 };
  let w = v3();
  const velOf = (e: number, a: number) => v3(Math.cos(e) * Math.cos(a) * speed, Math.sin(e) * speed, Math.cos(e) * Math.sin(a) * speed);
  for (let iter = 0; iter < 3; iter++) {
    w = spinFor(Math.cos(az), Math.sin(az), spec.rpm, spec.side ?? 0);
    // (trial flights at 1/120 s: the real flight is the ball sim's; the TV's CPU runs this at a hit)
    const range = (e: number) => {
      const r = flyToGround(p0, velOf(e, az), w, 1 / 120);
      // signed distance along the aim direction
      return ((r.x - p0.x) * dx + (r.z - p0.z) * dz) / D;
    };
    // the elevation of maximum range is only needed when a plain bracket doesn't reach: a low shot
    // that gets there by 0.55 rad (~32°) never needs it
    let eMax = 0.55, rMax = arc === 'low' ? range(eMax) : -1;
    if (rMax < D) {
      // golden section
      let lo = -0.35, hi = 1.2;
      const gr = 0.618;
      let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
      let fc = range(c), fd = range(d);
      for (let k = 0; k < 11; k++) {
        if (fc > fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = range(c); }
        else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = range(d); }
      }
      eMax = (lo + hi) / 2;
      rMax = range(eMax);
    }
    if (rMax < D) elev = eMax;
    else {
      // bisection on the chosen branch (14 halvings of ~1.2 rad: under a millimetre of range)
      let a = arc === 'low' ? -0.6 : eMax, b = arc === 'low' ? eMax : 1.45;
      for (let k = 0; k < 14; k++) {
        const m = (a + b) / 2;
        const r = range(m);
        if (arc === 'low' ? r < D : r > D) a = m;
        else b = m;
      }
      elev = (a + b) / 2;
    }
    res = flyToGround(p0, velOf(elev, az), w, 1 / 120);
    // azimuth correction for drift
    const landAz = Math.atan2(res.z - p0.z, res.x - p0.x);
    const want = Math.atan2(dz, dx);
    let dAz = want - landAz;
    dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
    if (Math.abs(dAz) < 2e-3) break;
    az += dAz;
  }
  const v = velOf(elev, az);
  // never reaching the net is no clearance at all (it used to read as a mile over it)
  const netClear = res.netY === Infinity ? (Math.sign(res.z) !== Math.sign(p0.z) ? 9 : -9) : res.netY - BALL_R - netTop(res.netX);
  return { v, w, speed, land: { x: res.x, z: res.z }, netClear, ok: false, elev };
}
