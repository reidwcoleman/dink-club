import * as THREE from 'three';
import { loadAvatar, loadAnims, type RbAvatar, type RbClips } from './rocketbox.ts';
import { LIGHT_GLOBALS, peopleLightsChunk, CLOTH_WHITE_MAX, NOISE_GLSL } from './shading.ts';

/**
 * A person on a Microsoft Rocketbox avatar (MIT): a skinned mesh in the bind pose, the
 * library's own mocap clips through an AnimationMixer, and procedural layers on top (the
 * PlayerRig poses strokes after the mixer runs).
 *
 * The body material splices skin lighting (wrapped diffuse, a second specular lobe) and
 * Kajiya-Kay hair into three's physical model (shading.ts, from ApexGP), and can re-dye the
 * clothes into a tennis kit: top, shorts, socks and shoes found from the cloth mask and the
 * bind-pose body part, the new colour carrying the fabric's folds but not its prints.
 */

export interface Outfit {
  top?: THREE.ColorRepresentation | null;
  shorts?: THREE.ColorRepresentation | null;
  socks?: THREE.ColorRepresentation | null;
  shoes?: THREE.ColorRepresentation | null;
  /** a second top colour for side panels / trims */
  trim?: THREE.ColorRepresentation | null;
}

/** body part of a bone (as rbconvert.ts): 0 head, 1 neck, 2 torso, 3 upper arm, 4 forearm, 5 hand, 6 thigh, 7 calf, 8 foot */
export function partOf(name: string): number {
  if (/Head|Eye/.test(name)) return 0;
  if (/Neck/.test(name)) return 1;
  if (/UpperArm/.test(name)) return 3;
  if (/Forearm/.test(name)) return 4;
  if (/Hand|Finger/.test(name)) return 5;
  if (/Thigh/.test(name)) return 6;
  if (/Calf/.test(name)) return 7;
  if (/Foot|Toe/.test(name)) return 8;
  return 2;
}

export interface Landmarks {
  waistY: number;
  neckY: number;
  kneeY: number;
  ankleY: number;
  height: number;
}

interface Kit {
  av: RbAvatar;
  geo: THREE.BufferGeometry;
  hair: THREE.BufferGeometry | null;
  lm: Landmarks;
  skinRef: THREE.Color;
  shirtMean: THREE.Color;
}

const kits = new Map<string, Promise<Kit>>();

/** load an avatar and derive what the material needs (cached per avatar) */
export function loadKit(name: string): Promise<Kit> {
  let p = kits.get(name);
  if (!p) {
    p = (async () => {
      const av = await loadAvatar(name);
      const geo = av.skin.clone();
      // aPart: the body part of each vertex's strongest bone
      const si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
      const part = new Float32Array(si.count);
      for (let i = 0; i < si.count; i++) {
        let best = 0, bw = -1;
        for (let c = 0; c < 4; c++) if (sw.getComponent(i, c) > bw) { bw = sw.getComponent(i, c); best = si.getComponent(i, c); }
        part[i] = partOf(av.names[best]);
      }
      geo.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
      const y = (n: string) => av.bindW[av.names.indexOf(n)].elements[13];
      const bb = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute);
      const lm: Landmarks = {
        waistY: y('Bip01_Pelvis') + 0.07,
        neckY: y('Bip01_Neck'),
        kneeY: y('Bip01_L_Calf'),
        ankleY: y('Bip01_L_Foot'),
        height: bb.max.y,
      };
      const m = av.meta;
      return {
        av, geo, hair: av.hair, lm,
        skinRef: new THREE.Color(m.skin[0], m.skin[1], m.skin[2]),
        shirtMean: new THREE.Color(m.shirt[0], m.shirt[1], m.shirt[2]),
      };
    })();
    kits.set(name, p);
  }
  return p;
}

const clipsP = new Map<string, Promise<RbClips>>();
export function clipsFor(female: boolean): Promise<RbClips> {
  const g = female ? 'f' : 'm';
  let p = clipsP.get(g);
  if (!p) clipsP.set(g, (p = loadAnims(g)));
  return p;
}

const BODY_GLSL = /* glsl */ `
const vec3 RB_LUM = vec3( 0.2126, 0.7152, 0.0722 );
float rbSkinLike( vec3 c, vec3 ref ) {
  float s = dot( c, vec3( 1.0 ) ) + 1e-3, r = dot( ref, vec3( 1.0 ) ) + 1e-3;
  vec2 dc = c.rg / s - ref.rg / r;
  float dl = abs( log( s / r ) );
  return 1.0 - smoothstep( 0.05, 0.11, length( dc ) ) * 0.9 - smoothstep( 0.9, 1.6, dl ) * 0.8;
}
`;

/** the skin + clothes material */
export function bodyMaterial(kit: Kit, outfit: Outfit): THREE.MeshPhysicalMaterial {
  const av = kit.av;
  const mat = new THREE.MeshPhysicalMaterial({
    name: 'person-body',
    map: av.map,
    normalMap: av.normal,
    roughness: 1,
    metalness: 0,
    ior: 1.4,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(1, 1, 1),
  });
  const col = (c: THREE.ColorRepresentation | null | undefined, fallback = -1) => (c == null ? new THREE.Vector4(0, 0, 0, fallback) : (() => {
    const k = new THREE.Color(c);
    return new THREE.Vector4(k.r, k.g, k.b, 1);
  })());
  const u = {
    uMask: { value: av.mask },
    uTop: { value: col(outfit.top) },
    uTrim: { value: col(outfit.trim ?? outfit.top) },
    uShorts: { value: col(outfit.shorts) },
    uSocks: { value: col(outfit.socks) },
    uShoes: { value: col(outfit.shoes) },
    uLm: { value: new THREE.Vector4(kit.lm.waistY, kit.lm.neckY, kit.lm.kneeY, kit.lm.ankleY) },
    uSkinRef: { value: kit.skinRef },
    uWet: { value: 0 },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart;
varying vec3 vRest; varying vec3 vRestN; varying float vPart;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRest = position; vRestN = normal; vPart = aPart;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uMask;
uniform vec4 uTop, uTrim, uShorts, uSocks, uShoes, uLm;
uniform vec3 uSkinRef;
uniform float uWet;
varying vec3 vRest; varying vec3 vRestN; varying float vPart;
float gRough; float gSheen; vec4 gNS; float gNScale;
${LIGHT_GLOBALS}
${NOISE_GLSL}
${BODY_GLSL}`)
      .replace('#include <lights_physical_pars_fragment>', peopleLightsChunk())
      .replace('#include <map_fragment>', /* glsl */ `
{
  vec2 uv = vMapUv;
  vec4 a = texture2D( map, uv );
  vec4 ns = texture2D( normalMap, uv );
  gNS = ns;
  bool bodyHalf = uv.x < 0.5;
  float cloth = bodyHalf ? texture2D( uMask, uv ).r : 0.0;
  float part = floor( vPart + 0.5 );
  vec3 col = a.rgb;
  gRough = mix( 0.88, 0.5, ns.b );
  gNScale = 1.0;
  // fabric folds without prints or stripes: a clamped ratio of two blur levels
  vec3 m3 = texture2D( map, uv, 3.0 ).rgb, m6 = texture2D( map, uv, 6.5 ).rgb;
  float det = clamp( ( dot( m3, RB_LUM ) + 0.004 ) / ( dot( m6, RB_LUM ) + 0.004 ), 0.8, 1.15 );
  float fine = clamp( ( dot( a.rgb, RB_LUM ) + 0.004 ) / ( dot( m3, RB_LUM ) + 0.004 ), 0.85, 1.12 );
  vec4 dye = vec4( 0.0 );
  float y = vRest.y;
  if ( bodyHalf && ( cloth > 0.05 || part > 7.5 ) ) {
    if ( part > 7.5 ) dye = uShoes;
    else if ( part > 6.5 ) dye = y < uLm.z - 0.02 ? uSocks : uShorts;
    else if ( part > 5.5 ) dye = uShorts;
    else if ( part > 4.5 ) dye = vec4( 0.0 );
    else if ( part > 1.5 && y < uLm.x - 0.02 ) dye = uShorts;
    else if ( part > 1.5 ) dye = abs( vRestN.x ) > 0.75 && part < 2.5 ? uTrim : uTop;
  }
  if ( dye.w > 0.5 ) {
    float k = part > 7.5 ? max( cloth, 0.75 ) : cloth;
    vec3 dc = min( dye.rgb * det * fine, vec3( ${CLOTH_WHITE_MAX.toFixed(2)} ) );
    col = mix( col, dc, k );
    gRough = mix( gRough, part > 7.5 ? 0.55 : 0.8, k );
  }
  // real white fabric reflects ~60 %: cap the cloth, and damp its sheen on light colours
  float wl = dot( col, RB_LUM );
  col = mix( col, col * min( 1.0, ${CLOTH_WHITE_MAX.toFixed(2)} * 0.75 / max( wl, 1e-3 ) ), cloth );
  gSheen = cloth * mix( 0.4, 0.05, smoothstep( 0.35, 0.7, wl ) );
  diffuseColor.rgb *= col;
  gSkin = ( 1.0 - cloth ) * clamp( rbSkinLike( a.rgb, uSkinRef ), 0.0, 1.0 );
  // sweat: skin gets glossier as the match goes on
  gRough = mix( gRough, gRough * 0.62, uWet * gSkin );
}`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', `vec3 mapN = vec3( ( gNS.xy * 2.0 - 1.0 ) * gNScale, 0.0 );
mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`))
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
material.sheenColor = ( diffuseColor.rgb * 0.6 + 0.05 ) * gSheen;`);
  };
  mat.customProgramCacheKey = () => 'cc-person-v1';
  return mat;
}

export function hairMaterial(map: THREE.Texture, soft: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map, roughness: 0.55, metalness: 0, side: THREE.DoubleSide,
    alphaTest: soft ? 0.02 : 0.5, transparent: soft, depthWrite: !soft,
    name: soft ? 'person-hair-soft' : 'person-hair',
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${LIGHT_GLOBALS}`)
      .replace('#include <lights_physical_pars_fragment>', peopleLightsChunk())
      .replace('#include <alphatest_fragment>', soft ? `if ( diffuseColor.a >= 0.5 || diffuseColor.a < 0.03 ) discard;` : '#include <alphatest_fragment>')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 q0 = dFdx( - vViewPosition ), q1 = dFdy( - vViewPosition );
  vec2 s0 = dFdx( vMapUv ), s1 = dFdy( vMapUv );
  vec3 T = q0 * s1.y - q1 * s0.y;
  T = T - normal * dot( T, normal );
  gHairT = dot( T, T ) > 1e-12 ? normalize( T ) : vec3( 0.0, 1.0, 0.0 );
  gHair = 1.0;
  gHairTint = diffuseColor.rgb * 1.3;
  gHairShift = 0.0;
}`);
  };
  m.customProgramCacheKey = () => `cc-hair-v1${soft ? '-soft' : ''}`;
  return m;
}

/** three sorts / culls skinned meshes by the bind pose's bounds: make them generous and static */
export function bindPoseBounds(m: THREE.SkinnedMesh) {
  m.geometry.computeBoundingSphere();
  const s = m.geometry.boundingSphere!.clone();
  s.radius += 1.2;
  m.boundingSphere = s;
  m.computeBoundingSphere = () => void 0;
  m.boundingBox = new THREE.Box3().setFromCenterAndSize(s.center, new THREE.Vector3(1, 1, 1).multiplyScalar(s.radius * 2));
  m.computeBoundingBox = () => void 0;
  return m;
}

export class Human {
  readonly root = new THREE.Group();
  readonly inner = new THREE.Group();
  readonly body: THREE.SkinnedMesh;
  readonly skeleton: THREE.Skeleton;
  readonly bones: Record<string, THREE.Bone> = {};
  readonly mixer: THREE.AnimationMixer;
  readonly material: THREE.MeshPhysicalMaterial;
  readonly lm: Landmarks;
  readonly female: boolean;
  private actions = new Map<string, THREE.AnimationAction>();
  current: THREE.AnimationAction | null = null;
  currentName = '';
  /** keep the lowest foot on the floor after the pose (off for jumps) */
  grounded = true;
  private rootRest: THREE.Vector3;
  private feet: THREE.Bone[];
  private restFoot = 0;
  private blinkAt = 1;
  private life = Math.random() * 10;
  private lids: [THREE.Bone, THREE.Quaternion, THREE.Vector3][] = [];

  static async create(avatar: string, outfit: Outfit = {}): Promise<Human> {
    const kit = await loadKit(avatar);
    const clips = await clipsFor(kit.av.meta.female);
    return new Human(kit, clips, outfit);
  }

  constructor(readonly kit: Kit, readonly clips: RbClips, outfit: Outfit) {
    const av = kit.av;
    this.lm = kit.lm;
    this.female = av.meta.female;
    this.root.name = 'human-' + av.meta.name;
    this.root.add(this.inner);
    const bones = av.names.map((n, i) => {
      const b = new THREE.Bone();
      b.name = n;
      b.position.copy(av.local[i].p);
      b.quaternion.copy(av.local[i].q);
      return b;
    });
    av.parents.forEach((p, i) => (p >= 0 ? bones[p].add(bones[i]) : this.inner.add(bones[i])));
    for (const b of bones) this.bones[b.name] = b;
    this.skeleton = new THREE.Skeleton(bones, av.boneInverses);
    this.rootRest = bones[0].position.clone();
    this.material = bodyMaterial(kit, outfit);
    this.body = new THREE.SkinnedMesh(kit.geo, this.material);
    this.body.bind(this.skeleton, new THREE.Matrix4());
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.body.frustumCulled = false;
    bindPoseBounds(this.body);
    this.inner.add(this.body);
    if (kit.hair && av.hairMap) {
      for (const soft of [false, true]) {
        const hm = new THREE.SkinnedMesh(kit.hair, hairMaterial(av.hairMap, soft));
        hm.bind(this.skeleton, new THREE.Matrix4());
        hm.castShadow = !soft;
        hm.receiveShadow = true;
        hm.frustumCulled = false;
        if (soft) hm.renderOrder = 2;
        else hm.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: av.hairMap, alphaTest: 0.5 });
        bindPoseBounds(hm);
        this.inner.add(hm);
      }
    }
    this.mixer = new THREE.AnimationMixer(this.inner);
    this.feet = ['Bip01_L_Foot', 'Bip01_R_Foot', 'Bip01_L_Toe0', 'Bip01_R_Toe0'].map((n) => this.bones[n]).filter(Boolean);
    this.inner.updateMatrixWorld(true);
    this.restFoot = this.lowestFoot() - this.inner.getWorldPosition(new THREE.Vector3()).y;
    const q = new THREE.Quaternion();
    for (const n of ['Bip01_LEyeBlinkTop', 'Bip01_REyeBlinkTop']) {
      const lb = this.bones[n];
      if (!lb) continue;
      lb.getWorldQuaternion(q).invert();
      this.lids.push([lb, lb.quaternion.clone(), new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize()]);
    }
  }

  /** a clip with the root track offset to this body's rest (and scaled to its size) */
  private clipCache = new Map<string, THREE.AnimationClip>();
  clip(name: string): THREE.AnimationClip | null {
    let c = this.clipCache.get(name);
    if (c) return c;
    const src = this.clips.clips.get(name);
    if (!src) return null;
    const rest = this.rootRest;
    const k = rest.y / 0.9;
    const tracks = src.tracks.map((t) => {
      if (t.name !== 'Bip01.position') return t;
      const v = t.values.slice();
      for (let i = 0; i < v.length; i += 3) {
        v[i] = rest.x + v[i] * k;
        v[i + 1] = rest.y + v[i + 1] * k;
        v[i + 2] = rest.z + v[i + 2] * k;
      }
      return new THREE.VectorKeyframeTrack(t.name, t.times, v);
    });
    c = new THREE.AnimationClip(src.name, src.duration, tracks);
    this.clipCache.set(name, c);
    return c;
  }

  action(name: string): THREE.AnimationAction | null {
    let a = this.actions.get(name);
    if (!a) {
      const c = this.clip(name);
      if (!c) return null;
      a = this.mixer.clipAction(c);
      this.actions.set(name, a);
    }
    return a;
  }

  play(name: string, opts: { fade?: number; speed?: number; offset?: number; once?: boolean } = {}) {
    const a = this.action(name);
    if (!a || a === this.current) return;
    a.reset();
    a.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = !!opts.once;
    a.timeScale = opts.speed ?? 1;
    a.time = (opts.offset ?? 0) * a.getClip().duration;
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    if (this.current) a.crossFadeFrom(this.current, opts.fade ?? 0.35, false);
    this.current = a;
    this.currentName = name;
  }

  /** the mixer, then the blink */
  animate(dt: number) {
    this.mixer.update(dt);
    this.life += dt;
    const t = this.life;
    if (t > this.blinkAt + 0.18) this.blinkAt = t + 2 + ((Math.sin(t * 91.7) + 1) / 2) * 4;
    const k = (t - this.blinkAt) / 0.16;
    const shut = k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0;
    for (const [lb, rest, ax] of this.lids) {
      lb.quaternion.copy(rest);
      if (shut > 0) lb.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(ax, shut * 0.55));
    }
  }

  /** bring the lowest foot to the floor (never lifted: a jump stays a jump) */
  ground(allowLift = false) {
    this.inner.position.y = 0;
    this.root.updateMatrixWorld(true);
    if (!this.grounded || !this.feet.length) return;
    const lift = this.lowestFoot() - this.inner.getWorldPosition(this.v).y - this.restFoot;
    if (lift > 0.004 || allowLift) this.inner.position.y = -lift;
    this.root.updateMatrixWorld(true);
  }

  private v = new THREE.Vector3();
  private lowestFoot(): number {
    let lo = Infinity;
    for (const b of this.feet) lo = Math.min(lo, b.getWorldPosition(this.v).y);
    return lo;
  }

  worldOf(bone: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bones[bone].getWorldPosition(out);
  }
}
