import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Human } from './Human.ts';

/**
 * A realistic body worn over the Rocketbox rig. The athletes are image-to-3D scans with an
 * auto-rig (24 bones, T-pose); every stroke, step and mocap clip is still computed on the
 * Rocketbox skeleton (PlayerRig's IK, the mixer, replays), which is hidden and drives this body:
 *
 *  1. at load the new body is bent from its T-pose into the Rocketbox bind (A-pose) bone by
 *     bone, turning each limb onto the matching Rocketbox limb's direction;
 *  2. every frame each mapped bone takes the Rocketbox bone's rotation since bind, in the
 *     world:  q_target = q_source · q_source_bind⁻¹ · q_target_aligned;
 *  3. the hips follow the pelvis (scaled by the hip heights), and the paddle — still held by the
 *     hidden Rocketbox hand for the game's contact maths — is drawn shifted onto the new hand.
 */

/** target bone ← Rocketbox bone, parents first; `to` names the child each direction is measured toward */
const MAP: [string, string, string | null, string | null][] = [
  ['Hips', 'Bip01_Pelvis', null, null],
  ['Spine02', 'Bip01_Spine', 'Spine01', 'Bip01_Spine1'],
  ['Spine01', 'Bip01_Spine1', 'Spine', 'Bip01_Spine2'],
  ['Spine', 'Bip01_Spine2', 'neck', 'Bip01_Neck'],
  ['neck', 'Bip01_Neck', 'Head', 'Bip01_Head'],
  ['Head', 'Bip01_Head', null, null],
  ['LeftShoulder', 'Bip01_L_Clavicle', 'LeftArm', 'Bip01_L_UpperArm'],
  ['LeftArm', 'Bip01_L_UpperArm', 'LeftForeArm', 'Bip01_L_Forearm'],
  ['LeftForeArm', 'Bip01_L_Forearm', 'LeftHand', 'Bip01_L_Hand'],
  ['LeftHand', 'Bip01_L_Hand', null, null],
  ['RightShoulder', 'Bip01_R_Clavicle', 'RightArm', 'Bip01_R_UpperArm'],
  ['RightArm', 'Bip01_R_UpperArm', 'RightForeArm', 'Bip01_R_Forearm'],
  ['RightForeArm', 'Bip01_R_Forearm', 'RightHand', 'Bip01_R_Hand'],
  ['RightHand', 'Bip01_R_Hand', null, null],
  ['LeftUpLeg', 'Bip01_L_Thigh', 'LeftLeg', 'Bip01_L_Calf'],
  ['LeftLeg', 'Bip01_L_Calf', 'LeftFoot', 'Bip01_L_Foot'],
  ['LeftFoot', 'Bip01_L_Foot', 'LeftToeBase', 'Bip01_L_Toe0'],
  ['LeftToeBase', 'Bip01_L_Toe0', null, null],
  ['RightUpLeg', 'Bip01_R_Thigh', 'RightLeg', 'Bip01_R_Calf'],
  ['RightLeg', 'Bip01_R_Calf', 'RightFoot', 'Bip01_R_Foot'],
  ['RightFoot', 'Bip01_R_Foot', 'RightToeBase', 'Bip01_R_Toe0'],
  ['RightToeBase', 'Bip01_R_Toe0', null, null],
];

const cache = new Map<string, Promise<THREE.Group>>();
function load(url: string): Promise<THREE.Group> {
  let p = cache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => g.scene);
    cache.set(url, p);
  }
  return p;
}

/** a shirt colour swap: the scan's orange shirt turned to another hue (keeps the fabric's shading) */
export interface BodyLook {
  url: string;
  /** target hue (0..1) for the shirt, or null to keep it */
  shirtHue: number | null;
  shirtSat?: number;
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Puppet {
  readonly root: THREE.Group;
  private pairs: { t: THREE.Bone; s: THREE.Bone; sBindInv: THREE.Quaternion; tAligned: THREE.Quaternion }[] = [];
  private hips!: THREE.Bone;
  private pelvis: THREE.Bone;
  private hipRatio = 1;
  readonly paddle: THREE.Object3D;
  private tHand!: THREE.Bone;
  private sHand: THREE.Bone;

  static async create(src: Human, srcPaddle: THREE.Object3D, look: BodyLook): Promise<Puppet> {
    const proto = await load(look.url);
    return new Puppet(src, srcPaddle, cloneSkinned(proto) as THREE.Group, look);
  }

  private constructor(readonly src: Human, readonly srcPaddle: THREE.Object3D, scene: THREE.Group, look: BodyLook) {
    this.root = scene;
    this.root.name = 'puppet';
    const tb: Record<string, THREE.Bone> = {};
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) tb[o.name] = o as THREE.Bone;
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.material = bodyMaterial(m.material as THREE.MeshStandardMaterial, look);
      }
    });
    // the Rocketbox rig, still in its bind pose (A-pose), and the new body in its T-pose
    src.root.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    const sb = src.bones;
    this.pelvis = sb.Bip01_Pelvis;
    this.sHand = sb.Bip01_R_Hand;
    this.hips = tb.Hips;
    this.tHand = tb.RightHand;
    this.hipRatio = tb.Hips.getWorldPosition(_v).y / Math.max(0.5, sb.Bip01_Pelvis.getWorldPosition(_w).y);
    // 1. bend the T-pose onto the A-pose, limb by limb (parents first)
    for (const [tn, , tc, sc] of MAP) {
      const t = tb[tn];
      if (!t || !tc || !sc || !tb[tc] || !sb[sc]) continue;
      const sn = MAP.find((r) => r[0] === tn)![1];
      const tDir = tb[tc].getWorldPosition(new THREE.Vector3()).sub(t.getWorldPosition(new THREE.Vector3())).normalize();
      const sDir = sb[sc].getWorldPosition(new THREE.Vector3()).sub(sb[sn].getWorldPosition(new THREE.Vector3())).normalize();
      const turn = new THREE.Quaternion().setFromUnitVectors(tDir, sDir);
      const qw = t.getWorldQuaternion(new THREE.Quaternion());
      setWorldQuat(t, turn.multiply(qw));
      t.updateMatrixWorld(true);
    }
    // 2. remember both binds
    for (const [tn, sn] of MAP) {
      const t = tb[tn], s = sb[sn];
      if (!t || !s) continue;
      this.pairs.push({ t, s, sBindInv: s.getWorldQuaternion(new THREE.Quaternion()).invert(), tAligned: t.getWorldQuaternion(new THREE.Quaternion()) });
    }
    // 3. the paddle the player sees (the original keeps doing the maths, unseen)
    this.paddle = srcPaddle.clone();
    srcPaddle.visible = false;
    this.paddle.matrixAutoUpdate = false;
    // the Rocketbox body is now only a skeleton
    src.body.visible = false;
    src.inner.children.forEach((c) => { if ((c as THREE.SkinnedMesh).isSkinnedMesh) c.visible = false; });
  }

  /** copy the Rocketbox pose onto the body (call after the rig / a replay frame has posed it) */
  update() {
    const src = this.src;
    src.root.updateMatrixWorld(true);
    // the whole body sits where the Rocketbox root is
    this.root.position.copy(src.root.position);
    this.root.quaternion.identity();
    this.root.updateMatrixWorld(true);
    // hips: the pelvis's position, its height scaled to this body's legs
    const pw = this.pelvis.getWorldPosition(_v);
    pw.y *= this.hipRatio;
    this.hips.parent!.worldToLocal(pw);
    this.hips.position.copy(pw);
    for (const p of this.pairs) {
      p.s.getWorldQuaternion(_q);
      _q.multiply(p.sBindInv).multiply(p.tAligned);
      // to local: parent's world rotation⁻¹ · wanted world rotation
      p.t.parent!.getWorldQuaternion(_q2).invert();
      p.t.quaternion.copy(_q2.multiply(_q));
      p.t.updateMatrixWorld(true);
    }
    // the paddle: the hidden hand's grip, moved onto this hand
    this.srcPaddle.updateWorldMatrix(true, false);
    const off = this.tHand.getWorldPosition(_v).sub(this.sHand.getWorldPosition(_w));
    this.paddle.matrix.copy(_m.makeTranslation(off.x, off.y, off.z).multiply(this.srcPaddle.matrixWorld));
    this.paddle.matrixWorld.copy(this.paddle.matrix);
  }
}

function setWorldQuat(o: THREE.Object3D, q: THREE.Quaternion) {
  const pq = o.parent!.getWorldQuaternion(new THREE.Quaternion());
  o.quaternion.copy(pq.invert().multiply(q));
}

/** the scan's own texture, with a shirt colour swap and a little sheen on the fabric */
function bodyMaterial(base: THREE.MeshStandardMaterial, look: BodyLook): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: base.map, roughness: 0.78, metalness: 0, side: THREE.FrontSide });
  if (look.shirtHue === null) return m;
  const hue = look.shirtHue, sat = look.shirtSat ?? 1;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHue = { value: hue };
    sh.uniforms.uSat = { value: sat };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uHue, uSat;
vec3 rgb2hsv( vec3 c ) {
  vec4 K = vec4( 0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0 );
  vec4 p = mix( vec4( c.bg, K.wz ), vec4( c.gb, K.xy ), step( c.b, c.g ) );
  vec4 q = mix( vec4( p.xyw, c.r ), vec4( c.r, p.yzx ), step( p.x, c.r ) );
  float d = q.x - min( q.w, q.y );
  return vec3( abs( q.z + ( q.w - q.y ) / ( 6.0 * d + 1e-10 ) ), d / ( q.x + 1e-10 ), q.x );
}
vec3 hsv2rgb( vec3 c ) {
  vec3 p = abs( fract( c.xxx + vec3( 1.0, 2.0 / 3.0, 1.0 / 3.0 ) ) * 6.0 - 3.0 );
  return c.z * mix( vec3( 1.0 ), clamp( p - 1.0, 0.0, 1.0 ), c.y );
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec3 hsv = rgb2hsv( diffuseColor.rgb );
        // the orange shirt: nearly pure in linear light (s ≈ 0.98); tanned skin stays under ~0.75
        float shirt = smoothstep( 0.84, 0.93, hsv.y ) * smoothstep( 0.0, 0.025, hsv.x ) * smoothstep( 0.13, 0.09, hsv.x ) * smoothstep( 0.05, 0.15, hsv.z );
        vec3 dyed = hsv2rgb( vec3( uHue, hsv.y * uSat, hsv.z * ( uSat < 0.2 ? 1.6 : 1.0 ) ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, dyed, shirt );
      }`);
  };
  m.customProgramCacheKey = () => `puppet-${hue}-${sat}`;
  return m;
}
