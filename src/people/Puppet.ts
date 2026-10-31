import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Human } from './Human.ts';
import { GFX } from '../render/gfx.ts';
import { MeshoptSimplifier } from 'meshoptimizer';

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
/**
 * The TV's GPU skins slowly (every frame each body is skinned twice: itself and its planar
 * shadow): its cut of the scan is simplified again at load, to about a third of the triangles,
 * keeping the texture seams (meshoptimizer collapses edges but never across a UV seam).
 */
async function slim(scene: THREE.Group, keep: number): Promise<THREE.Group> {
  await MeshoptSimplifier.ready;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.geometry.index) return;
    const g = m.geometry;
    const idx = new Uint32Array(g.index!.array as ArrayLike<number>);
    const pa = g.getAttribute('position'), ua = g.getAttribute('uv');
    const pos = new Float32Array(pa.count * 3), uv = new Float32Array(pa.count * 2);
    for (let i = 0; i < pa.count; i++) {
      pos[i * 3] = pa.getX(i); pos[i * 3 + 1] = pa.getY(i); pos[i * 3 + 2] = pa.getZ(i);
      uv[i * 2] = ua ? ua.getX(i) : 0; uv[i * 2 + 1] = ua ? ua.getY(i) : 0;
    }
    // the texture coordinates ride along as attributes: seams may move only where the picture doesn't tear
    const [out] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, uv, 2, [5, 5], null, Math.floor((idx.length * keep) / 3) * 3, 0.06, GFX.seams ? ['Permissive'] : []);
    g.setIndex(new THREE.BufferAttribute(out, 1));
  });
  return scene;
}
function load(url: string): Promise<THREE.Group> {
  let p = cache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => (GFX.lite && GFX.slim > 0 ? slim(g.scene, GFX.slim) : g.scene));
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

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);

export class Puppet {
  readonly root: THREE.Group;
  private pairs: { t: THREE.Bone; s: THREE.Bone; sBindInv: THREE.Quaternion; tAligned: THREE.Quaternion }[] = [];
  private hips!: THREE.Bone;
  private pelvis: THREE.Bone;
  private hipRatio = 1;
  readonly paddle: THREE.Object3D;
  private tHand!: THREE.Bone;
  private tUpper: THREE.Bone | null = null;
  private tFore: THREE.Bone | null = null;
  private sHand: THREE.Bone;
  /** the paddle in this hand's frame: the handle through the closed fist */
  private gripPos = new THREE.Vector3();
  private planar: THREE.SkinnedMesh | null = null;
  private gripQuat = new THREE.Quaternion();
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
    // the TV gets a much lighter cut of the same scan (3.5k triangles, a 512 px texture): its GPU skins slowly
    const proto = await load(GFX.lite ? look.url.replace(/\.glb$/, '_lite.glb') : look.url);
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
    this.tUpper = tb.RightArm ?? null;
    this.tFore = tb.RightForeArm ?? null;
    this.hipRatio = tb.Hips.getWorldPosition(_v).y / Math.max(0.5, sb.Bip01_Pelvis.getWorldPosition(_w).y);
    // headwear: fitted in the scan's own T-pose (head upright, facing +z), then carried by the head bone
    if (tb.Head) this.dress(tb.Head, tb.head_end, look);
    // the scan's T-pose has the palms down: remember the paddle hand's frame there
    const tPoseHand = tb.RightHand?.getWorldQuaternion(new THREE.Quaternion());
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
    // the paddle hand closes around the handle; the paddle sits in that fist
    if (tPoseHand) this.closeHand(scene, tPoseHand, tb.RightHand, tb.RightForeArm);
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
    // the TV: no live shadow map — the body is flattened onto the court along the sun instead
    if (GFX.lite) {
      scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
      if (GFX.planar) scene.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh || this.planar) return;
        const sh = new THREE.SkinnedMesh(m.geometry, planarShadowMaterial());
        sh.bind(m.skeleton, m.bindMatrix);
        sh.frustumCulled = false;
        sh.renderOrder = 1;
        m.parent!.add(sh);
        this.planar = sh;
      });
    }
    // 3. the paddle the player sees (the original keeps doing the maths, unseen)
    this.paddle = srcPaddle.clone();
    if (GFX.lite) this.paddle.traverse((o) => { o.castShadow = false; });
    srcPaddle.visible = false;
    this.paddle.matrixAutoUpdate = false;
    // the Rocketbox body is now only a skeleton
    src.body.visible = false;
    src.inner.children.forEach((c) => { if ((c as THREE.SkinnedMesh).isSkinnedMesh) c.visible = false; });
  }

  /**
   * The scan's hands are open (the auto-rig has no finger bones), so the paddle hand is closed
   * in the mesh: past the knuckles every vertex is wrapped around the handle's axis, keeping its
   * length along the finger and its thickness off the palm — a handshake grip. Done once per
   * shared geometry, in the aligned bind pose; the paddle's frame in the hand is set to match.
   */
  private closeHand(scene: THREE.Group, tPoseHand: THREE.Quaternion, tHand: THREE.Bone, tFore: THREE.Bone | undefined) {
    // the game's paddle at the Rocketbox bind: its shaft and face directions are the stroke maths'
    this.srcPaddle.updateWorldMatrix(true, false);
    const pq = this.srcPaddle.getWorldQuaternion(new THREE.Quaternion());
    const shaft = new THREE.Vector3(0, 1, 0).applyQuaternion(pq);
    const face = new THREE.Vector3(0, 0, 1).applyQuaternion(pq);
    const W = tHand.getWorldPosition(new THREE.Vector3());
    // the limb alignment only turned the hand onto the Rocketbox hand's direction, not its roll:
    // roll it about the forearm line so its palm faces where the Rocketbox palm (the paddle face) does
    {
      const dl = tFore ? W.clone().sub(tFore.getWorldPosition(new THREE.Vector3())).normalize() : null;
      if (dl) {
        const qa = tHand.getWorldQuaternion(new THREE.Quaternion());
        const palmN = new THREE.Vector3(0, -1, 0).applyQuaternion(qa.clone().multiply(tPoseHand.clone().invert()));
        const p0 = palmN.addScaledVector(dl, -palmN.dot(dl)).normalize();
        const f0 = face.clone().addScaledVector(dl, -face.dot(dl)).normalize();
        const ang = Math.atan2(new THREE.Vector3().crossVectors(p0, f0).dot(dl), p0.dot(f0));
        setWorldQuat(tHand, new THREE.Quaternion().setFromAxisAngle(dl, ang).multiply(qa));
        tHand.updateMatrixWorld(true);
      }
    }
    let mesh: THREE.SkinnedMesh | null = null;
    scene.traverse((o) => { if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
    const sm = mesh as THREE.SkinnedMesh | null;
    const hi = sm ? sm.skeleton.bones.indexOf(tHand) : -1;
    if (!sm || hi < 0) return;
    sm.updateMatrixWorld(true);
    sm.skeleton.update();
    const g = sm.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const si = g.getAttribute('skinIndex') as THREE.BufferAttribute, sw = g.getAttribute('skinWeight') as THREE.BufferAttribute;
    // the hand's vertices (mostly on the hand bone), posed
    const idx: number[] = [], world: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) w += sw.getComponent(i, k);
      if (w < 0.6) continue;
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      sm.applyBoneTransform(i, v);
      v.applyMatrix4(sm.matrixWorld);
      idx.push(i);
      world.push(v);
    }
    if (idx.length < 20) return;
    // the hand's frame: fingers along the forearm → hand line, the palm toward the paddle's face side
    const d = tFore ? W.clone().sub(tFore.getWorldPosition(new THREE.Vector3())).normalize() : shaft.clone();
    let along = 0;
    for (const v of world) along = Math.max(along, v.clone().sub(W).dot(d));
    const knuckle = along * 0.5;
    // the palm's surface: the face-side extreme of the palm (wrist → knuckles)
    const palm = new THREE.Vector3();
    let n = 0, deep = -Infinity;
    for (const v of world) {
      const s = v.clone().sub(W).dot(d);
      if (s < along * 0.15 || s > knuckle) continue;
      palm.add(v); n++;
      deep = Math.max(deep, v.clone().sub(W).dot(face));
    }
    if (!n) return;
    palm.divideScalar(n);
    // the handle: along the paddle's shaft, a handle's radius off the palm
    const a = shaft.clone().addScaledVector(d, -shaft.dot(d) * 0.4).normalize();
    // (across the base of the fingers, just short of the knuckles, as a real grip has it)
    const G = palm.clone().addScaledVector(face, deep - palm.clone().sub(W).dot(face) + 0.015);
    G.addScaledVector(d, knuckle - 0.014 - G.clone().sub(W).dot(d));
    // the paddle in the hand's frame (its orientation as the game's paddle has it at bind)
    const hq = tHand.getWorldQuaternion(new THREE.Quaternion());
    const origin = G.clone().addScaledVector(shaft, -0.06);
    this.gripPos.copy(origin.sub(W).applyQuaternion(hq.clone().invert()).divideScalar(this.root.scale.x));
    this.gripQuat.copy(hq.clone().invert().multiply(pq));
    if (g.userData.handClosed) return;
    g.userData.handClosed = true;
    // wrap: the finger direction turns about the handle axis, toward the palm
    const inv = new THREE.Matrix4(), fwdM = new THREE.Matrix4();
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const skinM = new THREE.Matrix4(), tmp = new THREE.Matrix4();
    const bones = sm.skeleton.bones, binv = sm.skeleton.boneInverses;
    // the fingers' mid-line radius about the handle at the knuckles: every vertex of a finger
    // turns by the same angle for the same length, so the finger keeps its section
    const radii: number[] = [];
    for (const v of world) {
      const s = v.clone().sub(W).dot(d) - knuckle;
      if (s < 0 || s > 0.015) continue;
      const rel = v.clone().addScaledVector(d, -s).sub(G);
      radii.push(rel.addScaledVector(a, -rel.dot(a)).length());
    }
    radii.sort((x, y) => x - y);
    const rMid = Math.max(0.02, radii[radii.length >> 1] ?? 0.03);
    const meshInv = sm.matrixWorld.clone().invert();
    for (let j = 0; j < idx.length; j++) {
      const v = world[j];
      const s = v.clone().sub(W).dot(d) - knuckle;
      if (s <= 0) continue;
      const rel0 = v.clone().addScaledVector(d, -s).sub(G);
      const ax = rel0.dot(a);
      const perp = rel0.clone().addScaledVector(a, -ax);
      const r = Math.max(0.012, perp.length());
      // the sense of turning that starts the finger off along d
      const sense = new THREE.Vector3().crossVectors(a, perp).dot(d) > 0 ? 1 : -1;
      // over the first joint the finger closes onto the handle (a radius of handle + half a finger),
      // keeping its own thickness about the mid-line
      const k = Math.min(1, s / 0.03), kk = k * k * (3 - 2 * k);
      const rNow = rMid + (0.027 - rMid) * kk;
      const th = Math.min(3.6, s / (rMid + (0.027 - rMid) * Math.min(1, kk * 0.8)));
      const radial = perp.normalize().multiplyScalar(Math.max(0.017, rNow + (r - rMid)));
      const np = G.clone().addScaledVector(a, ax).add(radial.applyAxisAngle(a, sense * th));
      // back to the geometry's bind space through this vertex's own skinning
      const i = idx[j];
      skinM.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const b = si.getComponent(i, k);
        tmp.multiplyMatrices(bones[b].matrixWorld, binv[b]);
        for (let e = 0; e < 16; e++) skinM.elements[e] += tmp.elements[e] * w;
      }
      // world = matrixWorld · bindMatrixInverse · skin · bindMatrix · v
      fwdM.copy(sm.matrixWorld).multiply(sm.bindMatrixInverse).multiply(skinM).multiply(sm.bindMatrix);
      inv.copy(fwdM).invert();
      np.applyMatrix4(inv);
      pos.setXYZ(i, np.x, np.y, np.z);
      // the normal turns with it
      if (nrm) {
        const nv = new THREE.Vector3().fromBufferAttribute(nrm, i).transformDirection(fwdM).applyAxisAngle(a, sense * th).transformDirection(inv);
        nrm.setXYZ(i, nv.x, nv.y, nv.z);
      }
    }
    pos.needsUpdate = true;
    if (nrm) nrm.needsUpdate = true;
    g.computeBoundingSphere();
    void meshInv;
  }

  /**
   * Copied rotations put this body's hand somewhere near the rig's (the scan's arms and shoulders
   * aren't the rig's), and the game's contact maths is the rig's paddle. So the arm is solved
   * again: two-bone IK from this shoulder to the hand frame that holds the paddle exactly where the
   * game has it, the elbow kept on the side the copied pose bent it to.
   */
  private reachPaddle() {
    const up = this.tUpper, fo = this.tFore, hd = this.tHand;
    if (!up || !fo) return;
    this.srcPaddle.updateWorldMatrix(true, false);
    this.srcPaddle.matrixWorld.decompose(_pp, _pq, _ps);
    // the hand frame that puts this fist's paddle on the game's
    const qHand = _qh.copy(_pq).multiply(_gi.copy(this.gripQuat).invert());
    const target = _tg.copy(_pp).sub(_w.copy(this.gripPos).multiplyScalar(this.scale).applyQuaternion(qHand));
    const S = up.getWorldPosition(_s), E = fo.getWorldPosition(_e), H = hd.getWorldPosition(_h);
    const a = S.distanceTo(E), b = E.distanceTo(H);
    const toT = _d.copy(target).sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
    toT.normalize();
    // the bend plane: where the copied elbow points, off the shoulder→hand line
    const pole = _pole.copy(E).sub(S);
    pole.addScaledVector(toT, -pole.dot(toT));
    if (pole.lengthSq() < 1e-6) pole.set(0, -1, 0).addScaledVector(toT, -toT.y);
    pole.normalize();
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const elbow = _el.copy(S).addScaledVector(toT, a * cosA).addScaledVector(pole, a * Math.sqrt(1 - cosA * cosA));
    // upper arm onto the new elbow, forearm onto the target, then the hand's turn
    turnTo(up, S, E, elbow);
    const E2 = fo.getWorldPosition(_e), H2 = hd.getWorldPosition(_h);
    turnTo(fo, E2, H2, target);
    setWorldQuat(hd, qHand);
    hd.updateWorldMatrix(true, true);
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
      // (the source skeleton is fresh from the update above: read it as it stands)
      p.s.matrixWorld.decompose(_dp, _q, _ds);
      _q.multiply(p.sBindInv).multiply(p.tAligned);
      // to local: parent's world rotation⁻¹ · wanted world rotation
      p.t.parent!.getWorldQuaternion(_q2).invert();
      p.t.quaternion.copy(_q2.multiply(_q));
      // just this bone: the next one's parent query refreshes its own chain, and the scene's
      // pass before drawing refreshes the rest (a subtree update per bone was most of the cost)
      p.t.updateWorldMatrix(false, false);
    }
    // the arm reaches for the game's paddle: this body's arms aren't the rig's length
    this.reachPaddle();
    // the paddle: in this hand's fist, turned as the hidden hand turns the game's paddle
    const hq = this.tHand.getWorldQuaternion(_q);
    const hp = this.tHand.getWorldPosition(_v).add(_w.copy(this.gripPos).multiplyScalar(this.scale).applyQuaternion(hq));
    this.paddle.matrix.compose(hp, _q2.copy(hq).multiply(this.gripQuat), _one);
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

const _pp = new THREE.Vector3(), _pq = new THREE.Quaternion(), _ps = new THREE.Vector3(), _qh = new THREE.Quaternion(), _gi = new THREE.Quaternion();
const _tg = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Vector3(), _h = new THREE.Vector3(), _d = new THREE.Vector3(), _pole = new THREE.Vector3(), _el = new THREE.Vector3();
const _dp = new THREE.Vector3(), _ds = new THREE.Vector3();
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3(), _tq = new THREE.Quaternion(), _wq = new THREE.Quaternion();
/** turn a bone (about its own origin `o`) so its child at `from` swings onto `to` */
function turnTo(bone: THREE.Object3D, o: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3) {
  _a1.copy(from).sub(o).normalize();
  _a2.copy(to).sub(o).normalize();
  if (_a1.lengthSq() < 1e-8 || _a2.lengthSq() < 1e-8) return;
  _tq.setFromUnitVectors(_a1, _a2);
  bone.getWorldQuaternion(_wq);
  setWorldQuat(bone, _tq.multiply(_wq));
  bone.updateWorldMatrix(true, false);
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

/** the direction the sunlight travels (down toward the ground): set by the world's sky */
export const SUN_RAY = new THREE.Vector3(-0.5, -0.6, 0.6).normalize();
let planarMat: THREE.MeshBasicMaterial | null = null;
const uRay = { value: SUN_RAY };
/**
 * A body's shadow without a shadow map: the skinned body drawn again with every vertex slid along
 * the sunlight onto the court. All of it lands on one plane, so with depth writes on the overlapping
 * parts can't darken twice (the second fragment at the same depth fails the test).
 */
function planarShadowMaterial(): THREE.MeshBasicMaterial {
  if (planarMat) return planarMat;
  const m = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: true, toneMapped: false });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRay = uRay;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uRay;')
      .replace('#include <project_vertex>', /* glsl */ `
        vec4 wp = modelMatrix * vec4( transformed, 1.0 );
        wp.xyz -= uRay * ( ( wp.y - 0.007 ) / min( uRay.y, -0.05 ) );
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  m.customProgramCacheKey = () => 'planar-shadow';
  planarMat = m;
  return m;
}
