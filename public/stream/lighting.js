import * as THREE from "three";

// Night lighting for the cemetery: cold moonlight from behind the crypt that rims everything
// and casts long shadows towards the camera, a dim sky fill, image-based reflections from the
// night sky, and distant lightning that lights the scene from the sky behind it. Every flash
// reports when its thunder should arrive (later and quieter the further away it was).
export function buildNightLighting(scene, renderer, { moonDir, box, onThunder }) {
  const center = box.getCenter(new THREE.Vector3());
  const moonIntensity = 1.9;
  const moon = new THREE.DirectionalLight(0xa4b4d6, moonIntensity);
  moon.position.copy(center).addScaledVector(moonDir, 24).setY(18);
  moon.target.position.copy(center);
  moon.castShadow = true;
  moon.shadow.mapSize.set(4096, 4096);
  moon.shadow.bias = -0.0003;
  moon.shadow.normalBias = 0.025;
  Object.assign(moon.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 60 });
  scene.add(moon, moon.target);

  const hemiIntensity = 0.32;
  const hemi = new THREE.HemisphereLight(0x2c3650, 0x17110d, hemiIntensity);
  const ambient = new THREE.AmbientLight(0x161a24, 0.12);
  scene.add(hemi, ambient);

  // The lightning's own light: a flash from somewhere in the sky behind the cemetery.
  const bolt = new THREE.DirectionalLight(0xc9d6ff, 0);
  bolt.target.position.copy(center);
  scene.add(bolt, bolt.target);

  // Reflections and soft ambient light from a dim night sky: blue-grey above, ember horizon.
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: "varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "varying vec3 d; void main(){ float h = d.y; vec3 c = mix(vec3(0.12,0.07,0.05), vec3(0.04,0.05,0.09), smoothstep(-0.1,0.3,h)); c = mix(c, vec3(0.01,0.012,0.025), smoothstep(0.3,1.0,h)); c += vec3(0.5,0.55,0.7) * pow(max(dot(d, normalize(vec3(-0.22,0.2,-1.0))),0.0), 40.0) * 2.5; gl_FragColor = vec4(c,1.0); }",
    }),
  );
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();

  let lightning = 0;
  let flickerSeed = 0;
  // A soft coloured wash over the whole scene for gift events (the Galaxy's starlight, the
  // Lion's gold), carried by the sky light so no light is ever added or removed at run time
  // (that would recompile every shader in the scene).
  let aura = 0;
  const auraColor = new THREE.Color();
  const hemiSky = hemi.color.clone();
  let nextDistant = 20 + Math.random() * 20;
  const flashFrom = (distance) => {
    // Somewhere behind the cemetery, high in the sky.
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
    bolt.position.copy(center).add(new THREE.Vector3(Math.cos(a) * 30, 22, Math.sin(a) * 30));
    flickerSeed = Math.random() * 10;
    onThunder?.({ delay: distance / 343, strength: Math.min(1, 6 / distance) });
  };
  return {
    moon,
    // A strike in the scene (gift lightning): close, bright, thunder almost at once.
    strike(strength = 1) {
      lightning = Math.max(lightning, strength);
      flashFrom(150 + Math.random() * 250);
    },
    setAura(strength, color = 0xffffff) {
      aura = Math.max(0, strength);
      auraColor.set(color);
    },
    setShadows(enabled, size) {
      moon.castShadow = enabled;
      if (moon.shadow.mapSize.x !== size) {
        moon.shadow.mapSize.set(size, size);
        moon.shadow.map?.dispose();
        moon.shadow.map = null;
      }
    },
    // Returns the current flash level so the sky, clouds, mist and film grade can follow it.
    update(t, dt, storminess = 0) {
      // Distant lightning now and then; often during a storm.
      nextDistant -= dt * (1 + storminess * 6);
      if (nextDistant <= 0) {
        lightning = Math.max(lightning, 0.35 + Math.random() * 0.3);
        flashFrom(1200 + Math.random() * 2500);
        nextDistant = storminess ? 4 + Math.random() * 8 : 30 + Math.random() * 45;
      }
      // Real lightning flickers: a few return strokes, not a smooth fade.
      const flicker = lightning > 0.15 ? 0.55 + 0.45 * Math.max(0, Math.sin(t * 47 + flickerSeed) + Math.sin(t * 29 + flickerSeed * 2)) : 1;
      const flash = Math.min(1.2, lightning * flicker);
      bolt.intensity = flash * 6;
      moon.intensity = moonIntensity + flash * 0.8;
      hemi.intensity = hemiIntensity + flash * 1.2 + aura * 0.9;
      hemi.color.copy(hemiSky).lerp(auraColor, Math.min(1, aura));
      lightning = Math.max(0, lightning - dt * 2.2);
      return flash;
    },
  };
}
