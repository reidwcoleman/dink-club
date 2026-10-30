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

/**
 * Who this player is, on the shared scan: shirt and shorts colours (the scan's fabric shading
 * kept), skin tone, height, and what they wear on their head — caps, visors, headbands and
 * sunglasses are what a club's players actually look like from across a court.
 */
export interface BodyLook {
  url: string;
  /** target hue (0..1) for the shirt, or null to keep it */
  shirtHue: number | null;
  shirtSat?: number;
  /** shorts colour (sRGB hex), or null to keep the navy */
  shorts?: string | null;
  /** skin multiplier (linear rgb); [1,1,1] keeps the scan's tan */
  skin?: [number, number, number];
  /** standing height relative to the scan (1.70 m) */
  height?: number;
  hat?: 'cap' | 'capBack' | 'visor' | 'band' | null;
  hatColor?: string;
  glasses?: boolean;
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
  private scale = 1;

  /** caps, visors, headbands, sunglasses: built in the world at the bind pose, then parented to the head */
  private dress(head: THREE.Bone, top: THREE.Bone | undefined, look: BodyLook) {
    this.root.updateMatrixWorld(true);
    const hp = head.getWorldPosition(new THREE.Vector3());
    const tp = top ? top.getWorldPosition(new THREE.Vector3()) : hp.clone().add(new THREE.Vector3(0, 0.21, 0));
    this.root.worldToLocal(hp);
    this.root.worldToLocal(tp);
    // the skull: centre a little below the crown, a touch forward of the head joint
    const R = 0.098;
    const c = new THREE.Vector3(hp.x, tp.y - R * 1.02, hp.z + 0.03);
    const g = new THREE.Group();
    const col = new THREE.Color(look.hatColor ?? '#f2f2ee');
    const fabric = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.55), roughness: 0.7 });
    const hat = look.hat ?? null;
    if (hat === 'cap' || hat === 'capBack') {
      const crown = new THREE.Mesh(new THREE.SphereGeometry(R * 1.06, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.52), fabric);
      crown.scale.set(1, 0.9, 1.08);
      crown.position.set(0, R * 0.3, -R * 0.04);
      const bill = new THREE.Mesh(billGeo(R * 0.95, R * 0.85), dark);
      bill.position.set(0, R * 0.36, R * 0.92);
      const button = new THREE.Mesh(new THREE.SphereGeometry(R * 0.08, 8, 6), fabric);
      button.position.set(0, R * 1.24, -R * 0.04);
      g.add(crown, bill, button);
      if (hat === 'capBack') g.rotation.y = Math.PI;
    } else if (hat === 'visor') {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.04, R * 1.06, R * 0.42, 28, 1, true), fabric);
      band.position.y = R * 0.5;
      const bill = new THREE.Mesh(billGeo(R * 1.05, R * 1.0), dark);
      bill.position.set(0, R * 0.36, R * 0.98);
      g.add(band, bill);
    } else if (hat === 'band') {
      const band = new THREE.Mesh(new THREE.TorusGeometry(R * 1.03, R * 0.16, 8, 32), fabric);
      band.rotation.x = Math.PI / 2;
      band.position.y = R * 0.55;
      g.add(band);
    }
    if (look.glasses) {
      const lens = new THREE.MeshPhysicalMaterial({ color: 0x111418, roughness: 0.05, metalness: 0.6, clearcoat: 1 });
      const frame = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 });
      for (const sx of [-1, 1]) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(R * 0.27, 16, 10), lens);
        l.scale.set(1.15, 0.72, 0.35);
        l.position.set(sx * R * 0.34, -R * 0.02, R * 0.96);
        g.add(l);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(R * 0.04, R * 0.05, R * 0.95), frame);
        arm.position.set(sx * R * 0.84, R * 0.02, R * 0.46);
        g.add(arm);
      }
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(R * 0.2, R * 0.04, R * 0.04), frame);
      bridge.position.set(0, R * 0.04, R * 1.02);
      g.add(bridge);
    }
    if (!g.children.length) return;
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // a head is narrower than it is deep
    g.scale.set(0.84, 1, 0.98);
    g.position.copy(c);
    this.root.add(g);
    g.updateMatrixWorld(true);
    head.attach(g);
  }

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
    // headwear: fitted in the scan's own T-pose (head upright, facing +z), then carried by the head bone
    if (tb.Head) this.dress(tb.Head, tb.head_end, look);
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
    // standing height
    this.scale = look.height ?? 1;
    this.root.scale.setScalar(this.scale);
    this.hipRatio *= this.scale;
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

/** a cap's bill: a curved, slightly drooping half-disc in front of the brow */
function billGeo(w: number, d: number): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(1, 24, 0, Math.PI);
  g.rotateX(-Math.PI / 2);
  const pa = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), z = -pa.getZ(i);
    pa.setXYZ(i, x * w, -z * z * d * 0.18 - Math.abs(x) * d * 0.08, z * d * 0.75);
  }
  g.computeVertexNormals();
  const back = g.clone();
  back.scale(1, 1, 1).translate(0, -0.006, 0);
  const idx = back.index!;
  for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i); idx.setX(i, idx.getX(i + 1)); idx.setX(i + 1, a); }
  return mergeTwo(g, back);
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pa = a.getAttribute('position').array as Float32Array, pb = b.getAttribute('position').array as Float32Array;
  const pos = new Float32Array(pa.length + pb.length);
  pos.set(pa); pos.set(pb, pa.length);
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const n = pa.length / 3;
  const ia = Array.from(a.index!.array), ib = Array.from(b.index!.array).map((x) => x + n);
  out.setIndex([...ia, ...ib]);
  out.computeVertexNormals();
  return out;
}

function setWorldQuat(o: THREE.Object3D, q: THREE.Quaternion) {
  const pq = o.parent!.getWorldQuaternion(new THREE.Quaternion());
  o.quaternion.copy(pq.invert().multiply(q));
}

/** the scan's own texture, with a shirt colour swap and a little sheen on the fabric */
function bodyMaterial(base: THREE.MeshStandardMaterial, look: BodyLook): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: base.map, roughness: 0.74, metalness: 0, side: THREE.FrontSide });
  const hue = look.shirtHue ?? -1, sat = look.shirtSat ?? 1;
  const skin = new THREE.Vector3(...(look.skin ?? [1, 1, 1]));
  const shorts = look.shorts ? new THREE.Color(look.shorts) : null;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHue = { value: hue };
    sh.uniforms.uSat = { value: sat };
    sh.uniforms.uSkin = { value: skin };
    sh.uniforms.uShorts = { value: shorts ?? new THREE.Color(0, 0, 0) };
    sh.uniforms.uShortsOn = { value: shorts ? 1 : 0 };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uHue, uSat, uShortsOn;
uniform vec3 uSkin, uShorts;
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
        vec3 dyed = hsv2rgb( vec3( uHue, hsv.y * uSat, hsv.z * ( uSat < 0.2 ? 0.9 : 1.0 ) ) );
        if ( uHue >= 0.0 ) diffuseColor.rgb = mix( diffuseColor.rgb, dyed, shirt );
        // skin: warm, mid saturation (the shirt is purer, the shorts blue, the shoes white)
        float skinK = ( 1.0 - shirt ) * smoothstep( 0.2, 0.36, hsv.y ) * smoothstep( 0.86, 0.78, hsv.y ) * smoothstep( 0.13, 0.08, hsv.x ) * smoothstep( 0.03, 0.08, hsv.z );
        vec3 toned = diffuseColor.rgb * uSkin;
        // darker skin is also a little more saturated and warmer
        toned = mix( vec3( dot( toned, vec3( 0.2126, 0.7152, 0.0722 ) ) ), toned, 1.0 + ( 1.0 - uSkin.g ) * 0.25 );
        diffuseColor.rgb = mix( diffuseColor.rgb, toned, skinK );
        // the navy shorts: blue hue, dark
        float sh = uShortsOn * smoothstep( 0.55, 0.58, hsv.x ) * smoothstep( 0.72, 0.68, hsv.x ) * smoothstep( 0.35, 0.55, hsv.y ) * smoothstep( 0.4, 0.2, hsv.z );
        float lum = hsv.z / 0.09;
        diffuseColor.rgb = mix( diffuseColor.rgb, uShorts * clamp( lum, 0.35, 1.6 ), sh );
      }`);
  };
  m.customProgramCacheKey = () => `puppet-${hue}-${sat}-${skin.toArray().join(',')}-${look.shorts ?? ''}`;
  return m;
}
