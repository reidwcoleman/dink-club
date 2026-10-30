import * as THREE from 'three';

/**
 * Shading for the people: the skin and hair lighting spliced into three's physical
 * model, shared by the single-person materials (Humans.ts) and the instanced crowd
 * (Crowd.ts). The Rocketbox scans carry their own shape, skin detail, cloth and eyes.
 *
 *  - skin lighting: per-channel wrapped diffuse (light bleeding red past the terminator,
 *    the look of subsurface scattering) and a second tighter specular lobe (skin oil).
 *  - hair lighting: Kajiya-Kay, two shifted lobes along the strand direction.
 *  - skin tones from a palette of real skin albedos (choosing a face for a look);
 *    white cloth kept at a real white's albedo.
 */

export const NOISE_GLSL = /* glsl */ `
float apHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float apNoise( vec3 x ) {
  vec3 i = floor( x ); vec3 f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( apHash( i ), apHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( apHash( i + vec3( 0, 1, 0 ) ), apHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( apHash( i + vec3( 0, 0, 1 ) ), apHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( apHash( i + vec3( 0, 1, 1 ) ), apHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
`;

/**
 * Lighting hooks spliced into three's physical lighting (MeshStandard/Physical):
 * gSkin (0..1) turns on the skin model, gHair (0..1) the strand model along gHairT
 * (view space). APEX_PEOPLE_LIGHTS must be defined for the hooks to compile in.
 */
export const LIGHT_GLOBALS = /* glsl */ `
float gSkin = 0.0;
float gHair = 0.0;
vec3 gHairT = vec3( 0.0, 1.0, 0.0 );
float gHairShift = 0.0;
vec3 gHairTint = vec3( 1.0 );
`;

let _lights: string | null = null;
/** three's lights_physical_pars_fragment with the skin and hair models spliced in */
export function peopleLightsChunk(): string {
  if (_lights) return _lights;
  let s = THREE.ShaderChunk.lights_physical_pars_fragment;
  const diffLine = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
  const specLine = 'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;';
  if (!s.includes(diffLine) || !s.includes(specLine)) {
    console.warn('[people] three lighting chunk changed: skin/hair lighting disabled');
    return (_lights = s);
  }
  s = s.replace(
    specLine,
    `{
  float ndlH = dot( geometryNormal, directLight.direction );
  if ( gHair > 0.0 ) {
    // Kajiya-Kay: a white primary lobe and a coloured, broader secondary, shifted along the strand
    vec3 H = normalize( directLight.direction + geometryViewDir );
    vec3 t1 = normalize( gHairT + geometryNormal * ( 0.12 + gHairShift ) );
    vec3 t2 = normalize( gHairT + geometryNormal * ( -0.1 + gHairShift ) );
    float d1 = dot( t1, H ), d2 = dot( t2, H );
    float s1 = pow( max( 0.0, 1.0 - d1 * d1 ), 48.0 );
    float s2 = pow( max( 0.0, 1.0 - d2 * d2 ), 10.0 );
    float att = smoothstep( -0.15, 0.35, ndlH );
    vec3 kk = ( s1 * 0.055 * mix( vec3( 1.0 ), gHairTint, 0.4 ) + s2 * 0.12 * gHairTint ) * att * directLight.color;
    reflectedLight.directSpecular += mix( irradiance * specularBRDF * material.multiScatteringCompensation, kk, gHair );
  } else {
    reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;
  }
  if ( gSkin > 0.0 ) {
    // a second, tighter lobe: the oily sheen over the rougher skin
    PhysicalMaterial m2 = material;
    m2.roughness = max( 0.3, material.roughness * 0.6 );
    reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, m2 ) * 0.12 * gSkin;
  }
}`,
  );
  s = s.replace(
    diffLine,
    `vec3 apIrr = irradiance;
if ( gSkin > 0.0 || gHair > 0.0 ) {
  // wrapped diffuse: red scatters furthest under the skin, so it wraps furthest past the terminator
  float ndl = dot( geometryNormal, directLight.direction );
  vec3 wr = mix( vec3( 0.28 ), vec3( 0.5, 0.22, 0.14 ), gSkin / max( gSkin + gHair, 1e-3 ) );
  vec3 wrapped = clamp( ( ndl + wr ) / ( 1.0 + wr ), 0.0, 1.0 );
  wrapped = wrapped * sqrt( wrapped );
  // the shadow term is already in directLight.color
  apIrr = mix( irradiance, wrapped * directLight.color, max( gSkin, gHair ) );
}
reflectedLight.directDiffuse += apIrr * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );`,
  );
  return (_lights = s);
}

// ------------------------------------------------------------------------------------ skin tones
/** skin albedos (linear), very fair → very deep, after measured reflectance spectra */
const SKIN_RAMP: [number, number, number][] = [
  [0.64, 0.39, 0.28], [0.59, 0.345, 0.23], [0.52, 0.29, 0.185], [0.44, 0.25, 0.155], [0.35, 0.19, 0.115],
  [0.26, 0.145, 0.088], [0.18, 0.1, 0.062], [0.125, 0.07, 0.046], [0.088, 0.05, 0.035],
];

/** a skin albedo for tone 0 (fair) … 1 (deep), with an undertone −1 (pink) … +1 (olive / golden) */
export function skinColor(tone: number, undertone = 0, out = new THREE.Color()): THREE.Color {
  const t = THREE.MathUtils.clamp(tone, 0, 1) * (SKIN_RAMP.length - 1);
  const i = Math.min(SKIN_RAMP.length - 2, Math.floor(t));
  const a = new THREE.Color().fromArray(SKIN_RAMP[i]), b = new THREE.Color().fromArray(SKIN_RAMP[i + 1]);
  out.copy(a).lerp(b, t - i);
  // undertone: pink pulls red up and green down, olive the other way (subtle)
  const u = THREE.MathUtils.clamp(undertone, -1, 1) * 0.05;
  out.r *= 1 - u * 0.4;
  out.g *= 1 + u * 0.5;
  out.b *= 1 - u * 0.5;
  return out;
}

/** a real white fabric reflects ~60-65 %, never 100 % (keeps kit whites well clear of the bloom threshold under a strong sun) */
export const CLOTH_WHITE_MAX = 0.6;
