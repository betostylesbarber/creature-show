import * as THREE from "three";

// Ground mist computed inside each material's shader: thick near the ground, thinning out by
// about a metre up, and drifting with the wind. Unlike flat fog planes it wraps around graves
// and legs instead of slicing through them with a hard line.
export const mist = {
  time: { value: 0 },
  ground: { value: 0.4 }, // ground height of the cemetery, metres
  height: { value: 0.9 }, // how high the mist reaches
  density: { value: 0.05 }, // how quickly it builds up with distance
  color: { value: new THREE.Color(0x262c37) }, // moonlit mist, darker than the moon itself
  flash: { value: 0 }, // lightning lights the mist up
  wet: { value: 0.5 }, // how wet the cemetery is (the weather sets it): 0 dry, 1 soaked
};

// One wind for the whole scene: mist drift, leaves, rain slant and swaying plants.
export const wind = {
  time: { value: 0 },
  strength: { value: 0.3 },
};

// Sways foliage in the wind: the higher above its base a vertex is, the more it moves, so
// pumpkins and stones stay put while grass tips and branches move.
export function addWindSway(material, { ground = 0.4, reach = 2.2, amount = 0.035 } = {}) {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    shader.uniforms.windTime = wind.time;
    shader.uniforms.windStrength = wind.strength;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float windTime, windStrength;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          vec3 swayWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          float lift = clamp((swayWorld.y - ${ground.toFixed(3)}) / ${reach.toFixed(3)}, 0.0, 1.0);
          float phase = windTime * 1.6 + swayWorld.x * 0.7 + swayWorld.z * 0.5;
          float sway = (sin(phase) * 0.7 + sin(phase * 2.3 + 1.7) * 0.3) * windStrength * ${amount.toFixed(4)} * lift * lift;
          // World-space push turned back into the mesh's own rotated, scaled space.
          float s2 = max(dot(modelMatrix[0].xyz, modelMatrix[0].xyz), 1e-8);
          transformed += transpose(mat3(modelMatrix)) * vec3(sway, 0.0, sway * 0.45) / s2;
        }`,
      );
  };
  material.customProgramCacheKey = () => `wind|${previousKey ? previousKey() : ""}`;
  material.needsUpdate = true;
}

const VERTEX_PARS = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vMistWorld;`;

const VERTEX = /* glsl */ `
#include <fog_vertex>
{
  vec4 mistWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mistWorld = instanceMatrix * mistWorld;
  #endif
  vMistWorld = (modelMatrix * mistWorld).xyz;
}`;

const FRAGMENT_PARS = /* glsl */ `
#include <fog_pars_fragment>
varying vec3 vMistWorld;
uniform float mistTime, mistGround, mistHeight, mistDensity, mistFlash, mistWet;
uniform vec3 mistColor;
float mistHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float mistNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mistHash(i), mistHash(i + vec2(1, 0)), u.x), mix(mistHash(i + vec2(0, 1)), mistHash(i + vec2(1, 1)), u.x), u.y);
}`;

// Rain-wet surfaces: whatever faces the sky gets darker and glossier as it soaks, and on the
// ground (MIST_PUDDLES) shallow puddles collect in patches, near-mirror smooth and flat, so the
// candles and the moon glint in them. Walls and the sides of graves stay mostly dry.
const WET = /* glsl */ `
#include <normal_fragment_maps>
#ifdef MIST_WET
{
  vec3 skyView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float facing = smoothstep(0.45, 0.9, dot(normal, skyView));
  float wetness = mistWet * facing;
  #ifdef MIST_PUDDLES
    float near = 1.0 - smoothstep(0.08, 0.25, vMistWorld.y - mistGround);
    float pool = smoothstep(0.6, 0.7, mistNoise(vMistWorld.xz * 0.55 + 3.7) * 0.7 + mistNoise(vMistWorld.xz * 1.7) * 0.3);
    float puddle = pool * near * facing * smoothstep(0.3, 0.8, mistWet);
    normal = normalize(mix(normal, skyView, puddle * 0.85));
    roughnessFactor = mix(roughnessFactor, 0.05, puddle);
    diffuseColor.rgb *= mix(1.0, 0.55, puddle);
  #endif
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, wetness);
  diffuseColor.rgb *= mix(1.0, 0.75, wetness);
}
#endif`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  float mistLayer = 1.0 - clamp((vMistWorld.y - mistGround) / mistHeight, 0.0, 1.0);
  mistLayer *= mistLayer;
  vec2 mp = vMistWorld.xz * 0.32 + vec2(mistTime * 0.045, mistTime * 0.025);
  float mistN = mistNoise(mp) * 0.65 + mistNoise(mp * 2.3 - vec2(mistTime * 0.03, 0.0)) * 0.35;
  // Drifting banks with gaps between them (not an even sheet), so the land, the graves and the
  // undergrowth beyond the fence show through.
  float banks = smoothstep(0.28, 0.78, mistN);
  float mistAmount = mistLayer * (1.0 - exp(-mistDensity * vFogDepth)) * (0.15 + 0.85 * banks);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mistColor * (1.0 + mistFlash * 2.5), clamp(mistAmount, 0.0, 0.38));
#endif
#include <fog_fragment>`;

// Adds the mist to a material, keeping any shader patch it already has (e.g. gloss maps).
// Materials marked userData.wet (the cemetery's) also get wet in the rain, and those marked
// userData.puddles (the ground and the path) collect puddles.
export function addMist(material) {
  if (!material || material.userData.mist || material.fog === false || material.isShaderMaterial || material.isSpriteMaterial || material.isPointsMaterial || material.isLineBasicMaterial) return;
  material.userData.mist = true;
  const wet = Boolean(material.userData.wet && material.isMeshStandardMaterial);
  if (wet) {
    material.defines = { ...material.defines, MIST_WET: "" };
    if (material.userData.puddles) material.defines.MIST_PUDDLES = "";
  }
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, {
      mistTime: mist.time,
      mistGround: mist.ground,
      mistHeight: mist.height,
      mistDensity: mist.density,
      mistColor: mist.color,
      mistFlash: mist.flash,
      mistWet: mist.wet,
    });
    shader.vertexShader = shader.vertexShader.replace("#include <fog_pars_vertex>", VERTEX_PARS).replace("#include <fog_vertex>", VERTEX);
    shader.fragmentShader = shader.fragmentShader.replace("#include <fog_pars_fragment>", FRAGMENT_PARS).replace("#include <fog_fragment>", FRAGMENT);
    if (wet) shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", WET);
  };
  material.customProgramCacheKey = () => `mist${wet ? "|wet" : ""}|${previousKey ? previousKey() : ""}`;
  material.needsUpdate = true;
}

export function addMistToScene(scene) {
  scene.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) addMist(m);
  });
}
