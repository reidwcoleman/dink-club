import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode,
  VignetteEffect, BrightnessContrastEffect, HueSaturationEffect, DepthOfFieldEffect, ChromaticAberrationEffect, NoiseEffect,
  BlendFunction, Effect,
} from 'postprocessing';

/** scene-referred exposure, ahead of bloom and tone mapping */
export class ExposureEffect extends Effect {
  constructor() {
    super('ExposureEffect', /* glsl */ `
      uniform float exposure;
      void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
        outputColor = vec4( inputColor.rgb * exposure, inputColor.a );
      }`, { uniforms: new Map([['exposure', new THREE.Uniform(1)]]) });
  }
  get value(): number { return this.uniforms.get('exposure')!.value; }
  set value(v: number) { this.uniforms.get('exposure')!.value = v; }
}

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

/**
 * The renderer: WebGL2 + a postprocessing chain (bloom, SMAA, tone mapping, grade, vignette,
 * film grain, depth of field for replays / close-ups). Render scale adapts to hold 60 fps:
 * on Apple GPUs timer queries are unreliable (ApexGP), so it governs by frame time.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly exposure: ExposureEffect;
  readonly bloom: BloomEffect;
  readonly tone: ToneMappingEffect;
  readonly grade: BrightnessContrastEffect;
  readonly sat: HueSaturationEffect;
  readonly vignette: VignetteEffect;
  readonly dof: DepthOfFieldEffect;
  readonly ca: ChromaticAberrationEffect;
  readonly grain: NoiseEffect;
  private dofPass: EffectPass;
  private mainPass: EffectPass;
  camera: THREE.PerspectiveCamera;
  scale = 1;
  maxScale = 1;
  minScale = 0.6;
  quality: Quality = 'high';
  adaptive = true;
  private frameTimes: number[] = [];
  private lastAdapt = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: false,
    });
    const gl = this.gl;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    // tone mapping happens in the post chain
    gl.toneMapping = THREE.NoToneMapping;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.info.autoReset = false;

    this.composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.dof = new DepthOfFieldEffect(camera, { focusDistance: 10, focusRange: 6, bokehScale: 2.5, resolutionY: 540 } as never);
    this.dofPass = new EffectPass(camera, this.dof);
    this.dofPass.enabled = false;
    this.composer.addPass(this.dofPass);

    this.exposure = new ExposureEffect();
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.1, luminanceSmoothing: 0.35, intensity: 0.55, radius: 0.72 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
    this.grade = new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.06 });
    this.sat = new HueSaturationEffect({ saturation: 0.08 });
    this.vignette = new VignetteEffect({ offset: 0.32, darkness: 0.42 });
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.00045, 0.00025), radialModulation: true, modulationOffset: 0.35 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.grain.blendMode.opacity.value = 0.045;
    const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
    // one pass: exposure first (bloom reads the unexposed input, so its threshold and strength follow the exposure)
    this.mainPass = new EffectPass(camera, this.exposure, this.bloom, this.tone, this.grade, this.sat, this.vignette, this.grain, smaa);
    this.composer.addPass(this.mainPass);

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setCamera(cam: THREE.PerspectiveCamera) {
    this.camera = cam;
    this.renderPass.mainCamera = cam;
    this.composer.passes.forEach((p) => (p.mainCamera = cam));
  }

  /** depth of field for replays and close-ups (focus distance and in-focus range in metres) */
  setDof(on: boolean, focusMetres = 10, rangeMetres = 5, bokeh = 2.5) {
    this.dofPass.enabled = on;
    if (!on) return;
    this.dof.cocMaterial.focusDistance = focusMetres;
    this.dof.cocMaterial.focusRange = rangeMetres;
    this.dof.bokehScale = bokeh;
  }

  /** scene-referred exposure; bloom's threshold and strength are kept relative to it */
  setExposure(x: number) {
    if (Math.abs(this.exposure.value - x) < 1e-5) return;
    this.exposure.value = x;
    this.bloom.luminanceMaterial.threshold = 1.1 / x;
    this.bloom.intensity = 0.55 * x;
  }

  /** a pixel budget per quality level (the M1 fills ~2 MP of this scene at 60 fps) */
  private budget = 2.0e6;
  setQuality(q: Quality) {
    this.quality = q;
    this.budget = { low: 0.9e6, medium: 1.4e6, high: 2.0e6, ultra: 3.4e6 }[q];
    this.maxScale = 1;
    this.minScale = { low: 0.7, medium: 0.68, high: 0.66, ultra: 0.7 }[q];
    this.scale = 1;
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    const ratio = Math.min(dpr, Math.sqrt(this.budget / (w * h)));
    this.gl.setPixelRatio(ratio * this.scale);
    this.gl.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** track frame time and nudge the render scale (every ~1.5 s) */
  adapt(dt: number, now: number) {
    if (!this.adaptive) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    if (now - this.lastAdapt < 1.5 || this.frameTimes.length < 60) return;
    this.lastAdapt = now;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    let s = this.scale;
    if (p80 > 1 / 52) s = Math.max(this.minScale, s - 0.06);
    else if (p80 < 1 / 58.5) s = Math.min(this.maxScale, s + 0.03);
    if (Math.abs(s - this.scale) > 0.001) {
      this.scale = s;
      this.resize();
    }
  }

  render(dt: number) {
    this.gl.info.reset();
    this.composer.render(dt);
  }
}
