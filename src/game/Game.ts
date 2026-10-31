import * as THREE from 'three';
import { BallSim, predict, WIND, type BallEvent, v3 } from '../sim/Ball.ts';
import { solveShot, flyToGround, type ShotSpec } from '../sim/Shot.ts';
import { impact, faceFor, rotate, norm, len } from '../sim/Paddle.ts';
import { HL, HW, NVZ, BALL_R, FLOOR_HX } from '../sim/dims.ts';
import { FENCE } from '../world/Club.ts';
import { Match, type PointReason } from './Match.ts';
import { Player, REACH, type Plan } from './Player.ts';
import { PlayerRig, type StrokeKind } from './PlayerRig.ts';
import { Human, type Outfit } from '../people/Human.ts';
import { BallView } from './BallView.ts';
import type { Input, ShotType, Swing } from './Input.ts';
import { aiChooseShot, aiServe, AI_LEVELS, type Difficulty, type ShotChoice } from './AI.ts';
import { CameraDirector } from './CameraDirector.ts';
import { Replay } from './Replay.ts';
import { PADDLE_ART, RACKET } from './Racket.ts';
import { Puppet, SUN_RAY, type BodyLook } from '../people/Puppet.ts';
import { GFX } from '../render/gfx.ts';
import type { World } from '../world/World.ts';
import type { Crowd } from '../people/Crowd.ts';
import type { HUD } from '../ui/HUD.ts';
import type { Audio } from '../audio/Audio.ts';

export interface RosterEntry {
  /** the Rocketbox rig that animates the body (hidden) */
  avatar: string;
  name: string;
  outfit: Outfit;
  /** the realistic body worn over it */
  look: BodyLook;
}

const ATHLETE = import.meta.env.BASE_URL + 'people/athlete_m1.glb';
/** the club's regulars (fictional): one scanned athlete in each player's shirt colour */
export const ROSTER: RosterEntry[] = [
  { avatar: 'Sports_Male_04', name: 'Dex', outfit: {}, look: { url: ATHLETE, shirtHue: null, height: 1.0, hat: 'capBack', hatColor: '#1b1d22' } },
  { avatar: 'Sports_Male_04', name: 'Marcus', outfit: {}, look: { url: ATHLETE, shirtHue: 0.49, shirtSat: 0.85, shorts: '#1a1a1c', skin: [0.4, 0.3, 0.24], height: 1.06, hat: 'band', hatColor: '#f4f4f0' } },
  { avatar: 'Sports_Male_04', name: 'Gus', outfit: {}, look: { url: ATHLETE, shirtHue: 0.0, shirtSat: 0.05, shorts: '#b9a888', skin: [1.12, 1.06, 1.02], height: 0.96, hat: 'visor', hatColor: '#2a6fdb', glasses: true } },
  { avatar: 'Sports_Male_04', name: 'Theo', outfit: {}, look: { url: ATHLETE, shirtHue: 0.6, shirtSat: 0.9, shorts: '#e9e7e0', skin: [0.7, 0.57, 0.47], height: 1.02, hat: 'cap', hatColor: '#f2f0ea', glasses: true } },
  { avatar: 'Sports_Male_04', name: 'Rafa', outfit: {}, look: { url: ATHLETE, shirtHue: 0.93, shirtSat: 0.75, shorts: '#3b3f46', skin: [0.9, 0.82, 0.7], height: 0.98, hat: null } },
];

type State = 'idle' | 'preServe' | 'serving' | 'rally' | 'pointOver' | 'replay' | 'matchOver';

export interface GameConfig {
  level: Difficulty;
  /** 1: you vs the computer; 2: two phones head to head */
  players: 1 | 2;
  to: number;
  games: 1 | 3;
  rally: boolean;
  /** who moves a human player: the computer runs them to the ball, or they move themselves (the phone's position) */
  move?: 'auto' | 'body';
  /** roster indices for the near and far player */
  near: number;
  far: number;
  demo?: boolean;
  /** how breezy (1 = a typical outdoor day, 0 = still air) */
  wind?: number;
  /** what's on court: just the paddles (each at its phone's angle), or the players holding them */
  view?: 'paddles' | 'people';
}

const SHOT_NAME: Record<ShotType, string> = { dink: 'dink', drop: 'drop shot', reset: 'groundstroke', drive: 'drive', lob: 'lob', smash: 'overhead', serve: 'serve' };

/** timing window for a human swing relative to the ideal contact (s) */
// the hit window around the ball reaching the paddle (after this player's learned delay): Wii
// Sports-wide — a swing in it hits; when in it decides where the ball goes, not whether it goes
const EARLY = 0.42, LATE = 0.26;
const _fp = new THREE.Vector3(), _fs = new THREE.Vector3(), _fs2 = new THREE.Vector3(), _fv = new THREE.Vector3(), _fone = new THREE.Vector3(1.25, 1.25, 1.25), _fq = new THREE.Quaternion(), _fq2 = new THREE.Quaternion();

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
  /** a human's swing landed for the ball coming: when it strikes (game clock), how far off it was, the swing, and when (real time) it was taken */
  private committed: [{ at: number; err: number; swing: Swing; realAt?: number } | null, { at: number; err: number; swing: Swing; realAt?: number } | null] = [null, null];
  /** holding the ball at a paddle (all but frozen) for a swing's full reading, until this real time */
  private holdFull: { idx: number; until: number } | null = null;
  private prevVel = [new THREE.Vector3(), new THREE.Vector3()];
  /** this player already missed the ball in flight (no more plans until the next strike) */
  private missed = [false, false];
  private lastSqueak = [0, 0];
  /** consecutive perfectly timed hits per player; three in a row and the paddle is hot */
  private perfects = [0, 0];
  private hot = [false, false];
  private prevBall = new THREE.Vector3();
  /** soft contact shadows under the players (where the sun's shadow map is too coarse to ground the feet) */
  private contact: THREE.Mesh[] = [];
  /** the TV: each body's shadow as one soft quad stretched along the sunlight */
  private sunShadow: THREE.Mesh[] = [];
  /** "you move" mode: each phone's position in the room (m, right / toward the TV) and when it came */
  private bodyPos: ({ x: number; z: number; vx: number; vz: number; t: number } | null)[] = [null, null];
  /** the room position that maps to where the player stood when the point started */
  private bodyAnchor: ({ px: number; pz: number; cx: number; cz: number } | null)[] = [null, null];
  private hitStop = 0;
  /** real seconds (frame dt before any slow motion): swings are judged on it */
  realClock = 0;
  /**
   * The ball got to a human's paddle before their swing did (the TV shows the game a little late,
   * the phone needs a moment to see a swing, the network a little more): the game all but stops and
   * waits for it, and the ball is struck right there. Lasts the player's usual delay and a bit.
   */
  waitHit: { idx: number; until: number } | null = null;
  /** each human's usual delay from the ball reaching their paddle (as the game runs it) to their swing landing here, learned as they play */
  lag = [0.1, 0.1];
  private lastSwingId: (number | null)[] = [null, null];
  /** each player's usual face tilt at contact (forehand, backhand), from the phone */
  private faceBase = [[NaN, NaN], [NaN, NaN]];
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

  /** this match's breeze: mean speed (m/s) and the direction it blows toward (rad, from +x toward +z) */
  wind = { speed: 0, dir: 0 };
  private windT = 0;
  private windShown = -1;

  async setup(cfg: GameConfig, names: [string, string], paddles: [number, number]) {
    this.cfg = cfg;
    // outdoors there's nearly always some air: calm to breezy by day, stiller at night
    const k = cfg.wind ?? 1;
    this.wind = { speed: k * (this.world.sky.preset.night ? 0.2 + Math.random() * 0.8 : 0.4 + Math.random() * 2.4), dir: Math.random() * Math.PI * 2 };
    this.windT = Math.random() * 100;
    if (this.players) for (const p of this.players) {
      this.world.scene.remove(p.rig.group);
      if (p.puppet) this.world.scene.remove(p.puppet.root, p.puppet.paddle);
    }
    const make = async (r: RosterEntry, i: 0 | 1, human: boolean, paddle: number) => {
      const h = await Human.create(r.avatar, r.outfit);
      const rig = new PlayerRig(h, PADDLE_ART[paddle % PADDLE_ART.length]);
      this.world.scene.add(h.root);
      this.world.dynamic.push(h.root);
      rig.onStep = (x, z) => this.audio.step(0.5 + Math.min(1, this.players?.[i]?.vel.length() ?? 0) * 0.5, this.pan({ x, z, y: 0 }), Math.hypot(x - this.camera.position.x, z - this.camera.position.z));
      const puppet = await Puppet.create(h, rig.racket, r.look);
      this.world.scene.add(puppet.root, puppet.paddle);
      this.world.dynamic.push(puppet.root, puppet.paddle);
      const pl = new Player(i, r.name, rig, human, human ? { speed: 4.7, accel: 16, power: 0.95, accuracy: 0.9, spin: 0.85, reaction: 0.12 } : AI_LEVELS[cfg.level].skill);
      pl.puppet = puppet;
      return pl;
    };
    const a = ROSTER[cfg.near], b = ROSTER[cfg.far];
    this.players = [await make(a, 0, !cfg.demo, paddles[0]), await make(b, 1, cfg.players === 2 && !cfg.demo, paddles[1])];
    this.players[0].side = 1;
    this.players[1].side = -1;
    if (!this.contact.length) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
      gr.addColorStop(0, 'rgba(0,0,0,0.75)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0.35)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, opacity: 0.55, toneMapped: false });
      for (let i = 0; i < 2; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
        m.renderOrder = 2;
        this.world.scene.add(m);
        this.contact.push(m);
      }
      if (GFX.lite && !GFX.planar) {
        const sm = mat.clone();
        sm.opacity = 0.62;
        for (let i = 0; i < 2; i++) {
          const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), sm);
          m.renderOrder = 2;
          this.world.scene.add(m);
          this.sunShadow.push(m);
        }
      }
    }
    this.names = names;
    // paddles only: no bodies, no body shadows; a small shadow under each paddle instead
    for (const p of this.players) if (p.puppet) p.puppet.root.visible = !this.paddlesOnly;
    for (const m of this.sunShadow) m.visible = !this.paddlesOnly;
    this.dir.paddles = this.paddlesOnly;
    this.replay = new Replay(this.players, this.ballView.mesh);
    this.hud.names = this.names;
    this.match = new Match({ to: cfg.to, games: cfg.games, rally: cfg.rally }, Math.random() < 0.5 ? 0 : 1);
    this.dir.side = 1;
    this.dir.cut('intro');
  }

  /** a phone's position in the room (the app's camera tracking) */
  setBodyPos(slot: number, x: number, z: number, vx = 0, vz = 0) {
    this.bodyPos[slot] = { x, z, vx, vz, t: performance.now() / 1000 };
  }

  /**
   * The breeze gusts and veers slowly (tens of seconds), so a ball in flight meets the air it was
   * hit into; the palms and the scorebug show it
   */
  private blow(dt: number) {
    this.windT += dt;
    const t = this.windT, w = this.wind;
    const g = Math.max(0, 1 + 0.32 * Math.sin(t * 0.23) + 0.16 * Math.sin(t * 0.71 + 1.3));
    const d = w.dir + 0.3 * Math.sin(t * 0.11 + 0.7);
    WIND.x = w.speed * g * Math.cos(d);
    WIND.z = w.speed * g * Math.sin(d);
    this.world.club.setWind(WIND.x, WIND.z);
    const mph = Math.round(Math.hypot(WIND.x, WIND.z) * 2.237);
    if (mph !== this.windShown) {
      this.windShown = mph;
      this.hud.wind(mph, Math.atan2(WIND.x, -WIND.z));
    }
  }

  /** a phone's angle (handle → head, screen normal; room frame = the player's right, up, forward) */
  setPaddleAngle(slot: number, shaft: number[], face: number[], pos: number[] | null = null) {
    this.players?.[slot]?.rig.setLive(shaft, face);
    if (pos) this.padRoom[slot] = { x: pos[0], y: pos[1], z: pos[2], t: performance.now() / 1000 };
  }
  /** each phone's position in the room as its camera tracking sees it, unheld through swings (room frame) */
  private padRoom: ({ x: number; y: number; z: number; t: number } | null)[] = [null, null];
  /** the phone's height when the room was last mapped onto the court (it then holds the paddle at ~0.9 m) */
  private padY0: (number | null)[] = [null, null];
  /** the paddle's flight (its sweet spot) a beat ago, for the pull onto the ball at contact */
  private padSnap: ({ x: number; y: number; z: number; t: number } | null)[] = [null, null];

  /**
   * Where your paddle is, in the court: the room mapped onto the court as your body is (2.5 m of
   * court a metre of room), then the paddle's own movement around you — a swing, a reach — about
   * life size on top. Null without fresh tracking.
   */
  private trackedPaddle(p: Player, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.padRoom[p.index], a = this.bodyAnchor[p.index], b = this.bodyPos[p.index];
    if (!r || !a || !b || performance.now() / 1000 - r.t > 0.3) return null;
    const G = 2.5, s = p.side;
    // the body's mapping (held through swings) and the hand's motion away from it
    const bx = a.cx + s * (b.x - a.px) * G, bz = a.cz - s * (b.z - a.pz) * G;
    const hx = s * (r.x - b.x) * 1.15, hz = -s * (r.z - b.z) * 1.15;
    const y0 = this.padY0[p.index] ?? (this.padY0[p.index] = r.y);
    out.set(bx + hx, THREE.MathUtils.clamp(0.9 + (r.y - y0) * 1.15, 0.1, 2.7), bz + hz);
    return out;
  }

  /** this player moves by walking around the room */
  bodyMode(p: Player): boolean {
    const b = this.bodyPos[p.index];
    return p.human && this.cfg.move === 'body' && !!b && performance.now() / 1000 - b.t < 0.8;
  }

  /** between points the player is put in place: the room position now maps to that spot */
  private anchorBody(p: Player) {
    const b = this.bodyPos[p.index];
    if (!b) return;
    // paddles only: the phone you hold is the paddle, so its spot maps onto where this player's
    // paddle meets a ball (their forehand contact point), not onto their feet
    const off = this.paddlesOnly ? p.right.clone().multiplyScalar(REACH.fhLat).addScaledVector(p.fwd, REACH.ahead) : null;
    this.bodyAnchor[p.index] = { px: b.x, pz: b.z, cx: p.pos.x + (off?.x ?? 0), cz: p.pos.z + (off?.z ?? 0) };
    const r = this.padRoom[p.index];
    if (r) this.padY0[p.index] = r.y;
  }

  /** where the room position puts the player on court (a step in the room is ~2.3 on court) */
  private bodyTarget(p: Player): THREE.Vector3 | null {
    const b = this.bodyPos[p.index], a = this.bodyAnchor[p.index];
    if (!b || !a) return null;
    const G = 2.5;
    // where you are now: the last report led by your walking speed over its age (the link + filter delay)
    const lead = Math.min(0.15, performance.now() / 1000 - b.t + 0.05);
    const bx = b.x + b.vx * lead, bz = b.z + b.vz * lead;
    // facing the TV is facing the net: right is the player's right, forward is toward the net
    const t = new THREE.Vector3(a.cx + p.side * (bx - a.px) * G, 0, a.cz - p.side * (bz - a.pz) * G);
    if (this.paddlesOnly) t.addScaledVector(p.right, -REACH.fhLat).addScaledVector(p.fwd, -REACH.ahead);
    t.x = THREE.MathUtils.clamp(t.x, -FLOOR_HX + 0.4, FLOOR_HX - 0.4);
    return t;
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
  /** where everyone stands for the next serve: the server behind the baseline in the right (even) or left (odd) half, the receiver diagonally */
  private servePositions(): THREE.Vector3[] {
    const m = this.match;
    const right = m.fromRight ? 1 : -1;
    return this.players.map((p) => p.index === m.server
      ? new THREE.Vector3(p.side * right * 0.85, 0, p.side * (HL + 0.25))
      : new THREE.Vector3(p.side * right * 0.95, 0, p.side * (HL + 0.15)));
  }

  private setupPoint() {
    const m = this.match;
    const srv = m.server;
    this.serverIdx = srv;
    const S = this.players[srv], R = this.players[1 - srv];
    const spots = this.servePositions();
    for (const p of this.players) {
      p.rig.walking = false;
      p.place(spots[p.index].x, spots[p.index].z);
      // the walk back and the towel: some of the legs come back between points
      p.stamina = Math.min(1, p.stamina + 0.1);
    }
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
    this.realClock += dt;
    if (this.waitHit) {
      // waiting: all but stopped; once the swing is in, slow enough to see the paddle snap through
      const w = this.waitHit, P = this.players[w.idx];
      if (this.state !== 'rally' || !P.plan || (!this.committed[w.idx] && this.realClock > w.until)) this.waitHit = null;
      else dt *= this.committed[w.idx] ? 0.3 : 0.06;
    }
    if (this.holdFull) {
      const h = this.holdFull, c = this.committed[h.idx];
      if (this.state !== 'rally' || !c || !c.swing.pre || this.realClock > h.until) this.holdFull = null;
      else dt *= 0.08;
    }
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt *= 0.25;
    }
    this.clock += dt;
    this.stateT += dt;
    this.blow(dt);
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
    if (this.state !== 'rally') for (const p of this.players) if (this.bodyMode(p)) this.anchorBody(p);
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
      this.bodyCheck();
    }
    this.prevBall.set(this.ball.p.x, this.ball.p.y, this.ball.p.z);
    const look = new THREE.Vector3(this.ball.p.x, this.ball.p.y, this.ball.p.z);
    for (const p of this.players) {
      p.syncRig(dt, look);
      if (this.paddlesOnly) this.flyPaddle(p);
      else p.puppet?.update();
      this.footSounds(p, dt);
    }
    this.groundPlayers();
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
      // where the paddle face points aims the serve (wide or down the middle)
      if (sw && this.stateT > 0.5) this.startServe({ type: 'serve', aimX: THREE.MathUtils.clamp(sw.aim ?? 0, -1.2, 1.2), power: sw.power }, sw);
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
    // aim (the server's frame: + = their right) → how wide in the box (its outer sideline is boxSign)
    const toward = S.human ? sv.choice.aimX * S.side * boxSign : sv.choice.aimX;
    const wide = THREE.MathUtils.clamp(0.5 + toward * 0.42 + (Math.random() - 0.5) * (S.human ? 0.15 : 0.3), 0.08, 0.95);
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
    const inSpeed = Math.hypot(this.ball.v.x, this.ball.v.y, this.ball.v.z);
    this.ball.set(contact, v, w);
    this.ball.bounces = 0;
    this.lastHitter = p.index;
    this.bouncesAfterHit = 0;
    this.strikes++;
    this.lastHitT = this.clock;
    this.lastShot = type;
    const hot = p.human && this.hot[p.index];
    this.ballView.hot = hot;
    this.replay.mark('hit', this.clock, contact.x, contact.z);
    const speed = Math.hypot(v.x, v.y, v.z);
    // the paddle takes the hit: the ball leaves from its face, the face gives in the hand
    if (this.paddlesOnly) this.padSnap[p.index] = { x: contact.x, y: contact.y, z: contact.z, t: this.clock };
    else this.ballView.fromPaddle(p.rig.sweetSpot(), contact);
    p.rig.impact(Math.min(1, (speed + inSpeed * 0.5) / 22));
    this.ballView.flash(contact, Math.min(1, speed / 22));
    this.audio.pop(Math.min(1, speed / 20), type === 'dink' || type === 'drop' ? 'soft' : speed > 15 ? 'hard' : 'mid', this.pan(contact), p.pos.distanceTo(this.camera.position), quality);
    if (speed > 17) { this.dir.bump(0.25); this.hitStop = 0.05; }
    if (p.human) this.onPadEvent?.(p.index, 'hit', { power, quality, shot: type, label: `${hot ? 'On fire · ' : ''}${p.shot?.label ? p.shot.label + ' ' : ''}${SHOT_NAME[type]}` });
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
    // the ball is at the paddle and the game is waiting on the swing: that's the contact
    if (p.plan?.waited && !force) return;
    const b = this.ball;
    const pr = predict(b.p, b.v, b.w, b.surface, 4, 1 / 120, 3);
    const events = pr.events.slice();
    if (this.bouncesAfterHit > 0 && this.bounceSide === p.side) events.unshift({ kind: 'bounce', x: b.p.x, z: b.p.z, t: -0.01, speed: 0, vy: 0 });
    // the two-bounce rule: the serve and the return must bounce
    const plan = this.bodyMode(p) ? p.planReach(pr.pts, events, this.clock, this.strikes >= 3) : p.planIntercept(pr.pts, events, this.clock, this.strikes >= 3);
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
    if (this.bodyMode(p)) {
      // the player is wherever you are (with a real body's acceleration and top speed)
      const t = this.bodyTarget(p);
      p.drive(dt, t ? p.seek(t, 1) : new THREE.Vector3());
      return;
    }
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

  private ballVec(): THREE.Vector3 {
    return new THREE.Vector3(this.ball.p.x, this.ball.p.y, this.ball.p.z);
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
    // the full reading of a swing whose first word (its start) already arrived: power, path, face
    // and side replace the first guess; the timing stays the start's
    if (sw.pre === false && sw.id != null && sw.id === this.lastSwingId[p.index]) {
      const c0 = this.committed[p.index];
      if (c0 && c0.swing.id === sw.id) {
        c0.swing = { ...sw, at: c0.swing.at };
        if (plan && p.shot && this.clock <= c0.at) {
          const type = this.humanShot(p, plan, c0.swing);
          const sp = this.humanSpin(plan, c0.swing, type);
          p.shot.type = type; p.shot.power = sw.power; p.shot.rpm = sp.rpm; p.shot.label = sp.label;
        }
      }
      return;
    }
    if (sw.id != null) this.lastSwingId[p.index] = sw.id;
    // the swing's moment in real time (it peaked a moment ago on the phone), against the moment the
    // ball reached the paddle — less this player's usual delay, so "on time" is on time for them
    const atReal = this.realClock - Math.max(0, performance.now() / 1000 - sw.at);
    const contactReal = plan ? plan.realContact ?? this.realClock + (plan.tContact - this.clock) / (this.waitHit ? 0.06 : 1) : 0;
    const raw = atReal - contactReal;
    const c = this.committed[p.index];
    if (c && plan && this.clock < c.at) {
      // a second, harder swing before contact: that was the backswing; this is the real one
      if (sw.power > c.swing.power * 0.8 || sw.power > 0.3) {
        const err = raw - this.lag[p.index];
        if (err >= -EARLY && err <= LATE) {
          c.err = err;
          c.swing = sw;
          const type = this.humanShot(p, plan, sw);
          const sp = this.humanSpin(plan, sw, type);
          if (p.shot) { p.shot.type = type; p.shot.power = sw.power; p.shot.rpm = sp.rpm; p.shot.label = sp.label; }
        }
      }
      return;
    }
    if (!receiving || !plan || this.dead || c) {
      // a swing at nothing: an air swing (feedback that the phone is live)
      if (!p.rig.inStroke) {
        const bh = (sw.hand ?? 1) < 0;
        p.rig.swing(sw.power < 0.3 ? (bh ? 'bhDink' : 'fhDink') : bh ? 'bh' : 'fh', 0.18, p.pos.clone().addScaledVector(p.right, bh ? -0.45 : 0.6).addScaledVector(p.fwd, 0.4).setY(0.85), p.fwd, 0.12, sw.power);
      }
      return;
    }
    // the phone says which side it swung on: on a ball near the middle (at the body) either side
    // reaches, so the player takes it the way you swung
    if (sw.hand != null && !plan.smash && (sw.hand > 0) !== plan.forehand) {
      const lat = (plan.ball.x - p.pos.x) * p.right.x + (plan.ball.z - p.pos.z) * p.right.z;
      if (Math.abs(lat) < 0.3) plan.forehand = sw.hand > 0;
    }
    const err = raw - this.lag[p.index];
    if (err < -EARLY) {
      this.say(`too early ${err.toFixed(2)}`);
      this.hud.timing('Too early', p.index);
      return;
    }
    if (err > LATE) return;
    // learn this player's delay from the swings that connect
    this.lag[p.index] = THREE.MathUtils.clamp(this.lag[p.index] * 0.8 + raw * 0.2, -0.05, 0.3);
    const type = this.humanShot(p, plan, sw);
    const sp = this.humanSpin(plan, sw, type);
    p.shot = { type, aimX: 0, aimD: 0, power: sw.power, pressT: sw.at, released: true, rpm: sp.rpm, label: sp.label };
    // the ball is already at the paddle (the game waited): snap the stroke through it now
    const waiting = !!plan.realContact;
    // (a beat for the full reading of the swing to arrive when the game was waiting on it)
    const strikeAt = waiting ? this.clock + 0.04 : Math.max(this.clock + 0.05, plan.tContact);
    this.committed[p.index] = { at: strikeAt, err, swing: sw, realAt: this.realClock };
    plan.swung = true;
    // the stroke the phone made: a chop down is a slice, a brush up a topspin stroke
    let kind = this.strokeFor(p, plan, type);
    if (type === 'reset' && !plan.volley && sw.lift > -0.15) kind = plan.forehand ? 'fh' : 'bh';
    if (type === 'drive' && !plan.volley && sw.lift < -0.4) kind = plan.forehand ? 'fhSlice' : 'bhSlice';
    p.rig.swing(kind, strikeAt - this.clock, waiting ? this.ballVec() : plan.ball, p.fwd, 0.02, sw.power);
  }

  /**
   * What a phone swing means here. Power picks the pace (soft → dink / drop, hard → drive), the
   * swing path picks the spin (brushing up = topspin, chopping down = backspin), and the face
   * (tilted to the sky = open) turns an upward swing into a lob. On a backhand the back of the
   * phone is the hitting face, so its tilt reads the other way.
   */
  private humanShot(p: Player, plan: Plan, sw: Swing): ShotType {
    const atKitchen = Math.abs(plan.body.z) < NVZ + 1.1;
    const open = sw.face == null ? null : plan.forehand ? sw.face : -sw.face;
    if (plan.smash && sw.power > 0.4) return 'smash';
    const lobby = open === null ? sw.lift > 0.55 : sw.lift > 0.4 && open > 0.3;
    if (lobby && sw.power > 0.22) return 'lob';
    if (sw.power < 0.3) return atKitchen ? 'dink' : 'drop';
    if (sw.power < 0.66) return plan.volley && atKitchen && plan.ball.y > 1.0 ? 'drive' : 'reset';
    return 'drive';
  }

  /** spin (rpm, + topspin) from the swing path and face, and its name */
  private humanSpin(plan: Plan, sw: Swing, type: ShotType): { rpm: number; label: string } {
    const open = sw.face == null ? 0 : plan.forehand ? sw.face : -sw.face;
    let rpm: number;
    if (type === 'smash') rpm = 300;
    else if (type === 'lob') rpm = 600 + Math.max(0, sw.lift) * 900;
    else if (sw.lift >= 0) rpm = sw.lift * (type === 'dink' || type === 'drop' ? 1200 : 2600) * (1 - Math.max(0, open) * 0.5);
    else rpm = sw.lift * (type === 'dink' || type === 'drop' ? 1400 : 2200) * (1 + Math.max(0, open) * 0.6);
    rpm = THREE.MathUtils.clamp(rpm, -2300, 2600);
    const a = Math.abs(rpm);
    const label = a < 450 ? '' : rpm > 0 ? (a > 1600 ? 'Heavy topspin' : 'Topspin') : a > 1400 ? 'Heavy slice' : 'Slice';
    return { rpm, label };
  }

  private tryStrike(p: Player) {
    if (this.dead) {
      p.plan = null;
      return;
    }
    const plan = p.plan!;
    const c = this.committed[p.index];
    const tTo = plan.tContact - this.clock;
    // a ball out of reach: the last stride becomes a lunge
    if (plan.lunge && tTo < 0.32 && tTo > 0) p.rig.lunge(plan.ball, tTo + 0.35);
    if (!p.human) {
      const type = p.shot?.type;
      const lead = plan.volley ? 0.42 : plan.smash ? 0.6 : 0.62;
      if (!plan.swung && tTo <= lead && tTo > 0.06) {
        plan.swung = true;
        p.rig.swing(this.strokeFor(p, plan, type), tTo, plan.ball, p.fwd, 0.12, p.shot?.power ?? 0.5);
      }
      if (tTo > 0) return;
    } else {
      // the human gets ready on their own (a backswing held until they swing)
      if (!plan.swung && !c && tTo <= 0.7 && tTo > 0.05) {
        p.rig.swing(this.strokeFor(p, plan, 'reset'), 6, plan.ball, p.fwd);
        // the body turns for it; the paddle itself is wherever the phone is
        p.rig.holding = true;
        plan.swung = true;
      }
      if (!c && tTo <= 0 && !plan.waited && !this.dead) {
        // the ball is at the paddle and the swing hasn't landed yet: wait for it
        plan.waited = true;
        plan.realContact = this.realClock;
        this.waitHit = { idx: p.index, until: this.realClock + this.lag[p.index] + LATE + 0.08 };
      }
      if (!c) {
        if (plan.waited ? !this.waitHit : tTo < -LATE - 0.02) {
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
      // the swing's start timed it; its full reading (power, path, face) is a beat behind: hold
      // the ball at the paddle for it, briefly (never later than a peak-timed swing would have landed)
      if (c.swing.pre && this.realClock < (c.realAt ?? 0) + 0.16) {
        if (!this.holdFull) this.holdFull = { idx: p.index, until: (c.realAt ?? 0) + 0.16 };
        return;
      }
      this.holdFull = null;
    }
    // contact
    const b = this.ball.p;
    const ballV = new THREE.Vector3(b.x, b.y, b.z);
    const lat = plan.smash ? REACH.smashLat : plan.forehand ? REACH.fhLat : REACH.bhLat;
    const ahead = plan.smash ? REACH.smashAhead : plan.volley ? REACH.volleyAhead : REACH.ahead;
    const ideal = p.pos.clone().addScaledVector(p.right, plan.forehand ? lat : -lat).addScaledVector(p.fwd, ahead);
    const dh = Math.hypot(ideal.x - b.x, ideal.z - b.z);
    const dy = Math.abs(b.y - plan.ball.y);
    p.plan = null;
    const body = this.bodyMode(p);
    const reach = body ? 1.05 : p.human ? 1.9 : 1.1, reachY = body ? 0.8 : p.human ? 1.4 : 0.9;
    if (dh > reach || dy > reachY || b.y > 2.8 || b.y < 0.04) {
      this.missed[p.index] = true;
      this.say(`miss ${this.names[p.index]} dh=${dh.toFixed(2)} dy=${dy.toFixed(2)} y=${b.y.toFixed(2)}`);
      if (p.human) this.onPadEvent?.(p.index, 'whiff', {});
      this.committed[p.index] = null;
      return;
    }
    let quality: number;
    const inSpeed = Math.hypot(this.ball.v.x, this.ball.v.y, this.ball.v.z);
    if (p.human) {
      const err = c!.err;
      quality = THREE.MathUtils.clamp(1 - Math.max(0, Math.abs(err) - 0.09) / 0.4, 0.4, 1);
      // at full stretch (the run got there late) the contact is weaker
      if (plan.late > -0.05) quality *= 1 - Math.min(0.35, (plan.late + 0.05) * 0.9);
      // off the sweet spot: the ball came in away from where the paddle wanted it
      quality *= body ? 1 - Math.min(0.6, Math.max(0, dh - 0.3) * 0.9) : 1 - Math.min(0.3, Math.max(0, dh - 0.35) * 0.35);
      // a hard ball leaves no margin: a block of a smash has to be timed
      if (inSpeed > 16) quality *= 1 - Math.min(0.6, ((inSpeed - 16) / 10) * (Math.max(0, Math.abs(err) - 0.04) / 0.08));
      const i = p.index;
      if (Math.abs(err) < 0.07) this.perfects[i]++;
      else { this.perfects[i] = 0; this.hot[i] = false; }
      if (!this.hot[i] && this.perfects[i] >= 3) {
        this.hot[i] = true;
        this.hud.call('On fire', `${this.names[i]} · three perfect in a row`, 1.4);
        this.say(`on fire ${this.names[i]}`);
        this.audio.ooh(0.5);
      }
      this.hud.timing(Math.abs(err) < 0.07 ? 'Perfect' : err < 0 ? 'Early' : 'Late', p.index, p.shot?.label ?? '');
    } else quality = THREE.MathUtils.clamp(1 - Math.max(0, dh - 0.3) / 0.85 - dy * 0.3, 0.2, 1);
    if (plan.lunge) quality *= 0.85;
    // a volley with a foot in the kitchen is a fault (you walked in)
    if (body && plan.volley && Math.abs(p.pos.z) <= NVZ) {
      this.dead = true;
      this.committed[p.index] = null;
      this.say(`kitchen ${this.names[p.index]}`);
      this.hud.call('Kitchen', 'Volleyed with a foot in the kitchen', 1.6);
      this.pendingPoint = { winner: (1 - p.index) as 0 | 1, reason: 'kitchen', at: this.clock + 0.6 };
      return;
    }
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
      const cm = this.committed[p.index];
      const err = cm?.err ?? 0;
      const k = THREE.MathUtils.clamp(err / 0.16, -1, 1);
      const timing = (plan.forehand ? k : -k) * 0.95;
      // where the paddle face pointed (the phone's heading at contact) leads; timing adds to it
      const faceAim = cm?.swing.aim;
      // (as in Wii Sports: the timing places it — early pulls cross-court, late pushes down the line —
      // and where the phone faced nudges it)
      aimX = timing * 0.85 + (faceAim == null ? 0 : THREE.MathUtils.clamp(faceAim, -1.4, 1.4) * 0.3) + (Math.random() - 0.5) * 0.15;
    }
    const s = p.side;
    const opp = this.players[1 - p.index];
    let depth: number;
    let spec: ShotSpec;
    const hot = p.human && this.hot[p.index];
    const pw = power * p.skill.power * (0.6 + 0.4 * quality) * (hot ? 1.12 : 1);
    // what's coming in: pace the paddle has to soak up or can borrow, spin that kicks off the face
    const inSpeed = Math.hypot(this.ball.v.x, this.ball.v.y, this.ball.v.z);
    const inRpm = Math.hypot(this.ball.w.x, this.ball.w.y, this.ball.w.z) * 9.55;
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
        spec = { speed: 12.5 + 4 * pw, rpm: 900, arc: 'high', clear: 2.0, soft: true };
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
        // kept low when the other player is up at the net (a floater gets put away)
        spec = { speed: 8.5 + 5 * pw, rpm: 500, clear: Math.abs(opp.pos.z) < NVZ + 1.5 ? 0.16 : 0.3 };
    }
    if (plan.volley && type === 'reset') { depth = 3.8 + Math.random() * 2; spec = { speed: 8 + 6 * pw, rpm: -300, clear: 0.12 }; }
    if (p.human) {
      // how hard you swing sets how deep it goes within the shot (no dice): a soft dink drops just
      // over, a firmer one lands at the kitchen line; a full drive goes to the baseline
      const band = type === 'dink' || type === 'drop' ? [0, 0.3] : type === 'reset' ? [0.3, 0.66] : type === 'drive' ? [0.66, 1] : null;
      if (band) {
        const u = THREE.MathUtils.clamp((power - band[0]) / (band[1] - band[0]), 0, 1);
        depth = type === 'dink' ? 0.6 + u * 1.3 : type === 'drop' ? 0.8 + u * 1.5 : plan.volley ? 3.2 + u * 2.6 : HL - 2.7 + u * 1.7;
      }
      // the face: opened past how you usually hold it, the ball goes up and long; closed, flat and
      // short. Learned per player and per side (the phone sits differently in every hand)
      const fn = this.committed[p.index]?.swing.n;
      if (fn && type !== 'smash' && type !== 'lob') {
        const k = plan.forehand ? 0 : 1, base = this.faceBase[p.index][k];
        const d = Number.isNaN(base) ? 0 : THREE.MathUtils.clamp(fn[1] - base, -0.45, 0.45);
        this.faceBase[p.index][k] = Number.isNaN(base) ? fn[1] : base * 0.85 + fn[1] * 0.15;
        spec.clear = Math.max(0.05, (spec.clear ?? 0.2) + d * 0.9);
        depth = Math.max(0.5, depth + d * 1.0);
      }
    }
    // a soft shot off a hard ball: the paddle face gives it back with interest unless it's taken off
    const soft = type === 'dink' || type === 'drop' || type === 'reset';
    const absorb = soft ? THREE.MathUtils.clamp((inSpeed - 10) / 14, 0, 1) : 0;
    if (absorb > 0) {
      depth += absorb * (0.3 + Math.random()) * (1.25 - quality);
      spec.speed *= 1 + absorb * 0.22;
    }
    // a volleyed drive borrows the incoming pace (the counter)
    if (type === 'drive' && plan.volley) spec.speed += Math.min(4, inSpeed * 0.18);
    if (p.human && shot.rpm !== undefined && type !== 'smash') {
      spec.rpm = shot.rpm;
      // topspin pulls a hard ball down into the court: more pace with the same margin; slice floats
      if (type === 'drive' || type === 'reset') spec.speed *= 1 + Math.max(-0.12, shot.rpm / 11000);
      // a sliced ball from the back needs a little more pace to carry: the player finds it
      if (shot.rpm < -800 && type === 'reset') spec.soft = true;
    }
    // the computer's errors: long, wide or into the net, more under pressure
    let forced: 'long' | 'wide' | 'net' | 'pop' | null = null;
    if (!p.human) {
      const L = AI_LEVELS[this.cfg.level];
      const incoming = Math.hypot(this.ball.v.x, this.ball.v.y, this.ball.v.z);
      // heavy spin coming in is harder to handle
      const spinIn = Math.hypot(this.ball.w.x, this.ball.w.y, this.ball.w.z) * 9.55;
      const pressure = Math.max(0, plan.late + 0.05) * 0.4 + Math.min(0.06, incoming / 400) + (type === 'drive' ? 0.02 : 0) + (contact.y < 0.3 ? 0.03 : 0) + Math.min(0.07, Math.max(0, spinIn - 600) / 25000)
        + absorb * 0.05 + Math.max(0, incoming - 19) / 50 + (plan.lunge ? 0.04 : 0);
      if (Math.random() < L.errors + pressure) forced = type === 'dink' || type === 'drop' ? (Math.random() < 0.6 ? 'net' : 'wide') : (['long', 'wide', 'net'] as const)[Math.floor(Math.random() * 3)];
      // the classic pickleball mistake: a touch shot that floats up, attackable
      else if ((type === 'dink' || type === 'drop' || type === 'reset') && Math.random() < L.errors * 1.2 + pressure * 0.5) forced = 'pop';
    // a human's swing goes where it was aimed unless it was badly mistimed (a touch shot floats up,
    // a smash or a hard ball just gets a frame on it, a barely-met ball goes in the net)
    } else if ((type === 'dink' || type === 'drop') && quality < 0.35 && Math.random() < 0.45) forced = 'pop';
    else if (absorb > 0 && Math.random() < absorb * (1.1 - quality) * 0.45) forced = 'pop';
    else if (p.human && inSpeed > 17 && quality < 0.4 && Math.random() < 0.4) forced = 'pop';
    else if (p.human && quality < 0.22 && Math.random() < (0.22 - quality) * 1.5) forced = 'net';
    let tx = aimX * (HW - 0.45);
    if (forced === 'long') depth = HL + 0.3 + Math.random() * 1.2;
    if (forced === 'wide') tx = Math.sign(tx || Math.random() - 0.5) * (HW + 0.2 + Math.random() * 0.8);
    if (forced === 'net') { spec.clear = -0.2; spec.commit = true; }
    if (forced === 'pop') {
      // up over the net by a metre and landing short of the baseline: someone at the kitchen can put it away
      depth = 3.0 + Math.random() * 1.6;
      spec = { speed: 7.5 + Math.random() * 2, rpm: 300, clear: 0.9 + Math.random() * 0.4, soft: true };
      this.say(`pop-up ${this.names[p.index]}`);
    }
    // on the run, and against heavy spin, the face is harder to hold steady
    const sigma = (0.12 + (1 - quality) * 1.1 + pw * pw * 0.3) * (1.35 - p.skill.accuracy) * (p.human ? 0.8 : 1)
      * (1 + p.vel.length() * 0.1) * (1 + Math.max(0, inRpm - 900) / 3000) * (hot ? 0.65 : 1);
    const target = { x: tx * s + gauss() * sigma, z: -s * (depth + gauss() * sigma * 0.8) };
    // a wide or long miss still clears the net (a touch shot finds the pace for it)
    if ((forced === 'wide' || forced === 'long') && !spec.soft) spec.commit = true;
    const sol = solveShot({ x: contact.x, y: contact.y, z: contact.z }, target, spec);
    if (p.human && !forced) {
      // the ball comes off the paddle the phone swung: what the shot wanted is only the stroke's
      // intent (the face a player would present for it); the face error, the swing path and the
      // incoming ball decide the rest
      const out = this.paddleStrike(p, plan, sol.v, quality, shot.rpm ?? 0);
      sol.v = out.v;
      sol.w = out.w;
      // spin about the vertical: it curves in the air and kicks sideways off the bounce. A player
      // learns to start a curving ball outside its line: about half the bend is aimed for
      const sideRpm = Math.abs(out.w.y) * 9.55;
      if (sideRpm > 300) {
        const c0 = { x: contact.x, y: contact.y, z: contact.z };
        const bent = flyToGround(c0, sol.v, sol.w), straight = flyToGround(c0, sol.v, { ...sol.w, y: 0 });
        const dx = straight.x - c0.x, dz = straight.z - c0.z, d = Math.hypot(dx, dz) || 1;
        // turning the launch by a moves the landing a·d along (−dz, dx)/d: undo half the bend
        const a = -0.5 * ((bent.x - straight.x) * -dz + (bent.z - straight.z) * dx) / (d * d);
        const ca = Math.cos(a), sa = Math.sin(a);
        sol.v = { x: sol.v.x * ca - sol.v.z * sa, y: sol.v.y, z: sol.v.x * sa + sol.v.z * ca };
      }
      if (sideRpm > 600 && p.shot && sideRpm > Math.abs(p.shot.rpm ?? 0) * 0.8) p.shot.label = sideRpm > 1300 ? 'Heavy sidespin' : 'Sidespin';
    }
    this.say(`hit ${this.names[p.index]} ${type}${p.shot?.rpm !== undefined ? ` rpm=${Math.round(p.shot.rpm)} aim=${aimX.toFixed(2)}` : ''} q=${quality.toFixed(2)} p=${power.toFixed(2)} ${(sol.speed * 3.6).toFixed(0)}kmh from(${contact.x.toFixed(1)},${contact.y.toFixed(2)},${contact.z.toFixed(1)}) to(${target.x.toFixed(1)},${target.z.toFixed(1)}) ok=${sol.ok}${p.human && Math.abs(sol.w.y) * 9.55 > 300 ? ` side=${Math.round(sol.w.y * 9.55)}` : ''}${plan.volley ? ' volley' : ''}${forced ? ' forced=' + forced : ''}`);
    this.launch(p, { x: contact.x, y: contact.y, z: contact.z }, sol.v, sol.w, type, power, quality);
    p.shot = null;
  }

  /**
   * A human's stroke through the impact model. The face starts square to the shot the swing asked
   * for (players learn their face angles); then it's off by the timing (a mistimed contact meets
   * the face early or late in its turn) and by how the phone's face read, and the paddle travels
   * along the swing path: brushing up or chopping down across the face, which is the spin. The
   * learned part only pulls the result `assist` of the way back toward the intent.
   */
  private paddleStrike(p: Player, plan: Plan, want: { x: number; y: number; z: number }, quality: number, rpm: number): { v: { x: number; y: number; z: number }; w: { x: number; y: number; z: number } } {
    const vIn = { ...this.ball.v }, wIn = { ...this.ball.w };
    const flat = faceFor(vIn, want);
    const across = norm({ x: -want.z, y: 0, z: want.x }); // horizontal, across the flight
    const up = { x: 0, y: 1, z: 0 };
    const cm = this.committed[p.index];
    const err = cm?.err ?? 0;
    // the face: tilted (pitch) and turned (yaw) off square
    const open = cm?.swing.face == null ? 0 : (plan.forehand ? cm.swing.face : -cm.swing.face);
    const pitchErr = gauss() * (0.012 + (1 - quality) * 0.09) + THREE.MathUtils.clamp(open - 0.25, -1, 1) * 0.035;
    const yawErr = gauss() * (0.015 + (1 - quality) * 0.07) + (plan.forehand ? 1 : -1) * err * 0.25;
    let n = rotate(flat.n, across, pitchErr);
    n = rotate(n, up, yawErr);
    // off the sweet spot (a mistimed contact is also a misplaced one): the paddle twists in the
    // hand about the handle and the face gives back less
    const off = Math.min(0.08, (1 - quality) * 0.07 + Math.abs(gauss()) * 0.006);
    const twist = (Math.random() < 0.5 ? -1 : 1) * off * 2.6;
    n = rotate(n, up, twist);
    // the path: brushing up for topspin, under for slice (a lift of 1 ≈ 35° across the face);
    // players swing a little harder along a brushed path to keep the pace
    let brush = THREE.MathUtils.clamp(rpm / 2600, -0.9, 1) * 0.6;
    // the phone's own path across its face, when it measured one (room frame → this player's):
    // up or down the face is topspin or slice, sideways across it is sidespin — the curve
    let side = 0;
    const mv = cm?.swing.vel, mn = cm?.swing.n;
    if (mv && mn) {
      const court = (a: number[]) => ({ x: p.right.x * a[0] + p.fwd.x * a[2], y: a[1], z: p.right.z * a[0] + p.fwd.z * a[2] });
      const vm = court(mv), nm = norm(court(mn));
      const sideM = norm({ x: -nm.z, y: 0, z: nm.x }); // up × n: horizontal across the face
      const upM = { x: nm.y * sideM.z - nm.z * sideM.y, y: nm.z * sideM.x - nm.x * sideM.z, z: nm.x * sideM.y - nm.y * sideM.x };
      const along = Math.max(len(vm) * 0.35, vm.x * nm.x + vm.y * nm.y + vm.z * nm.z, 0.3);
      const tv = (vm.x * upM.x + vm.y * upM.y + vm.z * upM.z) / along;
      const th = (vm.x * sideM.x + vm.z * sideM.z) / along;
      brush = brush * 0.5 + THREE.MathUtils.clamp(Math.atan(tv), -0.9, 0.9) * 0.5;
      // a square swing reads a little sideways from sensor noise: that much is nothing
      side = THREE.MathUtils.clamp(Math.sign(th) * Math.max(0, Math.abs(th) - 0.1) * 1.8, -1, 1);
    }
    let path = rotate(n, across, brush);
    if (side) {
      const sideF = norm({ x: -n.z, y: 0, z: n.x });
      path = norm({ x: path.x + sideF.x * side, y: path.y, z: path.z + sideF.z * side });
    }
    const speed = flat.speed / Math.max(0.6, Math.cos(brush) * Math.cos(Math.atan(side)) * 0.6 + 0.4) * (1 + gauss() * 0.03 * (1.4 - quality));
    // the body's run carries into the stroke
    const u = { x: path.x * speed + p.vel.x * 0.7, y: path.y * speed, z: path.z * speed + p.vel.z * 0.7 };
    const hit = impact(vIn, wIn, u, n);
    const dull = 1 - Math.min(0.35, (off / 0.06) ** 2 * 0.3);
    hit.v.x *= dull; hit.v.y *= dull; hit.v.z *= dull;
    // what practice gives back: part of the way toward the intended launch
    // (less with a measured path: the curve is the player's)
    const assist = (this.cfg.move === 'body' ? 0.7 : 0.8) * (mv ? 0.85 : 1);
    const v = hit.v, sp0 = len(v);
    const dir = norm({ x: v.x + (want.x / len(want) * sp0 - v.x) * assist, y: v.y + (want.y / len(want) * sp0 - v.y) * assist, z: v.z + (want.z / len(want) * sp0 - v.z) * assist });
    // and most of the pace: a mistimed touch shot lands a little off, not in the net
    const sp = sp0 + (len(want) - sp0) * assist * 0.8;
    return { v: { x: dir.x * sp, y: dir.y * sp, z: dir.z * sp }, w: hit.w };
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

  /**
   * The ball hits a player before it bounces (a drive at the body they couldn't get the paddle
   * to): the point goes to the hitter, wherever it was going.
   */
  /** paddles-only play */
  get paddlesOnly() { return this.cfg?.view === 'paddles'; }

  /**
   * Paddles only: the paddle flies where the game's (hidden) player carries it, turned exactly
   * as the phone is turned — all of it between strokes, most of it through a swing (the swing's
   * path is the stroke's; its face is yours). A quarter bigger than life: it's all there is to read
   */
  private flyPaddle(p: Player) {
    const pad = p.puppet?.paddle;
    if (!pad) return;
    const rk = p.rig.racket;
    rk.updateWorldMatrix(true, false);
    rk.matrixWorld.decompose(_fp, _fq, _fs);
    // where the sweet spot is: your phone's spot when it's tracked, else where the player carries it
    const sweet = p.human && this.bodyMode(p) ? this.trackedPaddle(p, _fs2) : null;
    if (!sweet) p.rig.sweetSpot(_fs2);
    const live = p.rig.liveQuat(_fq2);
    if (live) _fq.slerp(live, sweet ? 1 : p.rig.inStroke ? 0.65 : 1);
    // the hit: the face meets the ball — the last ~0.12 s before a committed strike pull the sweet
    // spot onto the ball, and it lets go over the ~0.1 s after
    const c = this.committed[p.index], b = this.ball.p;
    let pull = 0;
    if (c && this.clock < c.at + 1e-3) pull = 1 - THREE.MathUtils.smoothstep(c.at - this.clock, 0, 0.12);
    else if (!p.human && p.plan?.swung) pull = 1 - THREE.MathUtils.smoothstep(p.plan.tContact - this.clock, 0, 0.12);
    if (pull > 0) _fs2.lerp(_fv.set(b.x, b.y, b.z), pull);
    const snap = this.padSnap[p.index];
    if (pull === 0 && snap) {
      const k = Math.exp(-(this.clock - snap.t) / 0.07);
      if (k < 0.02) this.padSnap[p.index] = null;
      else _fs2.lerp(_fv.set(snap.x, snap.y, snap.z), k);
    }
    // placed by its sweet spot (turning it doesn't swing the head off the ball)
    _fp.copy(_fs2).sub(_fv.set(0, RACKET.sweet * _fone.y, 0).applyQuaternion(_fq));
    pad.matrix.compose(_fp, _fq, _fone);
    pad.matrixWorld.copy(pad.matrix);
  }

  private bodyCheck() {
    if (this.paddlesOnly) return;
    if (this.state !== 'rally' || this.dead || this.pendingPoint || this.lastHitter === null || this.bouncesAfterHit > 0 || this.clock - this.lastHitT < 0.12) return;
    const R = this.players[1 - this.lastHitter];
    const a = this.prevBall, b = this.ball.p;
    // closest approach of this frame's ball path to the body's axis (in plan)
    const sx = b.x - a.x, sz = b.z - a.z;
    const l2 = sx * sx + sz * sz;
    const t = l2 > 1e-9 ? THREE.MathUtils.clamp(((R.pos.x - a.x) * sx + (R.pos.z - a.z) * sz) / l2, 0, 1) : 1;
    const cx = a.x + sx * t, cz = a.z + sz * t, cy = a.y + (b.y - a.y) * t;
    if (Math.hypot(cx - R.pos.x, cz - R.pos.z) > 0.19 || cy < 0.3 || cy > 1.7) return;
    // a stroke on its way to this ball gets the paddle there first
    const plan = R.plan;
    if (plan && plan.tContact - this.clock < 0.08 && (R.human ? this.committed[R.index] : plan.swung)) return;
    this.dead = true;
    this.say(`body shot ${this.names[R.index]}`);
    const v = this.ball.v;
    this.ball.v = v3(-v.x * 0.15, Math.min(0, v.y) * 0.2, -v.z * 0.12);
    this.ball.w = v3();
    R.rig.cancelStroke();
    R.rig.react('dust', 1.4);
    this.audio.bounce(this.world.venue.surface, 2, this.pan(R.pos), R.pos.distanceTo(this.camera.position));
    this.audio.ooh(0.8);
    this.hud.call('Body shot', `${this.names[this.lastHitter]} tags ${this.names[R.index]}`, 1.6);
    this.pendingPoint = { winner: this.lastHitter, reason: 'winner', at: this.clock + 0.7 };
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
    this.perfects[1 - w] = 0;
    this.hot[1 - w] = false;
    this.ballView.hot = false;
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
    // after a moment the players walk back to where the next point starts
    if (this.stateT > 0.9 && this.match.winner === null) {
      const spots = this.servePositions();
      for (const p of this.players) {
        p.rig.walking = true;
        const d = p.pos.distanceTo(spots[p.index]);
        p.drive(dt, d > 0.15 ? p.seek(spots[p.index], 0.27) : new THREE.Vector3());
      }
    } else this.idlePlayers(dt);
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
    for (const p of this.players) if (this.paddlesOnly) this.flyPaddle(p); else p.puppet?.update();
    this.groundPlayers();
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

  private groundPlayers() {
    for (const p of this.players) {
      const m = this.contact[p.index];
      if (!m) continue;
      const r = p.rig.group.position;
      if (this.paddlesOnly && p.puppet) {
        // a soft spot under the paddle, smaller and fainter the higher it flies
        const e = p.puppet.paddle.matrixWorld.elements, y = Math.max(0, e[13]);
        m.position.set(e[12], 0.012, e[14]);
        m.scale.setScalar(0.32 + y * 0.12);
        continue;
      }
      m.position.set(r.x, 0.012, r.z);
      m.rotation.y = p.rig.yaw;
      m.scale.set(0.85, 1, 0.65);
      const s = this.sunShadow[p.index];
      if (s) {
        const h = Math.hypot(SUN_RAY.x, SUN_RAY.z) || 1;
        const len = Math.min(5, 1.75 / Math.max(0.2, -SUN_RAY.y / h));
        s.position.set(r.x + (SUN_RAY.x / h) * len * 0.45, 0.011, r.z + (SUN_RAY.z / h) * len * 0.45);
        s.rotation.y = Math.atan2(SUN_RAY.x, SUN_RAY.z);
        s.scale.set(0.6, 1, len);
      }
    }
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
