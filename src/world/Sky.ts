import * as THREE from 'three';
import { GFX } from '../render/gfx.ts';

export type SkyName = 'day' | 'overcast' | 'sunset' | 'night';

interface SkyMeta {
  scale: number;
  sunE: [number, number, number];
  skyE: [number, number, number];
  sunUV: [number, number];
  sunElevDeg: number;
  bgRows: number;
  rows: number;
}

/** how each sky is lit: the sun's direction (court frame), strength trims, exposure */
interface Preset {
  /** sun elevation / azimuth in degrees; azimuth 0 = from +x (the right of the near baseline), 90 = from −z (far end) */
  elev: number;
  az: number;
  sunGain: number;
  skyGain: number;
  /** exposure is picked so this much light lands on a horizontal surface as mid grey */
  key: number;
  shadowSoft: number;
  night?: boolean;
}

export const PRESETS: Record<SkyName, Preset> = {
  day: { elev: 48, az: 156, sunGain: 1.35, skyGain: 1.0, key: 1.0, shadowSoft: 1.6 },
  overcast: { elev: 60, az: 120, sunGain: 0.0, skyGain: 1.0, key: 1.0, shadowSoft: 6 },
  sunset: { elev: 13, az: 132, sunGain: 1.0, skyGain: 1.0, key: 1.0, shadowSoft: 2.5 },
  night: { elev: 70, az: 90, sunGain: 0, skyGain: 0.018, key: 1.0, shadowSoft: 2, night: true },
};

const BASE = import.meta.env.BASE_URL + 'sky/';

/**
 * The sky: a Poly Haven HDRI (CC0) drawn as a background dome (radiance recovered from the
 * stored ×scale sRGB), a sun whose strength and colour were measured from the HDRI's own sun
 * (tools/build_sky.py), and an environment map captured from the finished stadium so the
 * people and props pick up the court's bounce light and the stands' reflections.
 */
export class Sky {
  readonly dome: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3();
  name: SkyName = 'day';
  preset: Preset = PRESETS.day;
  exposure = 1;
  /** light on a horizontal surface (sun + sky + floods) */
  horizontal = 1;
  private meta: Record<string, SkyMeta> = {};
  private textures = new Map<string, THREE.Texture>();
  private mat: THREE.ShaderMaterial;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  /** night: four floodlight banks on the roof corners (spotlights, each with its own shadow) */
  readonly floods: THREE.SpotLight[] = [];

  constructor(readonly scene: THREE.Scene, readonly gl: THREE.WebGLRenderer) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        scale: { value: 1 },
        yaw: { value: 0 },
        rowsFrac: { value: 0.53 },
        ground: { value: new THREE.Color(0.05, 0.05, 0.05) },
        intensity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float scale, yaw, rowsFrac, intensity;
        uniform vec3 ground;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize( vDir );
          float c = cos( yaw ), s = sin( yaw );
          vec3 r = vec3( c * d.x - s * d.z, d.y, s * d.x + c * d.z );
          float u = atan( r.z, r.x ) * 0.15915494 + 0.5;
          float v = asin( clamp( r.y, -1.0, 1.0 ) ) * 0.31830989 + 0.5;
          float t = ( 1.0 - v ) / rowsFrac;
          vec3 col = ground;
          if ( t < 1.0 ) {
            // (no mip: the seam's derivative jump would pick the smallest level)
            col = textureLod( map, vec2( u, 1.0 - t ), 0.0 ).rgb / scale;
            col = mix( col, ground, smoothstep( 0.97, 1.0, t ) );
          }
          gl_FragColor = vec4( col * intensity, 1.0 );
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), this.mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.dome.name = 'sky-dome';
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(4096, 4096);
    sh.bias = -0.00012;
    sh.normalBias = 0.025;
    sh.camera.near = 1;
    sh.camera.far = 400;
    scene.add(this.sun, this.sun.target);

    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const l = new THREE.SpotLight(0xfff1e0, 1, 0, 0.95, 0.7, 0);
      // LED fixtures on the poles at the court's corners (Club.lightPoles)
      l.position.set(sx * 6.1, 8.2, sz > 0 ? 10.2 : -10.6);
      l.target.position.set(sx * -1.0, 0, sz * -2.0);
      l.castShadow = true;
      l.shadow.mapSize.set(2048, 2048);
      l.shadow.bias = -0.00015;
      l.shadow.normalBias = 0.03;
      l.shadow.radius = 2.5;
      l.shadow.camera.near = 2;
      l.shadow.camera.far = 40;
      l.visible = false;
      this.floods.push(l);
      scene.add(l, l.target);
    }
    this.pmrem = new THREE.PMREMGenerator(gl);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.5, 1200, this.cubeRT);
    this.cubeCam.position.set(0, 3, 0);
  }

  async load(): Promise<void> {
    this.meta = await (await fetch(BASE + 'sky.json')).json();
  }

  private async tex(name: SkyName): Promise<THREE.Texture> {
    let t = this.textures.get(name);
    if (!t) {
      t = await new THREE.TextureLoader().loadAsync(BASE + name + '_bg.jpg');
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = 1;
      this.textures.set(name, t);
    }
    return t;
  }

  /** switch sky; returns once the background is ready (the env capture is separate: captureEnv) */
  async set(name: SkyName): Promise<void> {
    const m = this.meta[name];
    const p = PRESETS[name];
    this.name = name;
    this.preset = p;
    const u = this.mat.uniforms;
    u.map.value = await this.tex(name);
    u.scale.value = m.scale;
    u.rowsFrac.value = m.bgRows / m.rows;
    // sun direction in the court frame
    const el = THREE.MathUtils.degToRad(p.elev), az = THREE.MathUtils.degToRad(p.az);
    this.sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), -Math.cos(el) * Math.sin(az)).normalize();
    // yaw the dome so the HDRI's sun sits on the same azimuth (world azimuth = atan2(z, x))
    const phiImg = (m.sunUV[0] - 0.5) * Math.PI * 2;
    const phiW = Math.atan2(this.sunDir.z, this.sunDir.x);
    u.yaw.value = phiImg - phiW;
    // sun colour + strength from the HDRI's measured sun
    const e = m.sunE;
    const peak = Math.max(e[0], e[1], e[2], 1e-6);
    const E = (e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722) * p.sunGain;
    this.sun.color.setRGB(e[0] / peak, e[1] / peak, e[2] / peak, THREE.LinearSRGBColorSpace);
    // three: intensity × colour is the irradiance at normal incidence
    const lumOfColor = this.sun.color.r * 0.2126 + this.sun.color.g * 0.7152 + this.sun.color.b * 0.0722;
    this.sun.intensity = lumOfColor > 0 ? E / lumOfColor : 0;
    this.sun.visible = this.sun.intensity > 0.01;
    this.sun.castShadow = this.sun.visible;
    this.sun.shadow.radius = p.shadowSoft;
    u.intensity.value = p.skyGain;
    // floodlights at night: ~0.8 each on the court (four banks, from ~40° up)
    let floodH = 0;
    for (const l of this.floods) {
      l.visible = !!p.night;
      l.intensity = p.night ? 1.05 : 0;
      floodH += p.night ? 1.05 * 0.62 : 0;
    }
    // exposure: horizontal irradiance (sun + sky) → mid grey. A grey card (albedo 0.18) under E reads E·0.18/π.
    const skyE = (m.skyE[0] * 0.2126 + m.skyE[1] * 0.7152 + m.skyE[2] * 0.0722) * p.skyGain;
    const horiz = E * Math.max(0, this.sunDir.y) + skyE + floodH;
    this.horizontal = horiz;
    this.exposure = (p.key * Math.PI) / Math.max(horiz, 1e-3) * (p.night ? 0.8 : 0.9);
    this.placeSunShadow();
  }

  /** the shadow frustum: the court floor and the lower stands, seen along the sun */
  placeSunShadow(center = new THREE.Vector3(0, 0, -4), halfX = 20, halfZ = 22) {
    const d = this.sunDir;
    this.sun.position.copy(center).addScaledVector(d, 160);
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    // project the receiver box onto the light's plane to size the ortho camera
    const cam = this.sun.shadow.camera;
    const view = new THREE.Matrix4().lookAt(this.sun.position, center, new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 16]) {
      v.set(center.x + sx * halfX, y, center.z + sz * halfZ).sub(this.sun.position).applyMatrix4(inv);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    cam.left = minX; cam.right = maxX; cam.bottom = minY; cam.top = maxY;
    cam.near = 20; cam.far = 320;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  /** capture the lit scene (stadium, court, sky) into the environment map */
  /** lite (the TV): a sky/ground hemisphere light stands in for the captured environment */
  private hemi: THREE.HemisphereLight | null = null;
  private liteLight() {
    if (!this.hemi) {
      this.hemi = new THREE.HemisphereLight();
      this.scene.add(this.hemi);
    }
    const m = this.meta[this.name];
    const e = m.skyE;
    const k = this.preset.skyGain;
    const peak = Math.max(e[0], e[1], e[2], 1e-6);
    this.hemi.color.setRGB(e[0] / peak, e[1] / peak, e[2] / peak, THREE.LinearSRGBColorSpace);
    this.hemi.groundColor.setRGB(0.32, 0.36, 0.3, THREE.LinearSRGBColorSpace);
    this.hemi.intensity = ((e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722) * k) / Math.PI * 1.6 + (this.preset.night ? 0.25 : 0);
  }

  captureEnv(hide: THREE.Object3D[] = []) {
    if (GFX.lite) {
      this.liteLight();
      return;
    }
    const was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const prevEnv = this.scene.environment;
    // first bounce: a sky-only environment so the stands are lit when captured
    if (!prevEnv) {
      const only = new THREE.Scene();
      only.add(this.dome.clone());
      this.cubeCam.update(this.gl, only);
      this.setEnvFromCube();
    }
    this.cubeCam.update(this.gl, this.scene);
    this.setEnvFromCube();
    hide.forEach((o, i) => (o.visible = was[i]));
  }

  /**
   * the captured environment is mostly floor and seats: their colour would tint everyone
   * (green on grass, orange on clay). Re-render the cube through a partial desaturation.
   */
  private desatRT: THREE.WebGLCubeRenderTarget | null = null;
  private desatScene: THREE.Scene | null = null;
  private desatCam: THREE.CubeCamera | null = null;
  envSaturation = 0.55;
  private desaturated(): THREE.CubeTexture {
    if (!this.desatRT) {
      this.desatRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
      this.desatCam = new THREE.CubeCamera(0.1, 10, this.desatRT);
      this.desatScene = new THREE.Scene();
      const m = new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, sat: { value: this.envSaturation } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform samplerCube src; uniform float sat; varying vec3 vDir;
          void main(){ vec3 c = textureCube( src, normalize( vDir ) ).rgb; float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); gl_FragColor = vec4( mix( vec3( l ), c, sat ), 1.0 ); }`,
        side: THREE.BackSide,
        depthWrite: false,
      });
      this.desatScene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), m));
    }
    const m = (this.desatScene!.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    m.uniforms.src.value = this.cubeRT.texture;
    m.uniforms.sat.value = this.envSaturation;
    this.desatCam!.update(this.gl, this.desatScene!);
    return this.desatRT.texture;
  }

  private setEnvFromCube() {
    const rt = this.pmrem.fromCubemap(this.desaturated());
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
  }
}
