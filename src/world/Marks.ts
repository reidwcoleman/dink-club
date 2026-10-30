import * as THREE from 'three';
import { FLOOR_HX, FLOOR_HZ } from '../sim/dims.ts';

/**
 * Floor marks in a render target mapped over the whole floor (1 texel ≈ 1 cm over the
 * court): r ball marks (clay: the compressed oval a line judge reads), g footprints and
 * slides, b rubber scuffs (hard). Stamps are soft ellipses drawn with max blending.
 */
export class Marks {
  readonly rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam: THREE.OrthographicCamera;
  private stamps: THREE.Mesh[] = [];
  private pool: THREE.Mesh[] = [];
  private mat: THREE.ShaderMaterial;

  constructor(readonly gl: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(2048, 4096, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.rt.texture.anisotropy = 8;
    this.cam = new THREE.OrthographicCamera(-FLOOR_HX, FLOOR_HX, FLOOR_HZ, -FLOOR_HZ, -1, 1);
    // looking up from below the floor: screen right = +x → u, screen up = +z → v (Court.ts reads uv = p / size + 0.5)
    this.cam.position.set(0, 0, 0);
    this.cam.up.set(0, 0, 1);
    this.cam.lookAt(0, 1, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { channel: { value: new THREE.Vector4(1, 0, 0, 0) }, strength: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform vec4 channel; uniform float strength; varying vec2 vUv;
        void main(){ vec2 d = vUv * 2.0 - 1.0; float a = 1.0 - smoothstep( 0.35, 1.0, dot( d, d ) ); gl_FragColor = channel * a * strength; }`,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.clear();
  }

  get texture() {
    return this.rt.texture;
  }

  clear() {
    const prev = this.gl.getRenderTarget();
    this.gl.setRenderTarget(this.rt);
    this.gl.setClearColor(0x000000, 0);
    this.gl.clear(true, false, false);
    this.gl.setRenderTarget(prev);
  }

  /** queue a stamp: centre (x, z), size (along, across) in metres, heading (radians), channel 0 r / 1 g / 2 b */
  stamp(x: number, z: number, along: number, across: number, heading: number, channel: 0 | 1 | 2, strength = 1) {
    const m = this.pool.pop() ?? new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.mat.clone());
    m.position.set(x, 0, z);
    m.scale.set(across, 1, along);
    m.rotation.set(0, heading, 0);
    const mat = m.material as THREE.ShaderMaterial;
    mat.uniforms.channel.value.set(channel === 0 ? 1 : 0, channel === 1 ? 1 : 0, channel === 2 ? 1 : 0, 0);
    mat.uniforms.strength.value = strength;
    this.stamps.push(m);
    this.scene.add(m);
  }

  /** draw queued stamps into the target */
  flush() {
    if (!this.stamps.length) return;
    const prev = this.gl.getRenderTarget();
    const auto = this.gl.autoClear;
    this.gl.autoClear = false;
    this.gl.setRenderTarget(this.rt);
    this.gl.render(this.scene, this.cam);
    this.gl.setRenderTarget(prev);
    this.gl.autoClear = auto;
    for (const m of this.stamps) {
      this.scene.remove(m);
      this.pool.push(m);
    }
    this.stamps.length = 0;
  }
}
