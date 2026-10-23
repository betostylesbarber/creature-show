import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";

// Film look applied after tone mapping: a restrained split-tone grade (cool shadows, warm
// highlights), a soft vignette, the lightning flash and very fine grain. Heavy grain or lens
// fringing would read as noise after TikTok's encoder, so both stay subtle.
const FilmShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    flash: { value: 0 },
    tint: { value: new THREE.Color(1, 1, 1) },
    vignette: { value: 0.55 },
    grain: { value: 0.01 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, flash, vignette, grain;
    uniform vec3 tint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, c * vec3(0.92, 0.96, 1.06), (1.0 - smoothstep(0.0, 0.4, l)) * 0.5);  // cool shadows
      c = mix(c, c * vec3(1.05, 1.0, 0.93), smoothstep(0.45, 1.0, l) * 0.4);           // warm highlights
      c = mix(vec3(l), c, 1.04);                                                      // saturation
      c *= tint;
      c += flash * vec3(0.32, 0.36, 0.45);
      vec2 d = vUv - 0.5;
      c *= mix(1.0, smoothstep(0.95, 0.2, length(d * vec2(1.0, 0.75))), vignette);
      c += (hash(vUv * 1000.0 + time) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// Quality profiles are defined by the frame they actually render (its long edge in pixels), not
// by a multiplier, so "Ultra" is a native 2160x3840 frame whatever size the capture window is.
// A 1080x1920 OBS source on Ultra renders 2160x3840 and OBS downsamples it (supersampling); a
// 2160x3840 source renders it 1:1.
export const QUALITY = {
  low: { long: 1920, bloom: false, smaa: true, shadows: false, shadowSize: 1024 },
  medium: { long: 1920, bloom: true, smaa: true, shadows: true, shadowSize: 2048 },
  high: { long: 2880, bloom: true, smaa: true, shadows: true, shadowSize: 4096 },
  ultra: { long: 3840, bloom: true, smaa: true, shadows: true, shadowSize: 4096 },
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    // Only HDR highlights (flames, the moon, lightning) bloom; ordinary bright surfaces do not.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.32, 0.35, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    this.film = new ShaderPass(FilmShader);
    this.composer.addPass(this.film);
    this.tintTarget = new THREE.Color(1, 1, 1);
  }

  setQuality(name) {
    const q = QUALITY[name] || QUALITY.high;
    this.quality = q;
    this.bloom.enabled = q.bloom;
    this.smaa.enabled = q.smaa;
    return q;
  }

  // Device-pixel ratio that makes a w x h CSS frame render at the profile's native size.
  pixelRatioFor(w, h) {
    return THREE.MathUtils.clamp((this.quality?.long || 2880) / Math.max(w, h), 0.5, 4);
  }

  setSize(w, h, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  // Blood moon and other events colour the whole frame.
  setTint(color) {
    this.tintTarget.set(color);
  }

  render(t, dt, flash = 0) {
    const u = this.film.uniforms;
    u.time.value = t % 100;
    u.flash.value = flash * 0.45;
    u.tint.value.lerp(this.tintTarget, Math.min(1, dt * 1.5));
    this.composer.render(dt);
  }
}
