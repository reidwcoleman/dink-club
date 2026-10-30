import * as THREE from 'three';
import { HL } from '../sim/dims.ts';

export type CamMode = 'broadcast' | 'high' | 'low' | 'intro' | 'side' | 'close' | 'replaySide' | 'replayBaseline' | 'replaySpider' | 'hawkeye';

/**
 * The director: a broadcast camera behind the human player's end (elevated, a long lens,
 * gently tracking the ball and the player so the rally stays framed), plus the cuts a
 * television producer would make — the opening flyover, a low courtside angle, a player
 * close-up at the change of ends, replay angles, and the Hawk-Eye view.
 */
export class CameraDirector {
  mode: CamMode = 'broadcast';
  /** which end the broadcast camera sits behind (+1 near / −1 far) */
  side: 1 | -1 = 1;
  /** player camera preference: 0 broadcast, 1 high, 2 low */
  pref = 0;
  private pos = new THREE.Vector3(0, 8, 26);
  private look = new THREE.Vector3(0, 0, 0);
  private t = 0;
  private shake = 0;
  subject = new THREE.Vector3();
  subject2 = new THREE.Vector3();
  focusDist = 30;
  /** a locked camera (tools / screenshots) */
  fixed: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  cut(mode: CamMode) {
    this.mode = mode;
    this.t = 0;
    this.snap = true;
  }
  private snap = true;

  bump(k: number) {
    this.shake = Math.max(this.shake, k);
  }

  update(dt: number, ball: THREE.Vector3, human: THREE.Vector3, opp: THREE.Vector3) {
    this.t += dt;
    if (this.fixed) {
      this.camera.position.copy(this.fixed.pos);
      this.camera.lookAt(this.fixed.look);
      this.camera.fov = this.fixed.fov;
      this.camera.updateProjectionMatrix();
      return;
    }
    const s = this.side;
    const cam = this.camera;
    let fov = 36;
    const wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();
    let rate = 3.5;
    switch (this.mode) {
      case 'broadcast':
      case 'high':
      case 'low': {
        const m = this.mode === 'broadcast' ? ['broadcast', 'high', 'low'][this.pref] : this.mode;
        // follow the midpoint of the ball and the player, a little
        const fx = THREE.MathUtils.clamp(ball.x * 0.4 + human.x * 0.6, -4, 4);
        const push = THREE.MathUtils.clamp((HL - human.z * s) * 0.3, -0.6, 1.6);
        if (m === 'high') {
          wantPos.set(fx * 0.25, 8.6, s * (HL + 10.5 - push * 0.4));
          wantLook.set(fx * 0.45, 0, s * -0.8);
          fov = 38;
        } else if (m === 'low') {
          wantPos.set(fx * 0.4, 2.1, s * (HL + 4.6 - push * 0.6));
          wantLook.set(fx * 0.55, 0.9, s * -2.5);
          fov = 46;
        } else {
          // a game camera: low and close behind the baseline so the players are big and the ball is readable
          wantPos.set(fx * 0.32, 3.9, s * (HL + 6.4 - push * 0.5));
          wantLook.set(fx * 0.48, 0.55, s * -2.0);
          fov = 44;
        }
        rate = 2.6;
        break;
      }
      case 'intro': {
        // a slow orbit high above the bowl, descending toward the broadcast position
        const u = Math.min(1, this.t / 9);
        const e = u * u * (3 - 2 * u);
        const ang = -1.1 + e * 1.1 + Math.PI * 0.5 * (1 - e);
        const r = 34 - e * 21;
        wantPos.set(Math.sin(ang) * r * 0.6, 17 - e * 13.1, s * Math.cos(ang) * r);
        wantLook.set(0, 0.5, -1 * e);
        fov = 44;
        rate = 50;
        break;
      }
      case 'side': {
        // low beside the net post, looking along the net across the court
        wantPos.set(6.2, 1.4, s * 2.0);
        wantLook.set(0, 1.0, s * -1.5);
        fov = 44;
        rate = 50;
        break;
      }
      case 'close': {
        // a telephoto on the subject (a player walking, bouncing the ball)
        const p = this.subject;
        const dir = new THREE.Vector3(p.x * 0.3 + 3, 0, -Math.sign(p.z || 1) * 4.5).normalize();
        wantPos.set(p.x + dir.x * 5, 1.6, p.z - Math.sign(p.z || 1) * 5);
        wantLook.set(p.x, 1.25, p.z);
        fov = 22;
        rate = 6;
        this.focusDist = wantPos.distanceTo(wantLook);
        break;
      }
      case 'replaySide': {
        // low on the benches' side, clear of the umpire's chair
        const z = THREE.MathUtils.clamp(ball.z * 0.55, -6, 6);
        wantPos.set(-6.4, 1.25, Math.abs(z) < 1.5 ? Math.sign(z || 1) * 1.5 : z);
        wantLook.set(ball.x * 0.4, 0.9, ball.z * 0.8);
        fov = 40;
        rate = 4;
        this.focusDist = wantPos.distanceTo(ball);
        break;
      }
      case 'replayBaseline': {
        const hs = Math.sign(this.subject.z || 1);
        wantPos.set(this.subject.x * 0.6 + 0.6, 1.3, hs * (HL + 3.8));
        wantLook.set(ball.x * 0.5, 1.0, ball.z * 0.6);
        fov = 32;
        rate = 5;
        this.focusDist = wantPos.distanceTo(this.subject);
        break;
      }
      case 'replaySpider': {
        wantPos.set(ball.x * 0.7, 6.5, ball.z * 0.8 + 4);
        wantLook.set(ball.x, 0.5, ball.z);
        fov = 45;
        rate = 3;
        this.focusDist = wantPos.distanceTo(ball);
        break;
      }
      case 'hawkeye': {
        const p = this.subject;
        wantPos.set(p.x + 0.9, 1.4, p.z + Math.sign(p.z || 1) * 2.2);
        wantLook.set(p.x, 0.02, p.z);
        fov = 30;
        rate = 2;
        break;
      }
    }
    void opp;
    if (this.snap) {
      this.pos.copy(wantPos);
      this.look.copy(wantLook);
      this.snap = false;
    } else {
      const k = 1 - Math.exp(-rate * dt);
      this.pos.lerp(wantPos, k);
      this.look.lerp(wantLook, k);
    }
    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.06;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.06;
      this.shake *= Math.exp(-dt * 10);
    }
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
      cam.updateProjectionMatrix();
    }
  }
}

