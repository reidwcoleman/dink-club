import * as THREE from 'three';
import { Human } from '../people/Human.ts';
import { buildRacket, RACKET } from './Racket.ts';

/**
 * A tennis player's body, posed every frame on top of the Rocketbox mocap:
 *
 *  1. root: position, yaw (hips toward the run, or square to the focus in the stance),
 *     height (a lower, athletic stance; split-step hops; the serve's jump)
 *  2. legs: in the stance the feet are planted in the world and step when the body moves
 *     away from them (a short arc, alternating feet — side shuffles come out of this); when
 *     running, the mocap run/jog/sprint clips at matched playback speed (backpedal = the walk
 *     played backwards). Planted legs are two-bone IK with the knee pole forward.
 *  3. spine: hips and chest yaw (the unit turn, the uncoiling), forward lean
 *  4. arms: the racket's sweet spot follows the stroke's keyframed path (player frame), bent
 *     so the strings meet the ball at the contact phase; the hand takes the racket's
 *     orientation and the arm is solved with two-bone IK; the other hand holds the throat,
 *     joins the grip (two-handers), points at the ball or tosses.
 *  5. head: looks at the ball.
 */

export type StrokeKind = 'fh' | 'bh' | 'fhSlice' | 'bhSlice' | 'fhVolley' | 'bhVolley' | 'serve' | 'smash' | 'fhLob' | 'bhLob' | 'fhDink' | 'bhDink';

type L3 = [number, number, number];
interface Key {
  t: number;
  head: L3; // sweet spot [right, up, forward]
  shaft: L3; // butt → head
  face: L3; // hitting-side string normal
  chest: number; // deg, + = right shoulder back
  hips: number;
  lean: number;
  knee: number;
  off: L3 | 'throat' | 'grip' | 'ball';
  pole?: L3; // elbow hint
  lift?: number; // root lift (jump)
}

const F: L3 = [0, 0, 1];
/** phase of contact in every stroke */
export const CONTACT = 0.55;

const STROKES: Record<StrokeKind, Key[]> = {
  fh: [
    { t: 0, head: [0.12, 1.08, 0.58], shaft: [-0.1, 0.45, 0.88], face: [-1, 0, 0], chest: 5, hips: 0, lean: 12, knee: 0.45, off: 'throat' },
    { t: 0.2, head: [0.62, 1.42, 0.05], shaft: [0.35, 0.8, -0.3], face: [-0.2, 0.2, -1], chest: 60, hips: 30, lean: 10, knee: 0.5, off: [0.25, 1.3, 0.55] },
    { t: 0.36, head: [0.62, 1.32, -0.55], shaft: [0.18, 0.62, -0.76], face: [0.1, -0.9, 0.3], chest: 88, hips: 45, lean: 12, knee: 0.6, off: [0.55, 1.25, 0.55], pole: [0.35, -1, -0.7] },
    { t: 0.47, head: [0.86, 0.64, -0.3], shaft: [0.3, -0.45, -0.84], face: [0.1, -0.3, 1], chest: 55, hips: 25, lean: 14, knee: 0.55, off: [0.35, 1.15, 0.35], pole: [0.3, -1, -0.2] },
    { t: CONTACT, head: [0.78, 0.95, 0.45], shaft: [0.95, -0.12, 0.22], face: [0, -0.08, 1], chest: 12, hips: 5, lean: 12, knee: 0.4, off: [-0.1, 1.1, 0.2], pole: [0.2, -1, 0] },
    { t: 0.7, head: [0.18, 1.62, 0.42], shaft: [-0.35, 0.9, 0.25], face: [-0.6, 0.2, 0.75], chest: -30, hips: -18, lean: 10, knee: 0.35, off: [-0.35, 1.05, 0.05], pole: [0.6, -0.6, 0] },
    { t: 1, head: [-0.42, 1.48, -0.3], shaft: [-0.3, -0.12, -0.94], face: [-0.8, 0.3, 0.4], chest: -58, hips: -32, lean: 8, knee: 0.3, off: [-0.25, 1.2, 0.1], pole: [0.8, -0.3, 0.2] },
  ],
  bh: [
    { t: 0, head: [0.1, 1.08, 0.58], shaft: [-0.1, 0.45, 0.88], face: [-1, 0, 0], chest: 5, hips: 0, lean: 12, knee: 0.45, off: 'throat' },
    { t: 0.2, head: [-0.55, 1.4, 0.0], shaft: [-0.35, 0.8, -0.35], face: [0.2, 0.2, -1], chest: -60, hips: -30, lean: 10, knee: 0.5, off: 'grip' },
    { t: 0.36, head: [-0.66, 1.3, -0.55], shaft: [-0.2, 0.6, -0.77], face: [-0.1, -0.9, 0.3], chest: -90, hips: -48, lean: 12, knee: 0.6, off: 'grip', pole: [-0.3, -1, -0.6] },
    { t: 0.47, head: [-0.88, 0.62, -0.28], shaft: [-0.3, -0.45, -0.84], face: [-0.1, -0.3, 1], chest: -55, hips: -25, lean: 14, knee: 0.55, off: 'grip', pole: [-0.2, -1, -0.2] },
    { t: CONTACT, head: [-0.72, 0.95, 0.45], shaft: [-0.95, -0.1, 0.25], face: [0, -0.08, 1], chest: -12, hips: -5, lean: 12, knee: 0.4, off: 'grip', pole: [-0.2, -1, 0.2] },
    { t: 0.7, head: [-0.1, 1.6, 0.45], shaft: [0.35, 0.9, 0.25], face: [0.6, 0.2, 0.75], chest: 30, hips: 18, lean: 10, knee: 0.35, off: 'grip', pole: [-0.5, -0.8, 0] },
    { t: 1, head: [0.45, 1.5, -0.28], shaft: [0.3, -0.1, -0.94], face: [0.8, 0.3, 0.4], chest: 58, hips: 30, lean: 8, knee: 0.3, off: 'grip', pole: [-0.8, -0.4, 0] },
  ],
  fhSlice: [
    { t: 0, head: [0.12, 1.08, 0.58], shaft: [-0.1, 0.45, 0.88], face: [-1, 0, 0], chest: 5, hips: 0, lean: 12, knee: 0.45, off: 'throat' },
    { t: 0.3, head: [0.7, 1.65, -0.35], shaft: [0.2, 0.75, -0.6], face: [0.2, 0.3, -0.9], chest: 70, hips: 35, lean: 10, knee: 0.5, off: [0.4, 1.3, 0.5] },
    { t: CONTACT, head: [0.75, 0.95, 0.5], shaft: [0.9, 0.2, 0.25], face: [0, 0.35, 0.94], chest: 15, hips: 5, lean: 14, knee: 0.55, off: [-0.3, 1.1, -0.1] },
    { t: 1, head: [0.15, 0.85, 0.9], shaft: [0.2, 0.45, 0.85], face: [-0.2, 0.8, 0.5], chest: -10, hips: -5, lean: 16, knee: 0.5, off: [-0.5, 1.1, -0.2] },
  ],
  bhSlice: [
    { t: 0, head: [0.1, 1.08, 0.58], shaft: [-0.1, 0.45, 0.88], face: [-1, 0, 0], chest: 5, hips: 0, lean: 12, knee: 0.45, off: 'throat' },
    { t: 0.3, head: [-0.65, 1.65, -0.4], shaft: [-0.2, 0.75, -0.6], face: [-0.2, 0.3, -0.9], chest: -85, hips: -45, lean: 10, knee: 0.5, off: 'throat' },
    { t: CONTACT, head: [-0.72, 0.95, 0.5], shaft: [-0.9, 0.2, 0.25], face: [0, 0.35, 0.94], chest: -20, hips: -10, lean: 14, knee: 0.55, off: [-0.35, 1.05, -0.45] },
    { t: 1, head: [0.35, 1.2, 0.65], shaft: [0.6, 0.6, 0.5], face: [0.3, 0.8, 0.5], chest: 20, hips: 5, lean: 14, knee: 0.5, off: [-0.55, 1.2, -0.5] },
  ],
  fhVolley: [
    { t: 0, head: [0.12, 1.15, 0.6], shaft: [-0.1, 0.5, 0.86], face: [-1, 0, 0], chest: 5, hips: 0, lean: 14, knee: 0.55, off: 'throat' },
    { t: 0.35, head: [0.6, 1.35, 0.2], shaft: [0.3, 0.8, -0.1], face: [0, 0.2, 1], chest: 35, hips: 15, lean: 14, knee: 0.55, off: [0.3, 1.25, 0.55] },
    { t: CONTACT, head: [0.6, 1.1, 0.75], shaft: [0.6, 0.5, 0.3], face: [0, 0.25, 0.97], chest: 15, hips: 5, lean: 16, knee: 0.6, off: [0.0, 1.15, 0.35] },
    { t: 1, head: [0.35, 1.0, 0.85], shaft: [0.5, 0.55, 0.4], face: [0, 0.4, 0.9], chest: 5, hips: 0, lean: 16, knee: 0.55, off: [-0.1, 1.1, 0.35] },
  ],
  bhVolley: [
    { t: 0, head: [0.1, 1.15, 0.6], shaft: [-0.1, 0.5, 0.86], face: [-1, 0, 0], chest: 5, hips: 0, lean: 14, knee: 0.55, off: 'throat' },
    { t: 0.35, head: [-0.6, 1.35, 0.15], shaft: [-0.3, 0.8, -0.1], face: [0, 0.2, 1], chest: -45, hips: -20, lean: 14, knee: 0.55, off: 'throat' },
    { t: CONTACT, head: [-0.6, 1.1, 0.75], shaft: [-0.6, 0.5, 0.3], face: [0, 0.25, 0.97], chest: -15, hips: -5, lean: 16, knee: 0.6, off: [-0.35, 1.15, -0.15] },
    { t: 1, head: [-0.35, 1.0, 0.85], shaft: [-0.5, 0.55, 0.4], face: [0, 0.4, 0.9], chest: -5, hips: 0, lean: 16, knee: 0.55, off: [-0.45, 1.15, -0.2] },
  ],
  // the underhand (volley) serve: ball held out in front, a low backswing, contact below the waist with the paddle head under the wrist, a rising follow-through
  serve: [
    { t: 0, head: [0.32, 0.85, 0.32], shaft: [0.1, -0.35, 0.93], face: [-0.2, 0.2, 0.95], chest: 12, hips: 8, lean: 14, knee: 0.35, off: 'ball' },
    { t: 0.36, head: [0.42, 0.48, -0.45], shaft: [0.12, -0.55, -0.82], face: [0, 0.6, -0.8], chest: 32, hips: 18, lean: 18, knee: 0.5, off: 'ball', pole: [0.4, -1, -0.3] },
    { t: 0.47, head: [0.42, 0.4, 0.0], shaft: [0.1, -0.95, -0.25], face: [0, 0.05, 1], chest: 22, hips: 12, lean: 18, knee: 0.5, off: [-0.08, 0.95, 0.42], pole: [0.4, -1, 0] },
    { t: CONTACT, head: [0.36, 0.52, 0.42], shaft: [0.08, -0.75, 0.66], face: [0, 0.38, 0.93], chest: 8, hips: 6, lean: 16, knee: 0.45, off: [-0.2, 1.0, 0.3], pole: [0.4, -1, 0.1] },
    { t: 0.75, head: [0.22, 1.25, 0.72], shaft: [-0.05, 0.55, 0.83], face: [-0.1, 0.75, 0.6], chest: -12, hips: -6, lean: 12, knee: 0.4, off: [-0.35, 1.0, 0.1], pole: [0.6, -0.6, 0] },
    { t: 1, head: [0.1, 1.55, 0.5], shaft: [-0.15, 0.85, 0.5], face: [-0.3, 0.6, 0.7], chest: -22, hips: -10, lean: 8, knee: 0.35, off: [-0.3, 1.05, 0.1], pole: [0.7, -0.4, 0] },
  ],
  // the dink: knees bent, a short push from below the ball with an open face, a soft lift
  fhDink: [
    { t: 0, head: [0.25, 0.9, 0.45], shaft: [0.05, 0.3, 0.95], face: [-0.8, 0.2, 0.5], chest: 5, hips: 0, lean: 22, knee: 0.6, off: 'throat' },
    { t: 0.36, head: [0.5, 0.5, 0.1], shaft: [0.45, -0.45, 0.77], face: [0, 0.45, 0.89], chest: 25, hips: 10, lean: 26, knee: 0.75, off: [0.05, 1.05, 0.45] },
    { t: CONTACT, head: [0.48, 0.42, 0.55], shaft: [0.5, -0.35, 0.79], face: [0, 0.62, 0.78], chest: 12, hips: 5, lean: 26, knee: 0.75, off: [-0.15, 1.0, 0.35] },
    { t: 1, head: [0.38, 0.75, 0.88], shaft: [0.35, 0.2, 0.92], face: [0, 0.8, 0.6], chest: 2, hips: 0, lean: 24, knee: 0.7, off: [-0.25, 1.0, 0.3] },
  ],
  bhDink: [
    { t: 0, head: [0.2, 0.9, 0.45], shaft: [0.05, 0.3, 0.95], face: [-0.8, 0.2, 0.5], chest: 5, hips: 0, lean: 22, knee: 0.6, off: 'throat' },
    { t: 0.36, head: [-0.5, 0.5, 0.08], shaft: [-0.45, -0.45, 0.77], face: [0, 0.45, 0.89], chest: -30, hips: -12, lean: 26, knee: 0.75, off: 'throat' },
    { t: CONTACT, head: [-0.48, 0.42, 0.55], shaft: [-0.5, -0.35, 0.79], face: [0, 0.62, 0.78], chest: -14, hips: -6, lean: 26, knee: 0.75, off: [-0.4, 0.95, 0.2] },
    { t: 1, head: [-0.35, 0.75, 0.88], shaft: [-0.35, 0.2, 0.92], face: [0, 0.8, 0.6], chest: -2, hips: 0, lean: 24, knee: 0.7, off: [-0.45, 1.0, 0.15] },
  ],
  smash: [
    { t: 0, head: [0.18, 1.2, 0.55], shaft: [-0.05, 0.45, 0.9], face: [-1, 0, 0], chest: 20, hips: 10, lean: 6, knee: 0.4, off: 'throat' },
    { t: 0.35, head: [0.5, 1.95, -0.25], shaft: [0.15, 0.92, -0.35], face: [-0.2, 0, -1], chest: 85, hips: 50, lean: -8, knee: 0.55, off: [0.1, 2.25, 0.5], pole: [0.8, -0.2, -0.5] },
    { t: 0.47, head: [0.3, 1.1, -0.35], shaft: [0.05, -0.98, -0.1], face: [0, 0, -1], chest: 65, hips: 30, lean: -10, knee: 0.35, off: [0.0, 1.9, 0.45], pole: [0.8, 0.5, -0.3] },
    { t: CONTACT, head: [0.3, 2.65, 0.5], shaft: [0.08, 0.95, 0.3], face: [0, -0.3, 1], chest: 5, hips: 5, lean: 10, knee: 0.1, off: [-0.25, 1.3, 0.2], pole: [0.8, -0.2, 0], lift: 0.1 },
    { t: 1, head: [-0.5, 0.6, 0.35], shaft: [-0.4, -0.7, -0.2], face: [-0.9, 0.2, 0.3], chest: -50, hips: -25, lean: 18, knee: 0.4, off: [-0.3, 1.05, 0.05], pole: [0.9, -0.2, 0] },
  ],
  fhLob: [],
  bhLob: [],
};
STROKES.fhLob = STROKES.fh.map((k) => (k.t >= CONTACT ? { ...k, head: [k.head[0] * 0.8, k.head[1] + 0.2, k.head[2]] as L3, face: k.t === CONTACT ? ([0, 0.55, 0.83] as L3) : k.face } : k));
STROKES.bhLob = STROKES.bh.map((k) => (k.t >= CONTACT ? { ...k, head: [k.head[0] * 0.8, k.head[1] + 0.2, k.head[2]] as L3, face: k.t === CONTACT ? ([0, 0.55, 0.83] as L3) : k.face } : k));

// a paddle is 40 cm, not 69: bring the tennis paths in toward the shoulders so the arm stays natural
for (const kind of ['fh', 'bh', 'fhSlice', 'bhSlice', 'fhVolley', 'bhVolley', 'smash', 'fhLob', 'bhLob'] as StrokeKind[]) {
  STROKES[kind] = STROKES[kind].map((k) => ({ ...k, head: [k.head[0] * 0.8, 1.3 + (k.head[1] - 1.3) * 0.88, k.head[2] * 0.82] as L3 }));
}
// the ready position: paddle up in front of the chest, the off hand on the throat
STROKES.fh[0] = { ...STROKES.fh[0], head: [0.15, 1.1, 0.45], shaft: [-0.05, 0.75, 0.66], face: [-1, 0, 0.1] };
STROKES.bh[0] = STROKES.fh[0];
const READY = STROKES.fh[0];
const DEG = Math.PI / 180;

interface Foot {
  bone: THREE.Bone;
  thigh: THREE.Bone;
  calf: THREE.Bone;
  side: number;
  plant: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number; // step progress (≥1: planted)
  yaw: number;
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class PlayerRig {
  readonly racket: THREE.Group;
  readonly group: THREE.Group;
  /** world yaw of the player's facing (0 = +z) */
  yaw = 0;
  /** world position (on the floor) */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** where the chest and head turn to (the ball / the net) */
  readonly focus = new THREE.Vector3(0, 1, 0);
  /** the ball (head look) */
  readonly look = new THREE.Vector3(0, 1, 0);
  /** a ball in the off hand (serve toss): world position the rig reports */
  readonly offHand = new THREE.Vector3();
  holdingBall = false;
  /** walking (between points) rather than playing: the walk clips instead of the stance */
  walking = false;
  // stroke state
  stroke: StrokeKind | null = null;
  strokeT = 0; // phase 0..1
  private strokeW = 0;
  private strokeTimeline: { tStart: number; tFwd: number; tContact: number; tEnd: number } | null = null;
  private clock = 0;
  private contactLocal = new THREE.Vector3();
  private aimYaw = 0;
  private runW = 0;
  private hop = 0;
  private hopV = 0;
  private sprintAction: string | null = null;
  private feet: Foot[] = [];
  private gripLocal = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private bones: Record<string, THREE.Bone>;
  private ankleY = 0.08;
  private hipH = 0.95;
  private armLen = 0.6;
  private base = new Map<THREE.Bone, THREE.Quaternion>();
  /** a foot landed (world x, z, heading) — footprints on clay */
  onStep: ((x: number, z: number, heading: number, side: number) => void) | null = null;

  constructor(readonly human: Human, paddleArt?: string) {
    this.group = human.root;
    this.bones = human.bones;
    this.racket = buildRacket(paddleArt);
    // measure the bind pose
    human.root.updateMatrixWorld(true);
    const b = this.bones;
    this.ankleY = b.Bip01_L_Foot.getWorldPosition(_v).y;
    this.hipH = b.Bip01_L_Thigh.getWorldPosition(_v).y;
    this.armLen = b.Bip01_R_UpperArm.getWorldPosition(_v).distanceTo(b.Bip01_R_Forearm.getWorldPosition(_w)) + b.Bip01_R_Forearm.getWorldPosition(_v).distanceTo(b.Bip01_R_Hand.getWorldPosition(_w));
    this.setupGrip();
    for (const [s, side] of [['L', -1], ['R', 1]] as const) {
      this.feet.push({
        bone: b[`Bip01_${s}_Foot`], thigh: b[`Bip01_${s}_Thigh`], calf: b[`Bip01_${s}_Calf`], side,
        plant: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, yaw: 0,
      });
    }
    // flat-foot orientation relative to the root, from the bind pose
    for (const f of this.feet) {
      const rq = human.root.getWorldQuaternion(new THREE.Quaternion()).invert();
      (f as Foot & { rel: THREE.Quaternion }).rel = rq.multiply(f.bone.getWorldQuaternion(new THREE.Quaternion()));
    }
    human.play('idle', { fade: 0 });
  }

  /** the racket in the right hand, grip frame from the bind pose's hand landmarks */
  private setupGrip() {
    const b = this.bones;
    const H = b.Bip01_R_Hand.getWorldPosition(new THREE.Vector3());
    const F1 = b.Bip01_R_Finger1.getWorldPosition(new THREE.Vector3());
    const F2 = b.Bip01_R_Finger2.getWorldPosition(new THREE.Vector3());
    const F4 = (b.Bip01_R_Finger4 ?? b.Bip01_R_Finger3).getWorldPosition(new THREE.Vector3());
    const T0 = b.Bip01_R_Finger0.getWorldPosition(new THREE.Vector3());
    const fd = F2.clone().sub(H).normalize();
    const ac = F1.clone().sub(F4);
    ac.addScaledVector(fd, -ac.dot(fd)).normalize();
    let pn = new THREE.Vector3().crossVectors(fd, ac).normalize();
    // the palm side is where the thumb sits
    const th = T0.clone().sub(H);
    if (th.dot(pn) < 0) pn.negate();
    const shaft = ac.clone().multiplyScalar(0.94).addScaledVector(fd, 0.34).normalize();
    // face normal: the palm's normal, orthogonal to the shaft
    const face = pn.clone().addScaledVector(shaft, -pn.dot(shaft)).normalize();
    const palm = H.clone().addScaledVector(fd, F2.distanceTo(H) * 0.55).addScaledVector(pn, 0.022);
    const origin = palm.clone().addScaledVector(shaft, -RACKET.grip);
    // racket world frame (bind): y = shaft, z = face, x = y × z
    const x = new THREE.Vector3().crossVectors(shaft, face);
    const Rw = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, shaft, face));
    const Hq = b.Bip01_R_Hand.getWorldQuaternion(new THREE.Quaternion());
    const Hinv = Hq.clone().invert();
    this.gripLocal.quat.copy(Hinv.clone().multiply(Rw));
    this.gripLocal.pos.copy(origin.sub(H).applyQuaternion(Hinv));
    b.Bip01_R_Hand.add(this.racket);
    this.racket.position.copy(this.gripLocal.pos);
    this.racket.quaternion.copy(this.gripLocal.quat);
  }

  /** start a stroke: its contact at time tContact (s from now), meeting the ball at `contact` (world), sending it along aimYaw */
  swing(kind: StrokeKind, tContact: number, contact: THREE.Vector3, aimDir?: THREE.Vector3) {
    this.stroke = kind;
    const now = this.clock;
    const fwdDur = kind === 'serve' ? 0.26 : kind === 'smash' ? 0.26 : kind.includes('Volley') ? 0.12 : kind.includes('Dink') ? 0.16 : 0.2;
    const follow = kind === 'serve' ? 0.55 : kind.includes('Volley') ? 0.3 : kind.includes('Dink') ? 0.35 : 0.45;
    const tC = now + Math.max(0.12, tContact);
    this.strokeTimeline = { tStart: now, tFwd: tC - fwdDur, tContact: tC, tEnd: tC + follow };
    this.setContact(contact);
    this.aimYaw = aimDir ? Math.atan2(aimDir.x, aimDir.z) : this.yaw;
  }

  /** update the contact point while the ball is still coming (keeps the swing on the ball) */
  setContact(contact: THREE.Vector3, tContact?: number) {
    // into the player frame (fixed at the current yaw)
    _v.copy(contact).sub(this.pos);
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    // local: right = −x' for yaw 0 facing +z … use the basis vectors instead
    const fwd = _w.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = _u.set(-fwd.z, 0, fwd.x);
    void c; void s;
    this.contactLocal.set(_v.dot(right), contact.y, _v.dot(fwd));
    if (tContact !== undefined && this.strokeTimeline) {
      const tl = this.strokeTimeline;
      const tC = this.clock + Math.max(0.05, tContact);
      const shift = tC - tl.tContact;
      tl.tContact += shift;
      tl.tFwd += shift;
      tl.tEnd += shift;
    }
  }

  cancelStroke() {
    this.stroke = null;
    this.strokeTimeline = null;
  }

  /** play a mocap reaction (fist pump, shrug) with the procedural layers off */
  private reaction: { clip: string; until: number } | null = null;
  react(clip: string, seconds: number) {
    if (this.stroke) return;
    this.reaction = { clip, until: this.clock + seconds };
    this.human.play(clip, { fade: 0.25, once: true });
    this.sprintAction = clip;
  }

  /** stretch for a ball: the near foot steps out toward `at` and the hips drop, until `seconds` pass */
  lunge(at: THREE.Vector3, seconds: number) {
    this.lungeAt.set(at.x, 0, at.z);
    this.lungeUntil = this.clock + seconds;
  }
  private lungeAt = new THREE.Vector3();
  private lungeUntil = -1;
  private lungeW = 0;

  splitStep() {
    if (this.hop <= 0.001) this.hopV = 1.6;
  }

  get inStroke(): boolean {
    return this.stroke !== null;
  }

  /** freeze a stroke at a phase (tools / screenshots) */
  debugPhase: number | null = null;

  /** the phase of the stroke at the current clock */
  private phaseAt(): number {
    if (this.debugPhase !== null) return this.debugPhase;
    const tl = this.strokeTimeline!;
    const t = this.clock;
    if (t < tl.tFwd) {
      // preparation: reach the slot (0.36) over 0.35 s, then hold
      const prep = Math.min(1, (t - tl.tStart) / Math.max(0.12, Math.min(0.4, tl.tFwd - tl.tStart)));
      return 0.36 * smooth(prep);
    }
    if (t < tl.tContact) return 0.36 + (CONTACT - 0.36) * ((t - tl.tFwd) / (tl.tContact - tl.tFwd));
    return Math.min(1, CONTACT + (1 - CONTACT) * ((t - tl.tContact) / (tl.tEnd - tl.tContact)));
  }

  update(dt: number) {
    this.clock += dt;
    const h = this.human;
    // ---------------- stroke timing
    let keyPose: Key = READY;
    if (this.stroke && this.strokeTimeline) {
      const tl = this.strokeTimeline;
      this.strokeT = this.phaseAt();
      this.strokeW = Math.min(1, this.strokeW + dt / 0.12);
      if (this.debugPhase !== null) this.strokeW = 1;
      else if (this.clock > tl.tEnd + 0.05) {
        this.stroke = null;
        this.strokeTimeline = null;
      }
    } else {
      this.strokeW = Math.max(0, this.strokeW - dt / 0.35);
    }
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.reaction) {
      if (this.clock < this.reaction.until && !this.stroke && speed < 1.5) {
        h.animate(dt);
        h.root.position.copy(this.pos);
        h.root.rotation.set(0, this.yaw, 0);
        h.ground();
        for (const f of this.feet) f.plant.set(0, 0, 0);
        return;
      }
      this.reaction = null;
      this.sprintAction = null;
    }
    // ---------------- locomotion mode: run clips vs the stance
    // keep running through the approach of a stroke (and the recovery after it): the planted-feet
    // stance only takes over once the player has arrived, so there are no stretched sliding strides
    const strokeFree = !this.stroke || this.strokeT < CONTACT - 0.1 || this.strokeT > 0.78;
    const wantRun = strokeFree && (speed > (this.runW > 0.5 ? 1.9 : 2.7) || (this.walking && speed > 0.3)) ? 1 : 0;
    this.runW += (wantRun - this.runW) * Math.min(1, dt * 7);
    // pick the clip by speed; backpedal plays the walk backwards
    const facing = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const moveDir = speed > 0.05 ? _v.set(this.vel.x / speed, 0, this.vel.z / speed) : facing;
    const along = moveDir.dot(facing);
    let clip = 'idle', rate = 1;
    if (this.runW > 0.05 && this.walking && speed < 1.9) {
      // between points: an unhurried walk back into position
      if (speed < 1.25) { clip = 'walk'; rate = Math.max(0.4, speed / 1.012); }
      else { clip = 'walk_fast'; rate = speed / 1.495; }
    } else if (this.runW > 0.05) {
      if (along < -0.45) { clip = 'jog'; rate = -speed / 2.4; }
      else if (speed < 3.6) { clip = 'jog'; rate = speed / 2.41; }
      else if (speed < 4.8) { clip = 'run'; rate = speed / 2.88; }
      else { clip = 'sprint'; rate = speed / 5.84; }
    }
    if (clip !== this.sprintAction) {
      h.play(clip, { fade: 0.2 });
      this.sprintAction = clip;
    }
    if (h.current) h.current.timeScale = clip === 'idle' ? 1 : rate;
    h.animate(dt);
    // root yaw: facing the run direction when running (reversed for backpedal), else the set yaw
    let rootYaw = this.yaw;
    if (this.runW > 0.05 && speed > 0.5) {
      const runYaw = along < -0.45 ? Math.atan2(-moveDir.x, -moveDir.z) : Math.atan2(moveDir.x, moveDir.z);
      rootYaw = lerpAngle(this.yaw, runYaw, this.runW);
    }
    // hop (split step / serve jump)
    this.hopV -= 9.81 * dt;
    this.hop = Math.max(0, this.hop + this.hopV * dt);
    if (this.hop <= 0 && this.hopV < 0) this.hopV = 0;
    // keep the pre-pose (clip) quaternions so we can blend
    const stance = 1 - this.runW;
    // ---------------- keyed pose
    const k = this.stroke ? this.sample(this.stroke, this.strokeT) : READY;
    keyPose = k;
    const sw = smooth(this.strokeW);
    const chest = lerp(READY.chest, k.chest, sw) * stance + 0;
    const hips = lerp(READY.hips, k.hips, sw) * stance;
    const lean = lerp(READY.lean, k.lean, sw) * stance + this.runW * 8;
    const knee = lerp(READY.knee, k.knee, sw);
    const lift = (k.lift ?? 0) * sw;
    // root
    const root = h.root;
    root.position.copy(this.pos);
    root.rotation.set(0, rootYaw, 0);
    h.inner.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    // stance height: knees bent lower the hips
    this.lungeW += ((this.clock < this.lungeUntil ? 1 : 0) - this.lungeW) * Math.min(1, dt * (this.clock < this.lungeUntil ? 9 : 4));
    const drop = stance * (0.05 + knee * 0.12 + this.lungeW * 0.16);
    // ---------------- spine: hips yaw on the spine base, chest on the upper spine, lean forward
    const b = this.bones;
    const up = _u.set(0, 1, 0);
    const turn = (bone: THREE.Bone, axis: THREE.Vector3, ang: number) => {
      if (!ang) return;
      bone.getWorldQuaternion(_q);
      _q2.setFromAxisAngle(axis, ang).multiply(_q);
      setWorldQuat(bone, _q2);
      bone.updateMatrixWorld(true);
    };
    const rightAxis = new THREE.Vector3(-Math.cos(rootYaw), 0, Math.sin(rootYaw));
    // (the facing's right is (−cos, 0, sin)… as a yaw-0 person facing +z has their right at −x)
    const hipsAng = -hips * DEG * stance, chestAng = -(chest - hips) * DEG * stance;
    // the chest also counter-rotates toward the focus when the run turned the hips away
    const counter = this.runW > 0.05 ? angleDiff(rootYaw, this.yaw) * 0.55 * this.runW : 0;
    turn(b.Bip01_Pelvis, up, hipsAng);
    turn(b.Bip01_Spine1, up, chestAng * 0.5 + counter * 0.5);
    turn(b.Bip01_Spine2, up, chestAng * 0.5 + counter * 0.5);
    turn(b.Bip01_Spine1, rightAxis, -lean * DEG * 0.5);
    turn(b.Bip01_Spine2, rightAxis, -lean * DEG * 0.3);
    // ---------------- legs
    h.inner.position.y = -drop + this.hop + lift;
    root.updateMatrixWorld(true);
    this.updateFeet(dt, rootYaw, stance, knee, speed);
    // ---------------- arms
    this.poseArms(keyPose, sw, stance, rootYaw);
    // ---------------- head: look at the ball
    const head = b.Bip01_Head, neck = b.Bip01_Neck;
    const hp = head.getWorldPosition(_w);
    const toBall = _v.copy(this.look).sub(hp);
    if (toBall.lengthSq() > 0.01) {
      toBall.normalize();
      // current head forward (+z of the root rotated by the chest) ≈ bind forward
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(_q)).normalize();
      void fwd;
      // turn the neck and head about world up toward the ball's azimuth, and pitch
      const curYaw = rootYaw + chestAng + hipsAng + counter;
      const wantYaw = Math.atan2(toBall.x, toBall.z);
      const dy = THREE.MathUtils.clamp(angleDiff(curYaw, wantYaw), -1.2, 1.2);
      turn(neck, up, dy * 0.4);
      turn(head, up, dy * 0.6);
      const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(toBall.y, -1, 1)), -0.7, 0.6);
      const ra = new THREE.Vector3(-Math.cos(curYaw + dy), 0, Math.sin(curYaw + dy));
      turn(head, ra, pitch * 0.7);
    }
    root.updateMatrixWorld(true);
  }

  /** feet: planted IK in the stance (with steps), the clip when running */
  private updateFeet(dt: number, rootYaw: number, stance: number, knee: number, speed: number) {
    const root = this.human.root;
    const fwd = new THREE.Vector3(Math.sin(rootYaw), 0, Math.cos(rootYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const width = 0.2 + knee * 0.12 + (this.stroke ? 0.05 : 0);
    // step lead: when moving, the target is placed ahead along the velocity
    const lead = new THREE.Vector3(this.vel.x, 0, this.vel.z).multiplyScalar(0.12);
    const stepDur = 0.16;
    let stepping = false;
    for (const f of this.feet) if (f.t < 1) stepping = true;
    for (const f of this.feet) {
      // the foot's home under the hip, offset to its side (right = +1)
      const home = this.pos.clone().addScaledVector(right, f.side * width).addScaledVector(fwd, f.side * 0.03).add(lead);
      home.y = 0;
      if (this.lungeW > 0.05) {
        // the foot on the ball's side reaches out toward it
        const to = _w.copy(this.lungeAt).sub(this.pos).setY(0);
        const d = to.length();
        if (d > 0.05 && Math.sign(to.dot(right)) === f.side) home.addScaledVector(to, (Math.min(0.62, d) / d) * this.lungeW);
      }
      if (stance < 0.2 || f.plant.lengthSq() === 0) {
        f.plant.copy(home);
        f.t = 1;
      }
      if (f.t >= 1) {
        const d = f.plant.distanceTo(home);
        if (!stepping && d > 0.17 + (speed < 0.3 ? 0.08 : 0)) {
          f.from.copy(f.plant);
          f.to.copy(home).addScaledVector(lead, 0.8);
          f.t = 0;
          stepping = true;
        }
      } else {
        f.t = Math.min(1, f.t + dt / stepDur);
        f.plant.lerpVectors(f.from, f.to, smooth(f.t));
        if (f.t >= 1) this.onStep?.(f.plant.x, f.plant.z, rootYaw, f.side);
      }
    }
    // running: a foot plant is the foot bone reaching the floor after a stride
    if (stance < 0.5) {
      for (const f of this.feet) {
        const fp = f.bone.getWorldPosition(new THREE.Vector3());
        const st = f as Foot & { up?: boolean };
        if (fp.y > this.ankleY + 0.07) st.up = true;
        else if (st.up && fp.y < this.ankleY + 0.025) {
          st.up = false;
          this.onStep?.(fp.x, fp.z, rootYaw, f.side);
        }
      }
    }
    if (stance < 0.02) return;
    // IK each leg to its plant (+ swing height while stepping)
    for (const f of this.feet) {
      const target = f.plant.clone();
      const liftH = f.t < 1 ? Math.sin(f.t * Math.PI) * 0.09 : 0;
      target.y = this.ankleY + liftH;
      const thighQ = f.thigh.quaternion.clone(), calfQ = f.calf.quaternion.clone(), footQ = f.bone.quaternion.clone();
      const pole = fwd.clone().multiplyScalar(1).addScaledVector(right, f.side * 0.25).add(new THREE.Vector3(0, 0.1, 0));
      solveTwoBone(f.thigh, f.calf, f.bone, target, f.thigh.getWorldPosition(new THREE.Vector3()).add(pole));
      // foot flat, toes out a little
      const rel = (f as Foot & { rel: THREE.Quaternion }).rel;
      const rq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rootYaw + f.side * -0.18);
      setWorldQuat(f.bone, rq.multiply(rel));
      f.bone.updateMatrixWorld(true);
      // blend with the clip by stance
      if (stance < 0.999) {
        f.thigh.quaternion.slerpQuaternions(thighQ, f.thigh.quaternion.clone(), stance);
        f.calf.quaternion.slerpQuaternions(calfQ, f.calf.quaternion.clone(), stance);
        f.bone.quaternion.slerpQuaternions(footQ, f.bone.quaternion.clone(), stance);
        f.thigh.updateMatrixWorld(true);
      }
    }
    void root;
  }

  /** sample a stroke's keys at phase t (positions Catmull-Rom, directions nlerp) */
  private sample(kind: StrokeKind, t: number): Key {
    const keys = STROKES[kind];
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t < t) i++;
    const a = keys[i], b = keys[i + 1];
    const u = THREE.MathUtils.clamp((t - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
    const p0 = keys[Math.max(0, i - 1)], p3 = keys[Math.min(keys.length - 1, i + 2)];
    const cr = (x0: number, x1: number, x2: number, x3: number) => 0.5 * (2 * x1 + (-x0 + x2) * u + (2 * x0 - 5 * x1 + 4 * x2 - x3) * u * u + (-x0 + 3 * x1 - 3 * x2 + x3) * u * u * u);
    const us = smooth(u);
    const head: L3 = [0, 1, 2].map((j) => cr(p0.head[j], a.head[j], b.head[j], p3.head[j])) as L3;
    const nl = (x: L3, y: L3): L3 => {
      const r = [0, 1, 2].map((j) => x[j] + (y[j] - x[j]) * us);
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      return [r[0] / l, r[1] / l, r[2] / l];
    };
    const offOf = (o: Key['off']) => o;
    let off: Key['off'] = u < 0.5 ? offOf(a.off) : offOf(b.off);
    if (Array.isArray(a.off) && Array.isArray(b.off)) off = [0, 1, 2].map((j) => (a.off as L3)[j] + ((b.off as L3)[j] - (a.off as L3)[j]) * us) as L3;
    return {
      t, head, shaft: nl(a.shaft, b.shaft), face: nl(a.face, b.face),
      chest: lerp(a.chest, b.chest, us), hips: lerp(a.hips, b.hips, us), lean: lerp(a.lean, b.lean, us), knee: lerp(a.knee, b.knee, us),
      off, pole: a.pole && b.pole ? nl(a.pole, b.pole) : (a.pole ?? b.pole), lift: lerp(a.lift ?? 0, b.lift ?? 0, us),
    };
  }

  private poseArms(k: Key, sw: number, stance: number, rootYaw: number) {
    const b = this.bones;
    const root = this.human.root;
    // the player frame: facing this.yaw (not the running hips)
    const yaw = this.stroke ? this.yaw : lerpAngle(this.yaw, rootYaw, this.runW);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const toWorld = (l: L3, out: THREE.Vector3, point: boolean) => {
      out.set(0, 0, 0).addScaledVector(right, l[0]).addScaledVector(fwd, l[2]);
      out.y = l[1];
      if (point) out.add(this.pos).setY(l[1] + this.human.inner.position.y * 0.6);
      return out;
    };
    // the swing's path bends so the sweet spot meets the ball at contact
    let head = toWorld(k.head, new THREE.Vector3(), true);
    if (this.stroke) {
      const keys = STROKES[this.stroke];
      const kc = keys.find((q) => q.t === CONTACT)!;
      const dl = new THREE.Vector3(this.contactLocal.x - kc.head[0], this.contactLocal.y - kc.head[1], this.contactLocal.z - kc.head[2]);
      const bell = Math.exp(-(((this.strokeT - CONTACT) / 0.22) ** 2));
      const off = toWorld([dl.x * (0.25 + 0.75 * bell), dl.y * (0.3 + 0.7 * bell), dl.z * (0.25 + 0.75 * bell)], new THREE.Vector3(), false);
      head.add(off);
    }
    const shaft = toWorld(k.shaft, new THREE.Vector3(), false).normalize();
    const face = toWorld(k.face, new THREE.Vector3(), false).normalize();
    // strength of the keyed arm pose: full in the stance and strokes, a relaxed carry when running
    const armW = Math.max(sw, stance * 0.95);
    if (armW < 0.02) return;
    // racket world frame → hand orientation → wrist target
    const z = face.clone().addScaledVector(shaft, -face.dot(shaft)).normalize();
    const x = new THREE.Vector3().crossVectors(shaft, z);
    const Rq = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(x, shaft, z));
    const Hq = Rq.clone().multiply(this.gripLocal.quat.clone().invert());
    const racketOrigin = head.clone().addScaledVector(shaft, -RACKET.sweet);
    const wrist = racketOrigin.clone().sub(this.gripLocal.pos.clone().applyQuaternion(Hq));
    const ua = b.Bip01_R_UpperArm, fa = b.Bip01_R_Forearm, hand = b.Bip01_R_Hand;
    const saved = [ua.quaternion.clone(), fa.quaternion.clone(), hand.quaternion.clone()];
    const pole = k.pole ? toWorld(k.pole, new THREE.Vector3(), false) : right.clone().multiplyScalar(0.3).add(new THREE.Vector3(0, -1, 0)).addScaledVector(fwd, -0.2);
    solveTwoBone(ua, fa, hand, wrist, ua.getWorldPosition(new THREE.Vector3()).add(pole));
    setWorldQuat(hand, Hq);
    hand.updateMatrixWorld(true);
    if (armW < 0.999) {
      ua.quaternion.slerpQuaternions(saved[0], ua.quaternion.clone(), armW);
      fa.quaternion.slerpQuaternions(saved[1], fa.quaternion.clone(), armW);
      hand.quaternion.slerpQuaternions(saved[2], hand.quaternion.clone(), armW);
      ua.updateMatrixWorld(true);
    }
    // ---- the other hand
    const lua = b.Bip01_L_UpperArm, lfa = b.Bip01_L_Forearm, lh = b.Bip01_L_Hand;
    const lsaved = [lua.quaternion.clone(), lfa.quaternion.clone(), lh.quaternion.clone()];
    let target: THREE.Vector3;
    const racketPoint = (y: number) => this.racket.localToWorld(new THREE.Vector3(0, y, 0));
    this.racket.updateMatrixWorld(true);
    if (k.off === 'throat') target = racketPoint(RACKET.throat).addScaledVector(fwd, -0.04);
    else if (k.off === 'grip') target = racketPoint(RACKET.twoHand).addScaledVector(fwd, -0.02);
    else if (k.off === 'ball') target = toWorld([0.02, 0.92, 0.48], new THREE.Vector3(), true);
    else target = toWorld(k.off, new THREE.Vector3(), true);
    const lpole = right.clone().multiplyScalar(-0.5).add(new THREE.Vector3(0, -1, 0));
    solveTwoBone(lua, lfa, lh, target, lua.getWorldPosition(new THREE.Vector3()).add(lpole));
    const lw = Math.max(sw, stance * 0.9);
    if (lw < 0.999) {
      lua.quaternion.slerpQuaternions(lsaved[0], lua.quaternion.clone(), lw);
      lfa.quaternion.slerpQuaternions(lsaved[1], lfa.quaternion.clone(), lw);
      lh.quaternion.slerpQuaternions(lsaved[2], lh.quaternion.clone(), lw);
    }
    lua.updateMatrixWorld(true);
    lh.getWorldPosition(this.offHand);
    void root;
  }

  /** the racket's sweet spot in the world (for hit effects) */
  sweetSpot(out = new THREE.Vector3()): THREE.Vector3 {
    this.racket.updateMatrixWorld(true);
    return this.racket.localToWorld(out.set(0, RACKET.sweet, 0));
  }

  /** time of contact in the current stroke (seconds from now), or null */
  timeToContact(): number | null {
    return this.strokeTimeline ? this.strokeTimeline.tContact - this.clock : null;
  }
}

// ------------------------------------------------------------------------------------ helpers
function setWorldQuat(bone: THREE.Object3D, q: THREE.Quaternion) {
  const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(pq.invert().multiply(q));
}

/** rotate `bone` so the point `from` (world, moving with it) swings toward `to` */
function aim(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  const bp = bone.getWorldPosition(new THREE.Vector3());
  const a = from.clone().sub(bp), c = to.clone().sub(bp);
  if (a.lengthSq() < 1e-8 || c.lengthSq() < 1e-8) return;
  const dq = new THREE.Quaternion().setFromUnitVectors(a.normalize(), c.normalize());
  const wq = bone.getWorldQuaternion(new THREE.Quaternion());
  setWorldQuat(bone, dq.multiply(wq));
  bone.updateMatrixWorld(true);
}

/** two-bone IK: upper/lower/end bones reach `target`, the middle joint bending toward `pole` (a world point) */
export function solveTwoBone(upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3) {
  const S = upper.getWorldPosition(new THREE.Vector3());
  const E = lower.getWorldPosition(new THREE.Vector3());
  const W = end.getWorldPosition(new THREE.Vector3());
  const a = S.distanceTo(E), b = E.distanceTo(W);
  const d = target.clone().sub(S);
  const dist = THREE.MathUtils.clamp(d.length(), Math.abs(a - b) + 1e-3, (a + b) * 0.9995);
  const dir = d.normalize();
  const pv = pole.clone().sub(S);
  pv.addScaledVector(dir, -pv.dot(dir));
  if (pv.lengthSq() < 1e-8) pv.set(0, -1, 0).addScaledVector(dir, dir.y);
  pv.normalize();
  const x = (a * a - b * b + dist * dist) / (2 * dist);
  const hgt = Math.sqrt(Math.max(0, a * a - x * x));
  const Ed = S.clone().addScaledVector(dir, x).addScaledVector(pv, hgt);
  aim(upper, E, Ed);
  const W2 = end.getWorldPosition(new THREE.Vector3());
  aim(lower, W2, S.clone().addScaledVector(dir, dist));
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function angleDiff(a: number, b: number) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}
function lerpAngle(a: number, b: number, t: number) {
  return a + angleDiff(a, b) * t;
}
