import * as THREE from 'three';
import { BallSim, predict, type BallEvent, v3 } from '../sim/Ball.ts';
import { solveShot, type ShotSpec } from '../sim/Shot.ts';
import { HL, HW, NVZ, BALL_R, FLOOR_HX } from '../sim/dims.ts';
import { FENCE } from '../world/Club.ts';
import { Match, type PointReason } from './Match.ts';
import { Player, type Plan } from './Player.ts';
import { PlayerRig, type StrokeKind } from './PlayerRig.ts';
import { Human, type Outfit } from '../people/Human.ts';
import { BallView } from './BallView.ts';
import type { Input, ShotType, Swing } from './Input.ts';
import { aiChooseShot, aiServe, AI_LEVELS, type Difficulty, type ShotChoice } from './AI.ts';
import { CameraDirector } from './CameraDirector.ts';
import { Replay } from './Replay.ts';
import { PADDLE_ART } from './Racket.ts';
import type { World } from '../world/World.ts';
import type { Crowd } from '../people/Crowd.ts';
import type { HUD } from '../ui/HUD.ts';
import type { Audio } from '../audio/Audio.ts';

export interface RosterEntry {
  avatar: string;
  name: string;
  outfit: Outfit;
}

/** the club's regulars (fictional), on the Rocketbox athletes and adults dressed for the court */
export const ROSTER: RosterEntry[] = [
  { avatar: 'Sports_Male_04', name: 'Dex', outfit: { top: '#ff8a1f', shorts: '#1b2a4a', socks: '#f4f4f0', shoes: '#f2f2f2' } },
  { avatar: 'Sports_Female_02', name: 'Marisol', outfit: { top: '#2fc4c0', shorts: '#f4f4f0', socks: '#f4f4f0', shoes: '#f2f2f2' } },
  { avatar: 'Sports_Male_02', name: 'Gus', outfit: { top: '#f4f4f0', shorts: '#2b4a5e', socks: '#f4f4f0', shoes: '#f2f2f2', trim: '#ff5aa5' } },
  { avatar: 'Sports_Male_03', name: 'Theo', outfit: { top: '#ffd23f', shorts: '#1a1b1f', socks: '#f4f4f0', shoes: '#f2f2f2' } },
];

type State = 'idle' | 'preServe' | 'serving' | 'rally' | 'pointOver' | 'replay' | 'matchOver';

export interface GameConfig {
  level: Difficulty;
  /** 1: you vs the computer; 2: two phones head to head */
  players: 1 | 2;
  to: number;
  games: 1 | 3;
  rally: boolean;
  /** roster indices for the near and far player */
  near: number;
  far: number;
  demo?: boolean;
}

/** timing window for a human swing relative to the ideal contact (s) */
const EARLY = 0.36, LATE = 0.14;

export class Game {
  readonly ball = new BallSim();
  readonly ballView = new BallView();
  players!: [Player, Player];
  match!: Match;
  readonly dir: CameraDirector;
  state: State = 'idle';
  stateT = 0;
  clock = 0;
  cfg!: GameConfig;
  private pred: { pts: ReturnType<typeof predict>['pts']; events: BallEvent[]; t0: number } | null = null;
  private lastHitter: 0 | 1 | null = null;
  private bounceSide: 1 | -1 = 1;
  private bouncesAfterHit = 0;
  /** strikes this rally (the serve is 1) */
  private strikes = 0;
  private serverIdx: 0 | 1 = 0;
  private aiServeAt = 0;
  private pendingPoint: { winner: 0 | 1; reason: PointReason; at: number } | null = null;
  private dead = false;
  private lastHitT = 0;
  private lastShot: ShotType = 'serve';
  private serve: { tContact: number; release: number; released: boolean; choice: ShotChoice; contact: THREE.Vector3 } | null = null;
  /** a human's committed swing for the current plan: strike at `at` with this timing error */
  private committed: [{ at: number; err: number; swing: Swing } | null, { at: number; err: number; swing: Swing } | null] = [null, null];
  private prevVel = [new THREE.Vector3(), new THREE.Vector3()];
  /** this player already missed the ball in flight (no more plans until the next strike) */
  private missed = [false, false];
  private lastSqueak = [0, 0];
  private hitStop = 0;
  replay!: Replay;
  private highlight = false;
  onMatchOver: ((m: Match) => void) | null = null;
  onDof: ((on: boolean, focus?: number, range?: number) => void) | null = null;
  /** phone feedback (main wires it to the lobby) */
  onPadEvent: ((slot: number, kind: 'hit' | 'whiff' | 'point', data: Record<string, unknown>) => void) | null = null;
  onStatus: ((slot: number, text: string, sub: string, serve: boolean) => void) | null = null;
  readonly log: string[] = [];
  private say(s: string) {
    this.log.push(`${this.clock.toFixed(2)} ${s}`);
    if (this.log.length > 400) this.log.shift();
  }
  names: [string, string] = ['', ''];

  constructor(readonly world: World, readonly camera: THREE.PerspectiveCamera, readonly input: Input, readonly hud: HUD, readonly audio: Audio, readonly crowd: Crowd | null) {
    this.dir = new CameraDirector(camera);
    world.scene.add(this.ballView.mesh, this.ballView.streak, this.ballView.shadow, this.ballView.marker, this.ballView.flashSprite);
    world.dynamic.push(this.ballView.mesh, this.ballView.streak, this.ballView.shadow, this.ballView.marker, this.ballView.flashSprite);
    this.ball.surface = world.venue.surface;
  }

  async setup(cfg: GameConfig, names: [string, string], paddles: [number, number]) {
    this.cfg = cfg;
    if (this.players) for (const p of this.players) { this.world.scene.remove(p.rig.group); }
    const make = async (r: RosterEntry, i: 0 | 1, human: boolean, paddle: number) => {
      const h = await Human.create(r.avatar, r.outfit);
      const rig = new PlayerRig(h, PADDLE_ART[paddle % PADDLE_ART.length]);
      this.world.scene.add(h.root);
      this.world.dynamic.push(h.root);
      return new Player(i, r.name, rig, human, human ? { speed: 5.4, accel: 19, power: 0.95, accuracy: 0.9, spin: 0.85, reaction: 0.05 } : AI_LEVELS[cfg.level].skill);
    };
    const a = ROSTER[cfg.near], b = ROSTER[cfg.far];
    this.players = [await make(a, 0, !cfg.demo, paddles[0]), await make(b, 1, cfg.players === 2 && !cfg.demo, paddles[1])];
    this.players[0].side = 1;
    this.players[1].side = -1;
    this.names = names;
    this.replay = new Replay(this.players, this.ballView.mesh);
    this.hud.names = this.names;
    this.match = new Match({ to: cfg.to, games: cfg.games, rally: cfg.rally }, Math.random() < 0.5 ? 0 : 1);
    this.dir.side = 1;
    this.dir.cut('intro');
  }

  get human(): Player {
    return this.players[0];
  }

  private boards() {
    const m = this.match;
    this.world.club.score(this.names[0], this.names[1], m.cfg.rally ? `${m.score[0]}-${m.score[1]}` : m.call(), m.cfg.games === 3 ? `Games ${m.games[0]}-${m.games[1]}` : `${this.names[m.server]} serving`);
    this.hud.score(m);
  }

  begin() {
    this.boards();
    this.setupPoint();
    this.dir.cut('broadcast');
  }

  // ------------------------------------------------------------------------------------ points
  private setupPoint() {
    const m = this.match;
    const srv = m.server;
    this.serverIdx = srv;
    const S = this.players[srv], R = this.players[1 - srv];
    const right = m.fromRight ? 1 : -1;
    // the server stands behind the baseline in the right (even) or left (odd) half; the receiver diagonally
    S.place(S.side * right * 0.85, S.side * (HL + 0.25));
    R.place(R.side * right * 0.95, R.side * (HL + 0.15));
    for (const p of this.players) {
      p.plan = null;
      p.shot = null;
      p.moveTarget = null;
      p.rig.cancelStroke();
    }
    this.committed = [null, null];
    this.ball.frozen = true;
    this.ballView.mesh.visible = true;
    this.pred = null;
    this.lastHitter = null;
    this.bouncesAfterHit = 0;
    this.strikes = 0;
    this.pendingPoint = null;
    this.serve = null;
    this.dead = false;
    this.highlight = false;
    this.replay?.clear();
    this.aiServeAt = this.clock + 1.2 + Math.random() * 1.0;
    this.setState('preServe');
    this.input.clear();
    this.audio.crowdLevel(0.15);
    const pr = m.pressure();
    if (pr.gamePoint !== null) this.hud.call(pr.matchPoint ? 'Match point' : 'Game point', this.names[pr.gamePoint], 2.2);
    if (!m.cfg.rally) this.hud.callout(m.call() + (S.human ? '' : ''));
    for (const p of this.players) {
      if (!p.human) continue;
      const mine = p.index === srv;
      this.onStatus?.(p.index, mine ? 'Your serve' : 'Get ready', mine ? 'Swing underhand to serve' : `${this.names[srv]} to serve`, mine);
    }
    if (S.human) this.hud.prompt(this.players[1].human ? `${this.names[srv]}: swing to serve` : 'Swing to serve');
  }

  private setState(s: State) {
    this.state = s;
    this.stateT = 0;
  }

  // ------------------------------------------------------------------------------------ the frame
  update(dt: number) {
    if (this.state === 'idle') return;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt *= 0.25;
    }
    this.clock += dt;
    this.stateT += dt;
    if (this.state === 'replay') {
      this.replayTick(dt);
      this.hud.update(dt);
      return;
    }
    switch (this.state) {
      case 'preServe': this.preServe(dt); break;
      case 'serving': this.serving(dt); break;
      case 'rally': this.rally(dt); break;
      case 'pointOver': this.pointOver(dt); break;
      case 'matchOver': this.idlePlayers(dt); break;
    }
    if (!this.ball.frozen) {
      const ev = this.ball.step(dt);
      for (const e of ev) this.onBallEvent(e);
      const p = this.ball.p, v = this.ball.v;
      // the divider netting and the fences stop it
      const fx = FLOOR_HX + 0.3, fzN = FENCE.zNear - 0.1, fzF = FENCE.zFar + 0.08;
      if (Math.abs(p.x) > fx && p.y < 1.0 && Math.abs(p.x) < fx + 0.3) { p.x = Math.sign(p.x) * fx; v.x *= -0.2; v.z *= 0.5; this.onBallDead(); }
      if (Math.abs(p.x) > FENCE.x - 0.1) { p.x = Math.sign(p.x) * (FENCE.x - 0.1); v.x *= -0.2; v.z *= 0.4; this.onBallDead(); }
      if (p.z < fzF) { p.z = fzF; v.z *= -0.15; v.x *= 0.4; this.onBallDead(); }
      if (p.z > fzN) { p.z = fzN; v.z *= -0.15; v.x *= 0.4; this.onBallDead(); }
      if (this.ball.p.y <= BALL_R + 0.001 && Math.hypot(this.ball.v.x, this.ball.v.z) < 0.25 && Math.abs(this.ball.v.y) < 0.1) this.onBallDead();
    }
    const look = new THREE.Vector3(this.ball.p.x, this.ball.p.y, this.ball.p.z);
    for (const p of this.players) {
      p.syncRig(dt, look);
      this.footSounds(p, dt);
    }
    // the ball rests in the server's hand until the drop
    if (this.ball.frozen && (this.state === 'preServe' || (this.state === 'serving' && this.serve && !this.serve.released))) {
      const S = this.players[this.serverIdx];
      const h = S.rig.offHand;
      this.ball.p = v3(h.x, h.y + 0.02, h.z);
      this.ball.v = v3();
      this.ball.w = v3();
    }
    this.ballView.update(this.ball.p, this.ball.w, this.ball.v, dt, this.camera.position);
    this.ballView.setMarker(this.landingSpot(), dt);
    this.world.ballPos.copy(look);
    if (this.state === 'serving' || this.state === 'rally' || (this.state === 'pointOver' && this.stateT < 1.2)) this.replay.record(dt, this.clock);
    this.dir.update(dt, look, this.human.pos, this.players[1].pos);
    this.hud.update(dt);
  }

  /** where the ball will land on a human's side (a ring on the court), until it does */
  private landingSpot(): { x: number; z: number } | null {
    if (this.state !== 'rally') return null;
    if (this.dead || this.pendingPoint || !this.pred || this.lastHitter === null || this.cfg.demo) return null;
    const recv = this.players[1 - this.lastHitter];
    if (!recv.human) return null;
    if (this.bouncesAfterHit > 0) return null;
    const b = this.pred.events.find((e) => e.kind === 'bounce' && e.z * recv.side > 0) as Extract<BallEvent, { kind: 'bounce' }> | undefined;
    return b ? { x: b.x, z: b.z } : null;
  }

  // ------------------------------------------------------------------------------------ serve
  private preServe(dt: number) {
    const S = this.players[this.serverIdx], R = this.players[1 - this.serverIdx];
    S.drive(dt, new THREE.Vector3());
    R.drive(dt, new THREE.Vector3());
    if (S.human) {
      const sw = this.input.take(S.index, 0.4);
      if (sw && this.stateT > 0.5) this.startServe({ type: 'serve', aimX: 0, power: sw.power }, sw);
    } else if (this.clock > this.aiServeAt && this.stateT > 1.0) {
      this.startServe(aiServe(this.cfg.level), null);
    }
    if (R.human) this.input.clear(R.index);
  }

  private startServe(choice: ShotChoice, swing: Swing | null) {
    const S = this.players[this.serverIdx];
    this.hud.prompt(null);
    this.audio.start();
    // a human's swing is already happening: drop and hit quickly; the computer takes its time
    const lead = swing ? 0.3 : 0.75;
    const contact = S.pos.clone().addScaledVector(S.right, 0.36).addScaledVector(S.fwd, 0.42).setY(0.55);
    this.serve = { tContact: this.clock + lead, release: this.clock + lead - 0.22, released: false, choice, contact };
    S.rig.swing('serve', lead, contact, S.fwd);
    this.setState('serving');
    this.audio.crowdLevel(0.0, 0.6);
    for (const p of this.players) if (p.human) this.onStatus?.(p.index, p.index === S.index ? 'Serving' : 'Let it bounce', '', false);
  }

  private serving(dt: number) {
    const S = this.players[this.serverIdx], R = this.players[1 - this.serverIdx];
    S.drive(dt, new THREE.Vector3());
    R.drive(dt, R.seek(R.pos, 0.3));
    const sv = this.serve!;
    if (!sv.released && this.clock >= sv.release) {
      // the drop: a short fall from the hand into the paddle's path
      sv.released = true;
      const p0 = this.ball.p;
      const T = sv.tContact - this.clock;
      const c = sv.contact;
      this.ball.set(p0, v3((c.x - p0.x) / T, (c.y - p0.y + 0.5 * 9.81 * T * T) / T, (c.z - p0.z) / T), v3());
    }
    if (this.clock >= sv.tContact) this.serveStrike();
  }

  private serveStrike() {
    const S = this.players[this.serverIdx];
    const sv = this.serve!;
    const power = THREE.MathUtils.clamp(sv.choice.power, 0.1, 1);
    // the diagonal service court: past the kitchen line, deeper with more swing
    const right = this.match.fromRight ? 1 : -1;
    const boxSign = -S.side * right;
    const wide = THREE.MathUtils.clamp(0.5 + sv.choice.aimX * 0.4 + (Math.random() - 0.5) * 0.3, 0.1, 0.9);
    const depth = THREE.MathUtils.lerp(NVZ + 2.0, HL - 0.6, Math.min(1, 0.25 + power));
    const acc = S.skill.accuracy;
    const sigma = (0.12 + power * power * 0.4) * (1.3 - acc) * (S.human ? 0.6 : 1);
    let tx = boxSign * THREE.MathUtils.lerp(0.4, HW - 0.4, wide) + gauss() * sigma;
    let tz = -S.side * (depth + gauss() * sigma * 1.2);
    // the computer's occasional fault
    if (!S.human && Math.random() < AI_LEVELS[this.cfg.level].errors * 0.5) tz = -S.side * (Math.random() < 0.5 ? HL + 0.3 + Math.random() : NVZ - 0.4);
    // a flat-out human serve can sail
    if (S.human && power > 0.93 && Math.random() < 0.25) tz = -S.side * (HL + 0.15 + Math.random() * 0.6);
    tx = THREE.MathUtils.clamp(tx, -HW - 0.6, HW + 0.6);
    const contact = { x: this.ball.p.x, y: Math.max(0.35, this.ball.p.y), z: this.ball.p.z };
    const spec: ShotSpec = { speed: 9 + 8.5 * power * S.skill.power, rpm: 700, clear: 0.22 };
    const sol = solveShot(contact, { x: tx, z: tz }, spec);
    this.launch(S, contact, sol.v, sol.w, 'serve', power, 1);
    this.say(`serve ${this.names[S.index]} p=${power.toFixed(2)} to(${tx.toFixed(2)},${tz.toFixed(2)}) ${(sol.speed * 3.6).toFixed(0)}kmh ok=${sol.ok}`);
    this.serve = null;
    this.setState('rally');
    for (const p of this.players) if (p.human) this.onStatus?.(p.index, p.index === S.index ? 'Stay back' : 'Let it bounce', p.index === S.index ? 'The return must bounce' : 'Return it deep', false);
  }

  /** a strike: the ball leaves the paddle */
  private launch(p: Player, contact: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, w: { x: number; y: number; z: number }, type: ShotType, power: number, quality: number) {
    this.ball.set(contact, v, w);
    this.ball.bounces = 0;
    this.lastHitter = p.index;
    this.bouncesAfterHit = 0;
    this.strikes++;
    this.lastHitT = this.clock;
    this.lastShot = type;
    this.replay.mark('hit', this.clock, contact.x, contact.z);
    const speed = Math.hypot(v.x, v.y, v.z);
    this.ballView.flash(contact, Math.min(1, speed / 22));
    this.audio.pop(Math.min(1, speed / 20), type === 'dink' || type === 'drop' ? 'soft' : speed > 15 ? 'hard' : 'mid', this.pan(contact), p.pos.distanceTo(this.camera.position));
    if (speed > 17) { this.dir.bump(0.25); this.hitStop = 0.05; }
    if (p.human) this.onPadEvent?.(p.index, 'hit', { power, quality, shot: type });
    if (this.strikes >= 6) this.hud.rally(this.strikes);
    this.afterStrike();
    this.audio.crowdLevel(0.0, 0.4);
  }

  // ------------------------------------------------------------------------------------ rally
  private afterStrike() {
    const b = this.ball;
    this.pred = { ...predict(b.p, b.v, b.w, b.surface, 5, 1 / 120, 3), t0: this.clock };
    const hitter = this.players[this.lastHitter!];
    const recv = this.players[1 - this.lastHitter!];
    hitter.plan = null;
    this.committed[hitter.index] = null;
    this.missed = [false, false];
    const landX = this.pred.pts[this.pred.pts.length - 1].x;
    // positioning: the server stays back until the return has bounced (strike 1); the returner comes in;
    // after the third shot both work toward the kitchen line (a drive from the back stays a step deeper)
    const s = this.strikes;
    let atNet = true;
    if (hitter.index === this.serverIdx && s === 1) atNet = false;
    if (s === 3 && this.lastShot === 'drive') atNet = false;
    if (this.lastShot === 'lob') atNet = true;
    hitter.moveTarget = hitter.recoverySpot(landX, atNet);
    recv.plan = null;
    this.committed[recv.index] = null;
    recv.rig.splitStep();
    this.replan(recv, true);
  }

  private replan(p: Player, force = false): void {
    if (!this.pred && this.ball.frozen) return;
    const b = this.ball;
    const pr = predict(b.p, b.v, b.w, b.surface, 4, 1 / 120, 3);
    const events = pr.events.slice();
    if (this.bouncesAfterHit > 0 && this.bounceSide === p.side) events.unshift({ kind: 'bounce', x: b.p.x, z: b.p.z, t: -0.01, speed: 0, vy: 0 });
    // the two-bounce rule: the serve and the return must bounce
    const plan = p.planIntercept(pr.pts, events, this.clock, this.strikes >= 3);
    if (!plan) return;
    if (p.plan && p.plan.swung) {
      const moved = plan.ball.distanceTo(p.plan.ball);
      if (moved < 0.6 || plan.tContact - this.clock < 0.35) {
        p.plan.ball.copy(plan.ball);
        p.plan.tContact = plan.tContact;
        if (!p.human || this.committed[p.index]) p.rig.setContact(plan.ball, Math.max(0.05, (this.committed[p.index]?.at ?? plan.tContact) - this.clock));
        else p.rig.setContact(plan.ball);
        return;
      }
      p.rig.cancelStroke();
      this.committed[p.index] = null;
      force = true;
    }
    if (force || !p.plan || Math.abs(plan.tContact - p.plan.tContact) > 0.05 || plan.body.distanceTo(p.plan.body) > 0.3 || plan.forehand !== p.plan.forehand) {
      p.plan = plan;
      if (!p.human) {
        const opp = this.players[1 - p.index];
        const c = aiChooseShot(p, plan, opp, this.cfg.level, this.strikes + 1);
        p.shot = { type: c.type, aimX: c.aimX, aimD: 0, power: c.power, pressT: this.clock, released: true };
      }
    } else p.plan = { ...plan, swung: p.plan.swung };
  }

  private rally(_dt: number) {
    const dt = _dt;
    const hitterIdx = this.lastHitter;
    for (const p of this.players) {
      const receiving = hitterIdx !== null && p.index !== hitterIdx;
      if (receiving && !this.missed[p.index] && p.tickPlanCooldown(dt)) this.replan(p);
      this.move(p, dt, receiving);
      if (p.human) this.humanSwing(p, receiving);
      if (receiving && p.plan) this.tryStrike(p);
    }
    if (this.pendingPoint && this.clock >= this.pendingPoint.at) {
      const pp = this.pendingPoint;
      this.pendingPoint = null;
      this.awardPoint(pp.winner, pp.reason);
    }
  }

  private move(p: Player, dt: number, receiving: boolean) {
    let target: THREE.Vector3 | null = null;
    let urgency = 1;
    if (receiving && p.plan && !this.dead) target = p.plan.body;
    else if (p.moveTarget) {
      target = p.moveTarget;
      urgency = 0.7;
    }
    if (!p.human && this.pred && this.clock - this.pred.t0 < p.skill.reaction) target = null;
    p.drive(dt, target ? p.seek(target, urgency) : new THREE.Vector3());
  }

  private strokeFor(p: Player, plan: Plan, type?: ShotType): StrokeKind {
    if (plan.smash) return 'smash';
    if (type === 'dink' || type === 'drop') return plan.forehand ? 'fhDink' : 'bhDink';
    if (plan.volley) return plan.forehand ? 'fhVolley' : 'bhVolley';
    if (type === 'lob') return plan.forehand ? 'fhLob' : 'bhLob';
    if (type === 'reset') return plan.forehand ? 'fhSlice' : 'bhSlice';
    return plan.forehand ? 'fh' : 'bh';
  }

  /** a human's swings: early enough → strike at the ideal contact; a touch late → strike now; way off → nothing */
  private humanSwing(p: Player, receiving: boolean) {
    const sw = this.input.take(p.index, 0.5);
    const plan = p.plan;
    if (!sw) return;
    // the swing's moment on the game clock (it may have peaked a few frames ago on the phone)
    const at = this.clock - Math.max(0, performance.now() / 1000 - sw.at);
    const c = this.committed[p.index];
    if (c && plan && this.clock < c.at) {
      // a second, harder swing before contact: that was the backswing; this is the real one
      if (sw.power > c.swing.power * 0.8 || sw.power > 0.3) {
        const err = at - plan.tContact;
        if (err >= -EARLY && err <= LATE) {
          c.err = err;
          c.swing = sw;
          const type = this.humanShot(p, plan, sw);
          if (p.shot) { p.shot.type = type; p.shot.power = sw.power; }
        }
      }
      return;
    }
    if (!receiving || !plan || this.dead || c) {
      // a swing at nothing: an air swing (feedback that the phone is live)
      if (!p.rig.inStroke) p.rig.swing(sw.power < 0.3 ? 'fhDink' : 'fh', 0.18, p.pos.clone().addScaledVector(p.right, 0.6).addScaledVector(p.fwd, 0.4).setY(0.85), p.fwd);
      return;
    }
    const err = at - plan.tContact;
    if (err < -EARLY) {
      this.say(`too early ${err.toFixed(2)}`);
      this.hud.timing('Too early', p.index);
      return;
    }
    if (err > LATE) return;
    const type = this.humanShot(p, plan, sw);
    p.shot = { type, aimX: 0, aimD: 0, power: sw.power, pressT: sw.at, released: true };
    const strikeAt = Math.max(this.clock + 0.06, plan.tContact);
    this.committed[p.index] = { at: strikeAt, err, swing: sw };
    plan.swung = true;
    p.rig.swing(this.strokeFor(p, plan, type), strikeAt - this.clock, plan.ball, p.fwd);
  }

  /** what a phone swing means here: how hard, how upward, and where the ball is */
  private humanShot(p: Player, plan: Plan, sw: Swing): ShotType {
    const atKitchen = Math.abs(plan.body.z) < NVZ + 1.1;
    if (plan.smash && sw.power > 0.4) return 'smash';
    if (sw.lift > 0.55 && sw.power > 0.22) return 'lob';
    if (sw.power < 0.3) return atKitchen ? 'dink' : 'drop';
    if (sw.power < 0.68) return plan.volley && atKitchen && plan.ball.y > 1.0 ? 'drive' : 'reset';
    return 'drive';
  }

  private tryStrike(p: Player) {
    if (this.dead) {
      p.plan = null;
      return;
    }
    const plan = p.plan!;
    const c = this.committed[p.index];
    const tTo = plan.tContact - this.clock;
    if (!p.human) {
      const type = p.shot?.type;
      const lead = plan.volley ? 0.42 : plan.smash ? 0.6 : 0.62;
      if (!plan.swung && tTo <= lead && tTo > 0.06) {
        plan.swung = true;
        p.rig.swing(this.strokeFor(p, plan, type), tTo, plan.ball, p.fwd);
      }
      if (tTo > 0) return;
    } else {
      // the human gets ready on their own (a backswing held until they swing)
      if (!plan.swung && !c && tTo <= 0.7 && tTo > 0.05) {
        p.rig.swing(this.strokeFor(p, plan, 'reset'), 6, plan.ball, p.fwd);
        plan.swung = true;
      }
      if (!c) {
        if (tTo < -LATE - 0.02) {
          // never swung: the ball goes by
          this.missed[p.index] = true;
          this.say(`no swing ${this.names[p.index]}`);
          p.rig.cancelStroke();
          p.plan = null;
          this.onPadEvent?.(p.index, 'whiff', {});
        }
        return;
      }
      if (this.clock < c.at) return;
    }
    // contact
    const b = this.ball.p;
    const ballV = new THREE.Vector3(b.x, b.y, b.z);
    const lat = plan.smash ? 0.25 : plan.forehand ? 0.62 : 0.56;
    const ahead = plan.smash ? 0.35 : plan.volley ? 0.5 : 0.38;
    const ideal = p.pos.clone().addScaledVector(p.right, plan.forehand ? lat : -lat).addScaledVector(p.fwd, ahead);
    const dh = Math.hypot(ideal.x - b.x, ideal.z - b.z);
    const dy = Math.abs(b.y - plan.ball.y);
    p.plan = null;
    const reach = p.human ? 1.9 : 1.1, reachY = p.human ? 1.4 : 0.9;
    if (dh > reach || dy > reachY || b.y > 2.8 || b.y < 0.04) {
      this.missed[p.index] = true;
      this.say(`miss ${this.names[p.index]} dh=${dh.toFixed(2)} dy=${dy.toFixed(2)} y=${b.y.toFixed(2)}`);
      if (p.human) this.onPadEvent?.(p.index, 'whiff', {});
      this.committed[p.index] = null;
      return;
    }
    let quality: number;
    if (p.human) {
      const err = c!.err;
      quality = THREE.MathUtils.clamp(1 - Math.max(0, Math.abs(err) - 0.07) / 0.3, 0.3, 1);
      this.hud.timing(Math.abs(err) < 0.07 ? 'Perfect' : err < 0 ? 'Early' : 'Late', p.index);
    } else quality = THREE.MathUtils.clamp(1 - Math.max(0, dh - 0.3) / 0.85 - dy * 0.3, 0.2, 1);
    this.strike(p, ballV, quality, plan);
    this.committed[p.index] = null;
  }

  /** the ball leaves the paddle: target from the shot + aim, the error, and the flight */
  private strike(p: Player, contact: THREE.Vector3, quality: number, plan: Plan) {
    const shot = p.shot ?? { type: 'reset' as ShotType, aimX: 0, aimD: 0, power: 0.5, pressT: this.clock, released: true };
    const type = shot.type;
    let power = shot.power;
    let aimX = shot.aimX;
    if (p.human) {
      // timing steers: early pulls across the body, late pushes the other way
      const err = this.committed[p.index]?.err ?? 0;
      const k = THREE.MathUtils.clamp(err / 0.16, -1, 1);
      aimX = (plan.forehand ? k : -k) * 0.95 + (Math.random() - 0.5) * 0.25;
    }
    const s = p.side;
    const opp = this.players[1 - p.index];
    let depth: number;
    let spec: ShotSpec;
    const pw = power * p.skill.power * (0.6 + 0.4 * quality);
    const fromNet = Math.abs(contact.z);
    switch (type) {
      case 'dink':
        depth = 0.75 + Math.random() * 0.9;
        spec = { speed: 3.4 + fromNet * 0.5, rpm: -250, clear: 0.06 + (1 - quality) * 0.25, soft: true };
        break;
      case 'drop':
        depth = 0.9 + Math.random() * 1.0;
        spec = { speed: 5.2 + fromNet * 0.3, rpm: -200, clear: 0.2, soft: true };
        break;
      case 'lob':
        depth = HL - 0.9;
        spec = { speed: 11 + 3 * pw, rpm: 900, arc: 'high', clear: 2.2 };
        break;
      case 'smash':
        depth = 3.4 + Math.random() * 2;
        spec = { speed: 17 + 9 * pw, rpm: 400, clear: 0.08 };
        break;
      case 'drive':
        depth = plan.volley ? 3.5 + Math.random() * 2.5 : HL - 1.1 - Math.random() * 1.2;
        spec = { speed: 12.5 + 9 * pw, rpm: 1600, clear: 0.1 };
        // a speed-up from the kitchen goes at the opponent
        if (fromNet < NVZ + 1.2 && Math.abs(opp.pos.z) < NVZ + 1.5 && p.human === false) aimX = THREE.MathUtils.clamp(opp.pos.x * s / (HW - 0.4), -1, 1);
        break;
      default:
        depth = HL - 1.0 - Math.random() * 1.6;
        spec = { speed: 8.5 + 5 * pw, rpm: 500, clear: 0.3 };
    }
    if (plan.volley && type === 'reset') { depth = 3.8 + Math.random() * 2; spec = { speed: 8 + 6 * pw, rpm: -300, clear: 0.12 }; }
    // the computer's errors: long, wide or into the net, more under pressure
    let forced: 'long' | 'wide' | 'net' | null = null;
    if (!p.human) {
      const L = AI_LEVELS[this.cfg.level];
      const incoming = Math.hypot(this.ball.v.x, this.ball.v.y, this.ball.v.z);
      const pressure = Math.max(0, plan.late + 0.15) * 0.4 + Math.min(0.08, incoming / 300) + (type === 'drive' ? 0.02 : 0) + (contact.y < 0.3 ? 0.03 : 0);
      if (Math.random() < L.errors + pressure) forced = type === 'dink' || type === 'drop' ? (Math.random() < 0.7 ? 'net' : 'wide') : (['long', 'wide', 'net'] as const)[Math.floor(Math.random() * 3)];
    }
    let tx = aimX * (HW - 0.45);
    if (forced === 'long') depth = HL + 0.3 + Math.random() * 1.2;
    if (forced === 'wide') tx = Math.sign(tx || Math.random() - 0.5) * (HW + 0.2 + Math.random() * 0.8);
    if (forced === 'net') { spec.clear = -0.2; spec.commit = true; }
    const sigma = (0.12 + (1 - quality) * 1.1 + pw * pw * 0.3) * (1.35 - p.skill.accuracy) * (p.human ? 0.55 : 1);
    const target = { x: tx * s + gauss() * sigma, z: -s * (depth + gauss() * sigma * 0.8) };
    if (forced === 'wide') spec.commit = true;
    if (forced === 'long') spec.commit = true;
    const sol = solveShot({ x: contact.x, y: contact.y, z: contact.z }, target, spec);
    this.say(`hit ${this.names[p.index]} ${type} q=${quality.toFixed(2)} p=${power.toFixed(2)} ${(sol.speed * 3.6).toFixed(0)}kmh from(${contact.x.toFixed(1)},${contact.y.toFixed(2)},${contact.z.toFixed(1)}) to(${target.x.toFixed(1)},${target.z.toFixed(1)}) ok=${sol.ok}${plan.volley ? ' volley' : ''}${forced ? ' forced=' + forced : ''}`);
    p.shot = null;
    this.launch(p, { x: contact.x, y: contact.y, z: contact.z }, sol.v, sol.w, type, power, quality);
  }

  // ------------------------------------------------------------------------------------ ball events
  private onBallEvent(e: BallEvent) {
    if (e.kind === 'net') {
      this.say(`net cord=${e.cord} over=${e.over}`);
      this.world.net.shake(e.x, e.y, e.speed);
      this.audio.net(e.speed);
      if (e.cord) this.audio.ooh(0.6);
      if (!e.over && !this.pendingPoint && this.lastHitter !== null && this.state === 'rally') {
        this.dead = true;
        this.pendingPoint = { winner: (1 - this.lastHitter) as 0 | 1, reason: this.strikes === 1 ? 'fault' : 'net', at: this.clock + 0.9 };
        this.hud.call(this.strikes === 1 ? 'Fault' : 'Net', '', 1.3);
      }
      return;
    }
    if (e.kind !== 'bounce') return;
    this.say(`bounce (${e.x.toFixed(2)},${e.z.toFixed(2)}) v=${e.speed.toFixed(1)}`);
    this.replay?.mark('bounce', this.clock, e.x, e.z);
    this.ballView.bounce();
    this.audio.bounce(this.world.venue.surface, e.speed + e.vy, this.pan({ x: e.x, y: 0, z: e.z }), Math.hypot(e.x - this.camera.position.x, e.z - this.camera.position.z));
    if (this.pendingPoint || this.lastHitter === null || this.state !== 'rally') return;
    const hitter = this.players[this.lastHitter];
    const side: 1 | -1 = e.z > 0 ? 1 : -1;
    const tol = 0.01;
    if (this.bouncesAfterHit === 0) {
      this.bouncesAfterHit = 1;
      this.bounceSide = side;
      if (side === hitter.side) {
        this.pendingPoint = { winner: (1 - hitter.index) as 0 | 1, reason: 'net', at: this.clock + 0.5 };
        this.dead = true;
        return;
      }
      if (this.strikes === 1) {
        // the serve: the diagonal court, past the kitchen line (the line is the kitchen's), up to the baseline
        const right = this.match.fromRight ? 1 : -1;
        const boxSign = -hitter.side * right;
        const az = Math.abs(e.z);
        const good = az > NVZ + tol * 0 && az <= HL + tol && e.x * boxSign >= -tol && Math.abs(e.x) <= HW + tol;
        if (!good) {
          this.dead = true;
          const why = az <= NVZ ? 'In the kitchen' : az > HL ? 'Long' : 'Wide';
          this.hud.call('Fault', why, 1.6);
          this.pendingPoint = { winner: (1 - hitter.index) as 0 | 1, reason: 'fault', at: this.clock + 0.8 };
        }
        return;
      }
      const inside = Math.abs(e.x) <= HW + tol && Math.abs(e.z) <= HL + tol;
      if (!inside) {
        this.dead = true;
        this.hud.call('Out', '', 1.4);
        this.audio.say('Out');
        this.pendingPoint = { winner: (1 - hitter.index) as 0 | 1, reason: 'out', at: this.clock + 0.7 };
        const recv = this.players[1 - hitter.index];
        if (recv.human) recv.rig.cancelStroke();
      }
      return;
    }
    this.bouncesAfterHit++;
    if (this.bouncesAfterHit === 2) {
      this.dead = true;
      this.pendingPoint = { winner: hitter.index, reason: this.strikes === 1 ? 'ace' : 'winner', at: this.clock + 0.35 };
    }
  }

  private onBallDead() {
    if (this.pendingPoint || this.lastHitter === null || this.state !== 'rally') return;
    const hitter = this.players[this.lastHitter];
    this.dead = true;
    if (this.bouncesAfterHit === 0) this.pendingPoint = { winner: (1 - hitter.index) as 0 | 1, reason: this.strikes === 1 ? 'fault' : 'out', at: this.clock + 0.2 };
    else this.pendingPoint = { winner: hitter.index, reason: this.strikes === 1 ? 'ace' : 'winner', at: this.clock + 0.2 };
  }

  // ------------------------------------------------------------------------------------ point over
  private lastResult: ReturnType<Match['rallyTo']> | null = null;

  private awardPoint(w: 0 | 1, reason: PointReason) {
    const rally = this.strikes;
    const m = this.match;
    const wasServer = m.server;
    const res = m.rallyTo(w, reason, rally);
    this.lastResult = res;
    this.say(`RALLY ${this.names[w]} (${reason}) strikes=${rally} → ${m.call()} games ${m.games.join('-')}`);
    this.highlight = (reason === 'winner' && rally >= 4) || rally >= 10 || reason === 'ace';
    this.setState('pointOver');
    this.hud.rally(0);
    const wName = this.names[w];
    if (res.match) {
      this.hud.call('Game, match', wName, 5);
    } else if (res.game) {
      this.hud.call('Game', wName, 3);
    } else if (res.sideOut && !m.cfg.rally) {
      this.hud.call('Side out', `${this.names[m.server]} to serve`, 2);
    } else {
      const title = reason === 'ace' ? 'Ace' : reason === 'winner' && rally >= 3 ? 'Winner' : reason === 'fault' ? 'Fault' : '';
      this.hud.call(title || 'Point', `${wName} · ${m.cfg.rally ? `${m.score[0]}-${m.score[1]}` : m.call()}`, 2);
    }
    this.boards();
    const intensity = Math.min(1, 0.3 + rally * 0.05 + (res.game ? 0.3 : 0) + (reason === 'winner' ? 0.15 : 0));
    this.audio.applause(intensity, 2 + intensity * 2.5);
    this.crowd?.react(res.match || res.game ? 2 : 1, 0.4 + intensity * 0.5);
    setTimeout(() => this.crowd?.react(0), (2.5 + intensity * 2) * 1000);
    this.audio.crowdLevel(0.9, 0.5);
    const W = this.players[w], L = this.players[1 - w];
    if (rally >= 5 || res.game) W.rig.react('cheer3', 1.8);
    if (Math.random() < 0.5) L.rig.react(Math.random() < 0.5 ? 'shrug' : 'dust', 1.8);
    for (const p of this.players) if (p.human) this.onPadEvent?.(p.index, 'point', { won: p.index === w, call: m.cfg.rally ? `${m.score[p.index]}-${m.score[1 - p.index]}` : m.call() });
    void wasServer;
    if (res.match) this.onMatchOver?.(m);
  }

  private pointOver(dt: number) {
    this.idlePlayers(dt);
    if (this.highlight && this.stateT > 1.2 && this.startReplay()) return;
    const wait = this.lastResult?.game ? 3.4 : 2.3;
    if (this.stateT < wait) return;
    if (this.match.winner !== null) {
      this.setState('matchOver');
      return;
    }
    this.setupPoint();
  }

  // ------------------------------------------------------------------------------------ replays
  private startReplay(): boolean {
    this.highlight = false;
    if (this.clock - this.lastReplay < 40) return false;
    const back = Math.min(this.replay.duration - 0.2, 3.6, Math.max(2.6, this.clock - this.lastHitT + 1.8));
    if (!this.replay.start(back, 0.2, 0.55)) return false;
    this.lastReplay = this.clock;
    this.state = 'replay';
    this.stateT = 0;
    this.dir.subject.copy(this.players[this.lastHitter ?? 0].pos);
    this.dir.cut(Math.random() < 0.5 ? 'replaySide' : 'replayBaseline');
    this.hud.call('Replay', '', 1.4);
    this.hud.replayTag(true);
    this.audio.crowdLevel(0.6);
    return true;
  }

  private replayPhase = 0;
  private lastReplay = -99;
  private replayTick(dt: number) {
    const b = this.ballView.mesh.position;
    const playing = this.replay.step(dt);
    this.dir.update(dt, b, this.dir.subject, this.players[1].pos);
    this.onDof?.(true, this.camera.position.distanceTo(b), 3);
    this.world.ballPos.copy(b);
    // any swing skips it
    for (const p of this.players) if (p.human && this.input.take(p.index)) this.replay.stop();
    if (!playing) {
      this.replayPhase += dt;
      if (this.replayPhase > 0.4 || this.stateT > 12) this.endReplay();
    } else this.replayPhase = 0;
  }

  private endReplay() {
    this.onDof?.(false);
    this.hud.replayTag(false);
    this.state = 'pointOver';
    this.stateT = 1.4;
    this.dir.cut('broadcast');
  }

  private idlePlayers(dt: number) {
    for (const p of this.players) p.drive(dt, new THREE.Vector3());
  }

  private footSounds(p: Player, dt: number) {
    const i = p.index;
    const dv = p.vel.clone().sub(this.prevVel[i]);
    this.prevVel[i].copy(p.vel);
    void dt;
    if (dv.length() > 0.17 && p.vel.length() > 1.1 && this.clock - this.lastSqueak[i] > 0.45 && Math.random() < 0.35) {
      this.lastSqueak[i] = this.clock;
      this.audio.squeak(this.pan(p.pos), p.pos.distanceTo(this.camera.position) < 12 ? 1 : 0.5);
    }
  }

  private pan(p: { x: number; z: number; y?: number }): number {
    const v = new THREE.Vector3(p.x, p.y ?? 0.5, p.z).project(this.camera);
    return THREE.MathUtils.clamp(v.x * 0.7, -0.9, 0.9);
  }

  skipIntro() {
    this.begin();
  }
}

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
