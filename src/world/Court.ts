import * as THREE from 'three';
import { HL, HW, NVZ, LINE, FLOOR_HX, FLOOR_HZ } from '../sim/dims.ts';
import { noiseTexture, tex, lin } from '../render/noise.ts';
import type { Venue } from './venues.ts';
import { SPACING, FENCE } from './Club.ts';

/**
 * The playing floor (a pickleball court on an acrylic club surface: court, a two-tone kitchen,
 * the surround). One plane, one material: three's physical lighting with the surface
 * computed per pixel — the court paint, analytic lines (anti-aliased with fwidth, sharp at
 * any distance), grain from a CC0 sand scan, and per-surface character:
 *   hard  — acrylic over sand: fine grain, a satin sheen, rubber scuffs behind the baselines
 *   clay  — crushed brick: dry and damp patches, drag-net arcs, dusty tapes, a scuffed baseline
 *   grass — mowing stripes that swap light/dark with the view direction, worn baselines
 * A floor-mapped marks texture (Marks.ts) carries ball marks, footprints and slides.
 */
export class Court {
  readonly mesh: THREE.Mesh;
  material: THREE.MeshPhysicalMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(venue: Venue, marks: THREE.Texture) {
    const u: Record<string, THREE.IUniform> = {
      uSurface: { value: 0 },
      uIn: { value: new THREE.Color() },
      uKitchen: { value: new THREE.Color() },
      uOut: { value: new THREE.Color() },
      uLine: { value: new THREE.Color() },
      uDirt: { value: new THREE.Color() },
      uWear: { value: 0.6 },
      uNoise: { value: noiseTexture() },
      uSandN: { value: null },
      uSandC: { value: null },
      uMarks: { value: marks },
      uFloor: { value: new THREE.Vector2(FLOOR_HX, FLOOR_HZ) },
    };
    this.uniforms = u;
    const m = new THREE.MeshPhysicalMaterial({ roughness: 0.6, metalness: 0, specularIntensity: 0.6 });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + COURT_GLSL)
        .replace('#include <map_fragment>', /* glsl */ `
          // one plane paints the whole bank of courts: lines repeat every SPACING across x
          gWorld = vCW.xz;
          vec2 cp = vec2( abs( vCW.x ) < SP * 1.5 ? mod( vCW.x + SP * 0.5, SP ) - SP * 0.5 : 99.0, vCW.z );
          float lines = courtLines( cp );
          float cRough;
          vec3 cN;
          vec3 viewW = normalize( cameraPosition - vCW );
          vec3 cCol = courtSurface( cp, lines, viewW, cRough, cN );
          diffuseColor.rgb = cCol;`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cRough;')
        .replace('#include <normal_fragment_maps>', 'normal = normalize( ( viewMatrix * vec4( cN, 0.0 ) ).xyz );');
    };
    m.customProgramCacheKey = () => 'court-pb1';
    this.material = m;
    const hz = (FENCE.zNear - FENCE.zFar) / 2;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(FENCE.x * 2, hz * 2, 24, 16).rotateX(-Math.PI / 2).translate(0, 0, FENCE.zFar + hz), m);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'court';
    this.setVenue(venue);
  }

  async load() {
    const [n, c] = await Promise.all([tex('sand_n.jpg', false), tex('sand_c.jpg', true)]);
    this.uniforms.uSandN.value = n;
    this.uniforms.uSandC.value = c;
  }

  setVenue(v: Venue) {
    const u = this.uniforms;
    u.uSurface.value = v.surface === 'hard' ? 0 : v.surface === 'clay' ? 1 : 2;
    (u.uIn.value as THREE.Color).copy(lin(v.courtIn));
    (u.uOut.value as THREE.Color).copy(lin(v.courtOut));
    (u.uKitchen.value as THREE.Color).copy(lin(v.kitchen));
    (u.uLine.value as THREE.Color).copy(lin(v.line));
    (u.uDirt.value as THREE.Color).copy(lin(v.dirt));
    const m = this.material;
    if (v.surface === 'grass') {
      m.sheen = 0.9;
      m.sheenRoughness = 0.55;
      m.sheenColor = new THREE.Color(0.35, 0.55, 0.25);
      m.specularIntensity = 0.35;
    } else if (v.surface === 'clay') {
      m.sheen = 0.25;
      m.sheenRoughness = 0.8;
      m.sheenColor = new THREE.Color(0.9, 0.55, 0.4);
      m.specularIntensity = 0.3;
    } else {
      m.sheen = 0;
      m.specularIntensity = 0.65;
    }
    m.needsUpdate = true;
  }
}

const f = (x: number) => x.toFixed(4);

const COURT_GLSL = /* glsl */ `
varying vec3 vCW;
uniform float uSurface, uWear;
uniform vec3 uIn, uKitchen, uOut, uLine, uDirt;
uniform sampler2D uNoise, uSandN, uSandC, uMarks;
uniform vec2 uFloor;

#define HL ${f(HL)}
#define HW ${f(HW)}
#define NVZ ${f(NVZ)}
#define LN ${f(LINE)}
#define SP ${f(SPACING)}
vec2 gWorld;

float band( float t, float a, float b ) {
  float w = max( fwidth( t ), 1e-4 ) * 0.9;
  return clamp( ( t - a ) / w + 0.5, 0.0, 1.0 ) * clamp( ( b - t ) / w + 0.5, 0.0, 1.0 );
}
float rect( vec2 p, vec4 r ) { return band( p.x, r.x, r.y ) * band( p.y, r.z, r.w ); }

float courtLines( vec2 p ) {
  vec2 a = abs( p );
  // baselines, sidelines, the kitchen lines, and the centre lines from the kitchen to the baselines
  float m = rect( a, vec4( -1.0, HW, HL - LN, HL ) );
  m = max( m, rect( a, vec4( HW - LN, HW, -1.0, HL ) ) );
  m = max( m, rect( a, vec4( -1.0, HW, NVZ - LN, NVZ ) ) );
  m = max( m, rect( a, vec4( -1.0, LN * 0.5, NVZ, HL ) ) );
  return m;
}

// floor-mapped marks: r ball marks / compressed clay, g footprints and slides, b rubber
vec4 floorMarks( vec2 p ) {
  vec2 uv = gWorld / ( uFloor * 2.0 ) + 0.5;
  if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return vec4( 0.0 );
  return texture2D( uMarks, uv );
}

vec3 grainNormal( vec2 p, float scale, float k ) {
  vec3 sn = texture2D( uSandN, p * scale ).xyz * 2.0 - 1.0;
  return normalize( vec3( sn.x * k, 1.0, -sn.y * k ) );
}

vec3 courtSurface( vec2 p, float lines, vec3 viewW, out float rough, out vec3 nW ) {
  vec4 nz1 = texture2D( uNoise, gWorld * 0.021 );
  vec4 nz2 = texture2D( uNoise, gWorld * 0.13 );
  vec4 nz3 = texture2D( uNoise, gWorld * 0.9 );
  vec4 mk = floorMarks( p );
  vec3 sand = texture2D( uSandC, gWorld * 0.55 ).rgb;
  float g = dot( sand, vec3( 0.3333 ) );
  float inside = rect( abs( p ), vec4( -1.0, HW, -1.0, HL ) );
  float kitchen = rect( abs( p ), vec4( -1.0, HW, -1.0, NVZ ) );
  // wear: behind the baselines and along the kitchen lines, where the feet go
  float wz = smoothstep( 2.6, 0.4, abs( p.x ) ) * ( smoothstep( 1.4, 0.1, abs( abs( p.y ) - ( HL + 0.4 ) ) ) + 0.7 * smoothstep( 0.7, 0.05, abs( abs( p.y ) - ( NVZ + 0.35 ) ) ) );
  vec3 c;
  if ( uSurface < 0.5 ) {
    // ---- hard: acrylic paint over a sand-textured base
    c = mix( mix( uOut, uIn, inside ), uKitchen, kitchen );
    c *= 0.955 + 0.07 * nz1.r + 0.035 * ( nz2.g - 0.5 );
    c *= 0.93 + 0.14 * g;
    float scuff = smoothstep( 0.5, 0.8, texture2D( uNoise, p * vec2( 0.7, 2.2 ) ).b ) * wz * uWear;
    c *= 1.0 - 0.3 * scuff - 0.5 * mk.b;
    vec3 lc = uLine * ( 0.96 + 0.04 * nz3.g ) * ( 1.0 - 0.15 * scuff );
    c = mix( c, lc, lines );
    rough = mix( 0.58, 0.44, lines ) + 0.06 * ( nz2.b - 0.5 ) - 0.12 * scuff;
    nW = grainNormal( p, 1.6, mix( 0.22, 0.1, lines ) );
  } else if ( uSurface < 1.5 ) {
    // ---- clay: crushed brick
    c = uIn * ( 0.84 + 0.26 * nz1.r + 0.12 * ( nz2.g - 0.5 ) ) * ( 0.72 + 0.56 * g );
    float dry = smoothstep( 0.42, 0.72, nz1.r * 0.6 + nz2.g * 0.4 );
    c = mix( c, c * vec3( 1.17, 1.1, 1.05 ), dry * 0.55 );
    // the drag mat's sweep: broad arcs of alternating nap
    float ring = sin( length( p - vec2( sign( p.x + 0.001 ) * 2.0, sign( p.y ) * 5.0 ) ) * 3.1 + nz2.r * 3.0 );
    c *= 1.0 + 0.045 * smoothstep( -0.2, 0.9, ring ) * ( 1.0 - wz ) - 0.02;
    // loose top-dressing: lighter, dustier patches that collect off the play lines
    float loose = smoothstep( 0.55, 0.85, texture2D( uNoise, p * 0.045 + 0.37 ).g );
    c = mix( c, c * vec3( 1.2, 1.14, 1.1 ), loose * 0.5 );
    float scuffed = wz * uWear * smoothstep( 0.3, 0.75, nz3.b * 0.7 + nz2.b * 0.3 );
    c = mix( c, c * vec3( 0.84, 0.78, 0.76 ), scuffed );
    // marks: ball marks (r) show the smoother, darker brick; footprints (g) lighter, scraped
    // marks: ball marks (r) and footprints / slides (g) compress the brick: darker, smoother
    c *= 1.0 - 0.34 * mk.r - 0.2 * mk.g;
    c = mix( c, c * vec3( 1.1, 1.06, 1.03 ), smoothstep( 0.05, 0.25, mk.g ) * smoothstep( 0.6, 0.25, mk.g ) * 0.6 );
    vec3 tape = uLine * mix( vec3( 1.0 ), vec3( 1.0, 0.8, 0.66 ), clamp( 0.3 * smoothstep( 0.35, 0.9, nz3.g ) + 0.22 * nz2.b + 0.4 * mk.g, 0.0, 1.0 ) );
    c = mix( c, tape, lines );
    rough = mix( 0.93, 0.62, lines ) - 0.18 * mk.r - 0.1 * mk.g;
    nW = grainNormal( p, 0.8, mix( 0.55, 0.12, lines ) * ( 1.0 - 0.6 * mk.r ) );
  } else {
    // ---- grass: mowing stripes, bent blades catching the light by view direction
    float s = mod( floor( ( p.y + 60.0 ) / 1.19 ), 2.0 ) * 2.0 - 1.0;
    float look = s * clamp( viewW.z * 1.6, -1.0, 1.0 );
    c = uIn * ( 1.0 + 0.2 * look ) * ( 0.86 + 0.28 * nz1.r ) * ( 0.84 + 0.3 * nz3.b ) * ( 0.9 + 0.2 * g );
    // worn: baselines to bare earth, a lighter path along the service line
    float worn = smoothstep( 0.25, 0.75, wz * uWear * 1.35 - nz2.g * 0.45 + nz3.r * 0.25 );
    float thin = smoothstep( 0.1, 0.6, wz * uWear * 1.6 - nz2.g * 0.3 );
    c = mix( c, c * vec3( 1.25, 1.12, 0.7 ), thin * 0.6 );
    c = mix( c, uDirt * ( 0.75 + 0.5 * nz3.g ), worn );
    c *= 1.0 - 0.25 * mk.g;
    vec3 chalk = uLine * ( 0.9 + 0.1 * nz3.r );
    float lineCov = lines * ( 0.82 + 0.18 * smoothstep( 0.25, 0.6, nz3.b ) ) * ( 1.0 - worn * 0.7 );
    c = mix( c, chalk, lineCov );
    rough = mix( 0.82, 0.7, lineCov ) + 0.1 * worn;
    nW = grainNormal( p, 2.3, mix( 0.7, 0.3, worn ) );
  }
  return c;
}
`;
