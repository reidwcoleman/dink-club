import * as THREE from 'three';
import { Human, loadKit } from './Human.ts';
import type { SeatSpot } from '../world/Club.ts';
import { rng } from '../render/noise.ts';

/**
 * The crowd as lit impostors. At load, real Rocketbox spectators are posed (seated idle,
 * seated clapping — the sitting clip's legs under the clapping clip's arms — and standing
 * cheers) and rendered from three yaw angles into two atlases: albedo + coverage, and the
 * capture-space normal + shirt mask. Each seat then gets a camera-facing quad on a
 * MeshStandardMaterial: the baked normal is the quad's tangent-space normal map, so the
 * sun, the roof's shadow and the stadium's environment light the crowd like everything
 * else, and every fan's shirt is re-dyed from a palette.
 */

export const FRAMES = 8; // 0-1 seated idle, 2-5 clapping, 6-7 standing cheer
/** baked yaw angles (mirrored for the other side) and elevations (from below, level, from above) */
const VIEWS = [0, 35, 70];
const ELEVS = [-22, 0, 28];
const CELL_W = 48, CELL_H = 96, ATLAS = 2048;
const BOX_W = 1.05, BOX_H = 2.1;
/** the impostor's pivot above the floor (the capture looks at it) */
const PIVOT = 1.0;

const MALE = ['Male_Adult_01', 'Male_Adult_02', 'Male_Adult_03', 'Male_Adult_05', 'Male_Adult_08', 'Male_Adult_10', 'Male_Adult_14'];
const FEMALE = ['Female_Adult_01', 'Female_Adult_02', 'Female_Adult_04', 'Female_Adult_06', 'Female_Adult_11'];

const LOWER = /Pelvis|Thigh|Calf|Foot|Toe/;

export class Crowd {
  readonly mesh: THREE.Mesh;
  private color!: THREE.WebGLRenderTarget;
  private normal!: THREE.WebGLRenderTarget;
  private geo!: THREE.InstancedBufferGeometry;
  private mode!: THREE.InstancedBufferAttribute;
  private material!: THREE.MeshLambertMaterial;
  readonly uniforms = {
    uColorAtlas: { value: null as THREE.Texture | null },
    uNormalAtlas: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uAvatars: { value: 1 },
    uFlash: { value: 0 },
  };
  count = 0;
  avatars = 0;
  private seats: SeatSpot[] = [];
  private modes!: Float32Array;
  private excite = 0;

  constructor() {
    this.mesh = new THREE.Mesh();
    this.mesh.name = 'crowd';
    this.mesh.frustumCulled = false;
  }

  async bake(gl: THREE.WebGLRenderer, onProgress?: (f: number) => void) {
    const names = [...MALE, ...FEMALE];
    this.avatars = names.length;
    this.color = new THREE.WebGLRenderTarget(ATLAS, ATLAS, { type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace });
    this.normal = new THREE.WebGLRenderTarget(ATLAS, ATLAS, { type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    // mips once at the end, not after every cell
    this.color.texture.generateMipmaps = false;
    this.normal.texture.generateMipmaps = false;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-BOX_W / 2, BOX_W / 2, BOX_H / 2, -BOX_H / 2, 0.1, 10);
    const prevRT = gl.getRenderTarget();
    const prevClear = gl.getClearColor(new THREE.Color());
    const prevAlpha = gl.getClearAlpha();
    const prevAuto = gl.autoClear;
    gl.autoClear = false;
    for (const rt of [this.color, this.normal]) {
      gl.setRenderTarget(rt);
      gl.setClearColor(rt === this.normal ? 0x8080ff : 0x000000, 0);
      gl.clear(true, true, false);
    }
    const kits = await Promise.all(names.map((n) => loadKit(n)));
    let k = 0;
    for (let a = 0; a < names.length; a++) {
      const h = await Human.create(names[a]);
      const kit = kits[a];
      // albedo and normal+mask materials
      const albedo = new THREE.MeshBasicMaterial({ map: kit.av.map });
      const nrm = normalMaskMaterial(kit.av.map, kit.av.normal, kit.av.mask, kit.lm.waistY);
      const hairA = kit.av.hairMap ? new THREE.MeshBasicMaterial({ map: kit.av.hairMap, alphaTest: 0.5, side: THREE.DoubleSide }) : null;
      const hairN = kit.av.hairMap ? new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }) : null;
      if (hairN) {
        hairN.onBeforeCompile = (sh) => {
          sh.uniforms.uHair = { value: kit.av.hairMap };
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vHUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvHUv = uv;');
          sh.fragmentShader = sh.fragmentShader
            .replace('uniform float opacity;', 'uniform float opacity;\nuniform sampler2D uHair; varying vec2 vHUv;')
            .replace('gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );', 'if ( texture2D( uHair, vHUv ).a < 0.5 ) discard; gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, 0.0 );');
        };
      }
      const meshes: THREE.SkinnedMesh[] = [];
      h.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
      scene.add(h.root);
      const sit = h.action('sit')!, clap = h.action('clap')!, cheer = h.action('cheer')!;
      const lowerBones = Object.values(h.bones).filter((b) => LOWER.test(b.name) || b.name === 'Bip01');
      const pose = (f: number) => {
        h.mixer.stopAllAction();
        const setAt = (act: THREE.AnimationAction, t: number) => {
          h.mixer.stopAllAction();
          act.reset().play();
          act.time = t;
          h.mixer.update(0);
        };
        if (f < 2) setAt(sit, 1.5 + f * 3.7 + a * 0.4);
        else if (f < 6) {
          setAt(sit, 1.5 + a * 0.4);
          const keep = lowerBones.map((b) => [b.position.clone(), b.quaternion.clone()] as const);
          setAt(clap, 1.0 + (f - 2) * 0.11 + (a % 3) * 0.7);
          lowerBones.forEach((b, i) => { b.position.copy(keep[i][0]); b.quaternion.copy(keep[i][1]); });
        } else setAt(cheer, 1.2 + (f - 6) * 0.45 + (a % 4) * 0.6);
        h.ground();
        h.root.updateMatrixWorld(true);
      };
      for (let f = 0; f < FRAMES; f++) {
        pose(f);
        for (let v = 0; v < VIEWS.length * ELEVS.length; v++) {
          const th = THREE.MathUtils.degToRad(VIEWS[Math.floor(v / ELEVS.length)]);
          const el = THREE.MathUtils.degToRad(ELEVS[v % ELEVS.length]);
          cam.position.set(Math.sin(th) * Math.cos(el) * 4, PIVOT + Math.sin(el) * 4, Math.cos(th) * Math.cos(el) * 4);
          cam.lookAt(0, PIVOT, 0);
          cam.updateMatrixWorld();
          const cell = (a * FRAMES + f) * VIEWS.length * ELEVS.length + v;
          const cols = Math.floor(ATLAS / CELL_W);
          const cx = (cell % cols) * CELL_W, cy = Math.floor(cell / cols) * CELL_H;
          for (const [rt, bodyMat, hairMat] of [[this.color, albedo, hairA], [this.normal, nrm, hairN]] as const) {
            rt.viewport.set(cx, cy, CELL_W, CELL_H);
            rt.scissor.set(cx, cy, CELL_W, CELL_H);
            rt.scissorTest = true;
            gl.setRenderTarget(rt);
            gl.clear(false, true, false);
            meshes.forEach((m, i) => {
              m.visible = i === 0 || (!!hairMat && i === 1);
              m.material = i === 0 ? bodyMat : (hairMat ?? bodyMat);
            });
            gl.render(scene, cam);
          }
          k++;
        }
      }
      scene.remove(h.root);
      onProgress?.((a + 1) / names.length);
    }
    for (const rt of [this.color, this.normal]) {
      rt.scissorTest = false;
      rt.viewport.set(0, 0, ATLAS, ATLAS);
    }
    gl.setRenderTarget(prevRT);
    gl.setClearColor(prevClear, prevAlpha);
    gl.autoClear = prevAuto;
    // mipmaps (the targets were drawn cell by cell): an empty render into each triggers the mip update
    const empty = new THREE.Scene();
    for (const rt of [this.color, this.normal]) {
      rt.texture.generateMipmaps = true;
      gl.setRenderTarget(rt);
      gl.render(empty, cam);
    }
    gl.setRenderTarget(prevRT);
    this.uniforms.uColorAtlas.value = this.color.texture;
    this.uniforms.uNormalAtlas.value = this.normal.texture;
    this.uniforms.uAvatars.value = this.avatars;
    void k;
  }

  /** seat the crowd: occupancy 0..1 */
  populate(seats: SeatSpot[], occupancy = 0.93, palette?: string[]) {
    const R = rng(99);
    const chosen = seats.filter((s) => R() < occupancy - (s.tier === 1 ? 0.03 : 0));
    this.seats = chosen;
    const n = chosen.length;
    this.count = n;
    const base = new THREE.PlaneGeometry(1, 1);
    base.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    g.setAttribute('normal', base.getAttribute('normal'));
    const pos = new Float32Array(n * 4), face = new Float32Array(n * 2), look = new Float32Array(n * 4), tint = new Float32Array(n * 3);
    this.modes = new Float32Array(n);
    // what a summer crowd wears: mostly whites, blacks, navies and greys, a few colours
    const weighted: [string, number][] = [['#efefec', 24], ['#161616', 13], ['#1f2a44', 13], ['#878c93', 9], ['#9dbfdb', 8], ['#cdbfa6', 7],
      ['#a8322c', 5], ['#3e6b4a', 4], ['#d8b649', 4], ['#d9a0b0', 4], ['#c7672f', 3], ['#5a4a7a', 2], ['#2e7fb8', 4]];
    const palW = palette ? palette.map((c) => [c, 1] as [string, number]) : weighted;
    const totalW = palW.reduce((a, b) => a + b[1], 0);
    const pickCol = () => {
      let r = R() * totalW;
      for (const [c, w] of palW) if ((r -= w) <= 0) return new THREE.Color(c);
      return new THREE.Color(palW[0][0]);
    };
    chosen.forEach((s, i) => {
      pos.set([s.x, s.y, s.z, s.cover], i * 4);
      face.set([s.nx, s.nz], i * 2);
      const av = Math.floor(R() * this.avatars);
      look.set([av, R(), palette ? (R() < 0.4 ? 0.55 : 0) : R() < 0.7 ? 0.9 + R() * 0.1 : 0, 0.93 + R() * 0.14], i * 4);
      const c = pickCol();
      tint.set([c.r, c.g, c.b], i * 3);
    });
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 4));
    g.setAttribute('iFace', new THREE.InstancedBufferAttribute(face, 2));
    g.setAttribute('iLook', new THREE.InstancedBufferAttribute(look, 4));
    g.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 3));
    this.mode = new THREE.InstancedBufferAttribute(this.modes, 1);
    this.mode.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iMode', this.mode);
    g.instanceCount = n;
    this.geo = g;
    this.material = crowdMaterial(this.uniforms);
    this.mesh.geometry = g;
    this.mesh.material = this.material;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    // drawn first: its depth hides the seats and steps behind the people
    this.mesh.renderOrder = -2;
  }

  /** crowd reaction: 0 quiet (seated), 1 applause, 2 standing ovation — applied to a random share */
  react(level: number, share = 0.8) {
    const R = Math.random;
    for (let i = 0; i < this.count; i++) {
      const r = R();
      this.modes[i] = level === 0 ? (r < 0.03 ? 1 : 0) : level === 1 ? (r < share ? 1 : 0) : r < share * 0.55 ? 2 : r < share ? 1 : 0;
    }
    this.mode.needsUpdate = true;
    this.excite = level;
  }

  update(dt: number, camera: THREE.Camera) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
  }
}

/** capture-space normal (rgb) + shirt mask (a) for a skinned Rocketbox body */
function normalMaskMaterial(map: THREE.Texture, normalMap: THREE.Texture, mask: THREE.Texture, waistY: number): THREE.MeshNormalMaterial {
  const m = new THREE.MeshNormalMaterial({ normalMap, normalMapType: THREE.TangentSpaceNormalMap });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMask = { value: mask };
    sh.uniforms.uMap = { value: map };
    sh.uniforms.uWaist = { value: waistY };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMUv; varying float vRestY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMUv = uv; vRestY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('uniform float opacity;', 'uniform float opacity;\nuniform sampler2D uMask; uniform sampler2D uMap; uniform float uWaist; varying vec2 vMUv; varying float vRestY;')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = vec3( texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0, 0.0 ); mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );')
      .replace('gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );', `
        float cloth = vMUv.x < 0.5 ? texture2D( uMask, vMUv ).r : 0.0;
        float shirt = cloth * step( uWaist - 0.02, vRestY ) * step( vRestY, uWaist + 0.75 );
        gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, shirt );`);
  };
  return m;
}

function crowdMaterial(u: Crowd['uniforms']): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ alphaTest: 0.5, side: THREE.DoubleSide });
  // (a stand-in map so three compiles the uv + map paths; the atlas is sampled by hand)
  m.map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  m.map.needsUpdate = true;
  m.normalMap = m.map;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
attribute vec4 iPos; attribute vec2 iFace; attribute vec4 iLook; attribute vec3 iTint; attribute float iMode;
uniform float uTime, uAvatars; uniform vec3 uCam;
varying vec2 vCell; varying float vFlip; varying vec3 vTint; varying float vTintK; varying float vCover;
uniform float uFlash; varying float vFlash;
`)
      .replace('#include <uv_vertex>', /* glsl */ `#include <uv_vertex>
      // billboard: upright, facing the camera; the view angle picks the baked yaw
      vec3 seat = iPos.xyz;
      float sc = iLook.w;
      vec3 pivot = seat + vec3( 0.0, ${PIVOT.toFixed(2)} * sc, 0.0 );
      vec2 toCam = normalize( uCam.xz - seat.xz );
      vec3 toCam3 = normalize( uCam - pivot );
      float elev = asin( clamp( toCam3.y, -1.0, 1.0 ) );
      float ei = elev < -0.19 ? 0.0 : elev > 0.245 ? 2.0 : 1.0;
      float eCap = ei < 0.5 ? ${((ELEVS[0] * Math.PI) / 180).toFixed(4)} : ei > 1.5 ? ${((ELEVS[2] * Math.PI) / 180).toFixed(4)} : 0.0;
      vec3 bF = vec3( toCam.x * cos( eCap ), sin( eCap ), toCam.y * cos( eCap ) );
      vec3 bR = vec3( -toCam.y, 0.0, toCam.x );
      vec3 bU = cross( bR, bF );
      vec2 fwd = iFace;
      vec2 lx = vec2( fwd.y, -fwd.x );
      float ang = atan( dot( toCam, lx ), dot( toCam, fwd ) );
      float aa = abs( ang );
      float view = aa < 0.305 ? 0.0 : aa < 0.916 ? 1.0 : 2.0;
      vFlip = ang < 0.0 ? 1.0 : 0.0;
      float ph = iLook.y;
      float frame;
      if ( iMode < 0.5 ) frame = step( 0.5, fract( uTime * 0.07 + ph ) );
      else if ( iMode < 1.5 ) { float c = fract( uTime * ( 2.1 + ph * 0.8 ) + ph ); frame = 2.0 + floor( c * 4.0 ); }
      else frame = 6.0 + step( 0.5, fract( uTime * ( 1.2 + ph * 0.5 ) + ph ) );
      float cell = ( ( iLook.x * ${FRAMES.toFixed(1)} + frame ) * 3.0 + view ) * 3.0 + ei;
      float cols = ${Math.floor(ATLAS / CELL_W).toFixed(1)};
      vCell = vec2( mod( cell, cols ), floor( cell / cols ) );
      vTint = iTint; vTintK = iLook.z; vCover = iPos.w;
      // phone / camera flashes (night): a random few per second across the bowl
      float slot = floor( uTime * 9.0 );
      float hsh = fract( sin( slot * 12.9898 + ph * 7919.0 ) * 43758.5453 );
      vFlash = uFlash * step( 0.99975, hsh ) * ( iMode > 0.5 ? 3.0 : 1.0 );
`)
      .replace('#include <begin_vertex>', /* glsl */ `
      vec3 transformed = pivot + bR * ( position.x * ${BOX_W.toFixed(3)} * sc ) + bU * ( ( position.y - 0.5 ) * ${BOX_H.toFixed(3)} * sc );`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = bF;')
      .replace('#include <project_vertex>', /* glsl */ `
      vec4 mvPosition = viewMatrix * vec4( transformed, 1.0 );
      gl_Position = projectionMatrix * mvPosition;`)
      .replace('#include <worldpos_vertex>', /* glsl */ `
      vec4 worldPosition = vec4( transformed, 1.0 );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform sampler2D uColorAtlas, uNormalAtlas;
varying vec2 vCell; varying float vFlip; varying vec3 vTint; varying float vTintK; varying float vCover;
varying float vFlash;
vec2 atlasUv( vec2 uv ) {
  vec2 u = vec2( vFlip > 0.5 ? 1.0 - uv.x : uv.x, uv.y );
  vec2 cellSize = vec2( ${(CELL_W / ATLAS).toFixed(6)}, ${(CELL_H / ATLAS).toFixed(6)} );
  return ( vCell + clamp( u, 0.01, 0.99 ) ) * cellSize;
}
vec4 gNrm;`)
      .replace('#include <map_fragment>', /* glsl */ `
      vec2 auv = atlasUv( vMapUv );
      vec4 alb = texture2D( uColorAtlas, auv );
      gNrm = texture2D( uNormalAtlas, auv );
      vec3 base = alb.rgb;
      float lum = dot( base, vec3( 0.2126, 0.7152, 0.0722 ) );
      float shirt = gNrm.a * vTintK;
      vec3 dyed = vTint * clamp( lum / 0.25, 0.55, 1.35 );
      base = mix( base, min( dyed, vec3( 0.6 ) ), shirt );
      // under the roof: less sky, the rows behind darker
      base *= 1.0 - 0.35 * vCover;
      diffuseColor.rgb = base;
      diffuseColor.a = alb.a;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      // the flash: a hot point at the upper body
      // a warm bounce-light fill so the shaded stands read as people, not blue silhouettes
      totalEmissiveRadiance += diffuseColor.rgb * vec3( 1.0, 0.93, 0.84 ) * 0.2;
      totalEmissiveRadiance += vec3( 1.0, 0.97, 0.92 ) * vFlash * 60.0 * smoothstep( 0.35, 0.0, distance( vMapUv, vec2( 0.5, 0.62 ) ) );`)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
      {
        vec3 mapN = gNrm.xyz * 2.0 - 1.0;
        if ( vFlip > 0.5 ) mapN.x = -mapN.x;
        // tangent frame of an upright camera-facing quad in view space
        vec3 N = normalize( normal );
        vec3 B = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
        vec3 T = normalize( cross( B, N ) );
        B = cross( N, T );
        // softened: the baked normals only sculpt the figure, they don't carve white highlights
        normal = normalize( mix( N, normalize( T * mapN.x + B * mapN.y + N * max( mapN.z, 0.05 ) ), 0.42 ) );
      }`);
  };
  m.customProgramCacheKey = () => 'cc-crowd-v2';
  return m;
}
