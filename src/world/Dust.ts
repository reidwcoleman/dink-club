import * as THREE from 'three';

/**
 * Clay dust: soft sprites kicked up by slides, sharp stops and bounces, drifting and
 * spreading as they fade. One pooled Points cloud (a few hundred particles at most).
 */
export class Dust {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  private readonly N = 400;
  color = new THREE.Color('#c9774d');

  constructor() {
    const N = this.N;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N);
    this.size = new Float32Array(N);
    this.alpha = new Float32Array(N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color }, uScale: { value: 600 }, uLight: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_PointSize = aSize * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uLight; varying float vA;
        void main() {
          vec2 d = gl_PointCoord * 2.0 - 1.0;
          float r = dot( d, d );
          if ( r > 1.0 ) discard;
          float a = ( 1.0 - r ) * ( 1.0 - r ) * vA;
          gl_FragColor = vec4( uColor * uLight, a );
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  /** brightness so the dust sits in the scene's exposure (it's unlit) */
  setLight(k: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uLight.value = k;
  }

  puff(x: number, z: number, n: number, speed = 0.8, dirX = 0, dirZ = 0) {
    for (let i = 0; i < n; i++) {
      const k = this.next++ % this.N;
      this.pos.set([x + (Math.random() - 0.5) * 0.2, 0.03 + Math.random() * 0.05, z + (Math.random() - 0.5) * 0.2], k * 3);
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.vel.set([Math.cos(a) * s + dirX * 0.6, 0.25 + Math.random() * 0.5, Math.sin(a) * s + dirZ * 0.6], k * 3);
      this.life[k] = 1;
      this.size[k] = 0.12 + Math.random() * 0.12;
    }
  }

  update(dt: number) {
    let any = false;
    for (let k = 0; k < this.N; k++) {
      if (this.life[k] <= 0) {
        this.alpha[k] = 0;
        continue;
      }
      any = true;
      this.life[k] -= dt / 1.6;
      const v = this.vel;
      v[k * 3] *= 1 - dt * 2.2;
      v[k * 3 + 1] = v[k * 3 + 1] * (1 - dt * 1.5) - dt * 0.15;
      v[k * 3 + 2] *= 1 - dt * 2.2;
      this.pos[k * 3] += v[k * 3] * dt;
      this.pos[k * 3 + 1] = Math.max(0.02, this.pos[k * 3 + 1] + v[k * 3 + 1] * dt);
      this.pos[k * 3 + 2] += v[k * 3 + 2] * dt;
      this.size[k] += dt * 0.35;
      this.alpha[k] = Math.max(0, this.life[k]) * 0.32;
    }
    if (any) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
    }
  }
}
