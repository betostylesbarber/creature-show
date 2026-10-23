import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { buildRoom } from "./scene.js";
import { loadEnvironment } from "./env.js";
import { buildSky, buildOuterWoods, HAZE } from "./sky.js";
import { buildTerrain, buildSurroundings } from "./surroundings.js";
import { buildNightLighting } from "./lighting.js";
import { Weather } from "./weather.js";
import { Bats, Ghosts, Bolts, Fireworks } from "./spooky.js";
import { Creature } from "./creature.js";
import { RiggedCreature } from "./rigged.js";
import { PRIORITY } from "./motion.js";
import { DustBursts, GiftStone, NeckSparks } from "./effects3d.js";
import { PostFX } from "./post.js";
import { Overlay } from "./overlay.js";
import { AudioOut } from "./audio.js";
import { mist, wind, addMistToScene } from "./mist.js";
import { Arcs, buildCoils } from "./signatures.js";
import { EventDirector, buildApparatus } from "./events.js";
import { Activities } from "./activities.js";
import { hub } from "./hub.js";
import { initSound } from "./sound/index.js";
import { initChoices } from "./choices.js";

const params = new URLSearchParams(location.search);
const preview = params.get("preview") === "1"; // the small muted copy inside the panel
const landscape = params.get("layout") === "landscape";
const debug = params.get("debug") === "1"; // free orbit camera for exploring the scene

const ACTION_LABELS = {
  nod: "a nod", wave: "a wave", bow: "a bow", flex: "a flex", jacks: "jumping jacks", dance: "a dance", roar: "a roar",
  spin: "a spin", stomp: "a stomp", kneel: "a moment of mourning", backflip: "a backflip", pushups: "push-ups", handstand: "a handstand",
  walk_center: "him to come back", walk_front: "him to come closer", walk_gate: "the gate", walk_crypt: "the crypt",
  walk_left_graves: "the old graves", walk_right_graves: "the graves", walk_pumpkins: "the pumpkins", walk_tree: "the dead tree",
};

const stage = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(landscape ? 40 : 50, 9 / 16, 0.05, 200);
camera.position.set(0.5, 2.2, 4.6);

// The gift events' camera: one shot at a time, checked before it is used. A shot must stay
// inside the cemetery, above the ground, with nothing solid between it and what it looks at
// and no foliage filling the lens; otherwise it is refused and the normal camera carries on.
let eventShot = null;
let releasedShot = false; // an event shot was on screen last frame
const cameraRig = {
  // { pos, look, fov, subject, track }: `subject` is where he will be (for the visibility check,
  // default where he is now); `track()` returns a point the camera keeps looking at (his head on
  // an approach). A shot far from the current camera is a cut, not a sweep through the scenery.
  set(shot) {
    const ok = shotIsClear(shot.pos, shot.look, shot.subject);
    if (ok) eventShot = { pos: shot.pos.clone(), look: shot.look.clone(), fov: shot.fov, track: shot.track, cut: camera.position.distanceTo(shot.pos) > 2.5 };
    return ok;
  },
  clear() {
    eventShot = null;
  },
  get active() {
    return !!eventShot;
  },
};
function shotIsClear(pos, look, subject = avatar.root.position) {
  if (!environment) return false;
  const b = environment.groundBox;
  if (pos.x < b.min.x + 0.5 || pos.x > b.max.x - 0.5 || pos.z < b.min.z + 0.6 || pos.z > 4.8) return false;
  if (pos.y < ground(pos.x, pos.z) + 0.7 || pos.y > 5) return false;
  if (pos.distanceTo(look) < 1.5) return false;
  const dir = pos.clone().sub(look);
  ray.set(look, dir.clone().normalize());
  ray.far = dir.length();
  if (ray.intersectObjects(occluders, false).length) return false;
  return !foliageInLens(pos, look) && bodyInView(pos, subject);
}

// Most of him must be in plain view: a shot where a prop (the hanging skeleton, a headstone)
// covers his legs, chest or head is refused even when the look point itself is clear.
function bodyInView(pos, root) {
  const side = new THREE.Vector3(pos.z - root.z, 0, root.x - pos.x).normalize();
  const points = [[0, 0.55], [0, 1.15], [0, 1.85], [0.24, 1.2], [-0.24, 1.2]].map(([s, h]) => root.clone().addScaledVector(side, s).add(new THREE.Vector3(0, h, 0)));
  let hidden = 0;
  for (const p of points) {
    const dir = p.clone().sub(pos);
    ray.set(pos, dir.clone().normalize());
    ray.far = dir.length() - 0.3;
    if (ray.intersectObjects(solidProps, false).length) hidden++;
  }
  return hidden < 2;
}

const [config, initialSettings] = await Promise.all([
  fetch("/api/character").then((r) => r.json()),
  fetch("/api/settings").then((r) => r.json()),
]);
let settings = initialSettings;

// --- World ---------------------------------------------------------------------------
let environment = null;
if (config.environment?.model) {
  try {
    environment = await loadEnvironment(config.environment, scene, renderer);
  } catch (error) {
    console.warn("Could not load the environment model, using the built-in room.", error);
  }
}
const spots = environment && config.environment.spots ? config.environment.spots : null;
const groundFallback = config.environment?.groundFallback ?? 0;
const ground = environment ? (x, z) => environment.groundAt(x, z, groundFallback) : () => 0;

let room = null;
let sky = null;
let lighting = null;
let weather = null;
let bats = null;
let ghosts = null;
let bolts = null;
let fireworks = null;
let stone = null;
const audio = new AudioOut({ muted: preview });
if (environment) {
  const box = environment.box;
  sky = buildSky(scene);
  // The land beyond the fence: rolling ground, an old overgrown graveyard and a wood of the
  // cemetery's own trees and bushes, then silhouettes only far away where they can't look flat.
  // The ground behind the gate stays clear for the Doctor's apparatus.
  const gateAt = config.environment.spots?.gate?.at;
  const keepClear = gateAt ? [-1.5, 1.7].map((dx) => ({ x: gateAt[0] + dx, z: environment.groundBox.min.z - 0.55, r: 0.7 })).concat([{ x: gateAt[0], z: environment.groundBox.min.z - 1.0, r: 1.1 }]) : [];
  const terrain = environment.soilMap ? buildTerrain(scene, environment.groundBox, environment.soilMap, groundFallback) : null;
  if (terrain) buildSurroundings(scene, environment, { box: environment.groundBox, heightAt: terrain.heightAt, keepClear, config: { wind: config.environment.materials?.plants?.wind } });
  buildOuterWoods(scene, environment.groundBox, groundFallback);
  lighting = buildNightLighting(scene, renderer, { moonDir: sky.moonDir, box, onThunder: (t) => {
    audio.thunder(t);
    hub.emit("lightning", t);
  } });
  // Distance haze is the sky's own horizon colour, so the far ground melts into the skyline
  // layers and the sky; the ground mist lives in each material (mist.js).
  scene.fog = new THREE.FogExp2(HAZE.clone(), 0.02);
  mist.ground.value = environment.groundAt(0.5, 0.6, 0.4);
  weather = new Weather(scene, box, environment.surfaceAt);
  bats = new Bats(scene, box.getCenter(new THREE.Vector3()));
  ghosts = new Ghosts(scene);
  bolts = new Bolts(scene);
  fireworks = new Fireworks(scene);
  // Placed where it is visible behind him but does not block any way through the graves.
  const [sx, sz] = config.environment.giftStone?.at || [-1.35, -2.2];
  stone = new GiftStone(scene, new THREE.Vector3(sx, ground(sx, sz) - 0.02, sz), config.environment.giftStone?.rotationY ?? 0.15);
  environment.nav.block(sx, sz, 0.45); // he walks round it like any other grave
} else {
  room = buildRoom(scene);
}

const CRYPT_DOOR = new THREE.Vector3(-4.8, 1.8, -3.0);
const GRAVES = [[-3.0, 1.0], [3.4, 0.0], [-2.6, -3.0], [4.2, -1.2], [-4.2, 0.4], [3.9, 1.6], [2.6, -3.6], [-3.4, 2.6]].map(
  ([x, z]) => new THREE.Vector3(x, ground(x, z), z),
);

const overlay = new Overlay(stage, { onLightning: () => lighting?.strike(0.8) ?? room?.flashLightning() });
const dust = new DustBursts(scene);
const sparks = new NeckSparks(scene);
let shake = 0;

let avatar = null;
let events = null; // the five Halloween gift events (events.js)
let activities = null; // what he does by himself between conversations (activities.js)
const avatarOptions = {
  ground,
  nav: environment?.nav || null,
  onImpact: (strength) => {
    shake = Math.max(shake, strength);
    dust.burst(avatar.root.position, strength);
    hub.emit("impact", { strength });
  },
  // During the reanimation the lightning really strikes him: from the apparatus when the
  // milestone event is running, otherwise from the sky.
  onFlash: () => {
    const target = avatar.root.position.clone().add(new THREE.Vector3(0, 2.4, 0));
    const coil = events?.apparatusActive && coils?.coils[Math.floor(Math.random() * coils.coils.length)];
    bolts?.strike(target, { color: 0xbfffd0, from: coil ? coil.top.clone() : undefined });
    lighting?.strike(1);
    overlay.bolt();
    hub.emit("flash", {});
  },
  // Named moments of his stunts (the celebration's climax, the reanimation's rise), so gift
  // events peak exactly with him.
  onMarker: (stunt, name) => {
    events?.marker(stunt, name);
    hub.emit("stunt", { name: stunt, marker: name });
  },
  // Each heel strike, with what he is standing on.
  onStep: (foot, strength, inPlace) => {
    const p = avatar.root.position;
    hub.emit("step", { foot, strength, inPlace, position: p.clone(), surface: environment?.surfaceKind(p.x, p.z) ?? "stone", speed: avatar.locomotion?.speed ?? 0 });
  },
};
if (config.model) {
  try {
    avatar = await RiggedCreature.load(scene, spots || room.spots, config, avatarOptions);
  } catch (error) {
    console.warn("Could not load the character model, using the built-in creature.", error);
  }
}
avatar ??= new Creature(scene, spots || room.spots, avatarOptions);

// Three lights keep his face readable on a phone without looking spot-lit: a soft, warm key
// from a lantern just off camera to the right, a dim cool fill from the camera's side that opens
// up the shadows under his brow, and a cold rim from the moon side that separates him from the
// graves behind. The fill's cone is narrow, so it lifts his face and not the whole path.
const keyLight = new THREE.SpotLight(0xffd8b0, 9.5, 12, 0.55, 1, 1.3);
keyLight.target = avatar.root;
scene.add(keyLight);
const faceTarget = new THREE.Object3D();
const faceFill = new THREE.SpotLight(0xd6deef, 5, 8, 0.26, 1, 1.4);
faceFill.target = faceTarget;
scene.add(faceFill, faceTarget);
const rimLight = new THREE.PointLight(0x9fb4e0, 7, 7, 1.5);
scene.add(rimLight);
// The Doctor's apparatus outside the back fence, either side of the gate, for the reanimation.
const gateSpot = spots?.gate?.at;
const coils = environment && gateSpot ? buildCoils(scene, new THREE.Vector3(gateSpot[0], 0, environment.groundBox.min.z - 0.55), ground) : null;
const arcs = new Arcs(scene);
// Its switch box, just inside the fence by the gate, wired to the coils.
const roadBox = environment?.meshes.road ? new THREE.Box3().setFromObject(environment.meshes.road) : null;
const apparatus = coils ? buildApparatus(scene, { gate: { x: gateSpot[0], z: gateSpot[1] }, fenceZ: environment.groundBox.min.z, ground, surfaceAt: environment.surfaceAt, coils, nav: environment.nav, center: spots?.center?.at, path: roadBox && { min: roadBox.min.x, max: roadBox.max.x } }) : null;

if (environment) addMistToScene(scene);

const post = new PostFX(renderer, scene, camera);
events = new EventDirector({ scene, camera, avatar, sky, lighting, post, environment, weather, arcs, coils, apparatus, bolts, sparks, bats, hub, spots: spots || {}, ground, nav: environment?.nav || null, gate: gateSpot ? { x: gateSpot[0], z: gateSpot[1] } : null, fenceZ: environment?.groundBox.min.z, get speech() { return speech; }, cameraRig, send: (m) => !preview && send(m), log: (text) => !preview && send({ t: "eventLog", text }), shake: (s) => (shake = Math.max(shake, s)) });
// Camera checks raycast the cemetery many times a second (occlusion, clear shots, his body in
// view); a bounding-volume tree makes each ray a fraction of a millisecond instead of ~7 ms over
// 120k triangles. Built after the events have trimmed the wisps, since it reorders the triangles.
if (environment) {
  for (const m of Object.values(environment.meshes)) {
    m.geometry.computeBoundsTree = computeBoundsTree;
    m.geometry.computeBoundsTree();
    m.raycast = acceleratedRaycast;
  }
}

// --- Gift effects --------------------------------------------------------------------
let stormUntil = 0;
let bloodUntil = 0;
function storm(seconds) {
  stormUntil = Math.max(stormUntil, performance.now() + seconds * 1000);
  weather?.setStorm(1);
}
// The likes milestone: a free scene change for the whole chat. Warm light builds for three
// seconds, holds while every pumpkin and candle burns bright, then eases back to normal.
let harvest = null;
const harvestTint = new THREE.Color();
function harvestMoon() {
  harvest = { start: performance.now() };
  overlay.announce("Harvest moon", "Thank you for the likes, everyone", "gold");
}
function updateHarvest(now) {
  if (!harvest) return;
  const s = (now - harvest.start) / 1000;
  const h = s < 3 ? s / 3 : s < 18 ? 1 : Math.max(0, 1 - (s - 18) / 7);
  environment?.flare(0.9 * h);
  if (!bloodUntil) post.setTint(harvestTint.set(0xffffff).lerp(new THREE.Color(0xffe2bd), h));
  if (s >= 25) harvest = null;
}

// Now and then something happens on its own: a lone ghost drifts up from a grave.
let nextAmbient = 180 + Math.random() * 120;
function updateAmbient(dt) {
  if ((nextAmbient -= dt) > 0 || !ghosts) return;
  ghosts.rise([GRAVES[Math.floor(Math.random() * GRAVES.length)]]);
  nextAmbient = 240 + Math.random() * 180;
}

function bloodMoon(seconds) {
  bloodUntil = Math.max(bloodUntil, performance.now() + seconds * 1000);
  sky?.setBloodMoon(true);
  post.setTint(0xffd2c8);
}

function effect(name) {
  const at = avatar.root.position;
  hub.emit("effect", { name });
  switch (name) {
    case "sparks":
      if (avatar.neckBolts) sparks.fire(() => avatar.neckBolts(), 1.3);
      environment?.flare(0.4);
      break;
    case "pumpkins":
      environment?.flare(1.4);
      overlay.effect("sparks");
      break;
    case "bats":
      overlay.effect("bats");
      bats?.swarm(CRYPT_DOOR, 18);
      break;
    case "lightning":
      bolts?.strike(new THREE.Vector3(at.x + (Math.random() - 0.5) * 8, ground(at.x, at.z - 4), at.z - 4 - Math.random() * 3));
      lighting?.strike(1);
      overlay.bolt();
      break;
    case "ghosts":
      ghosts?.rise(GRAVES.slice().sort(() => Math.random() - 0.5).slice(0, 5));
      break;
    case "fireworks":
      fireworks?.launch(7);
      break;
    case "bloodmoon":
      bloodMoon(60);
      break;
    case "storm":
      storm(25);
      effect("lightning");
      setTimeout(() => effect("lightning"), 700);
      bats?.swarm(CRYPT_DOOR, 30);
      overlay.effect("storm");
      break;
  }
}

// --- Settings: layout, graphics quality and music ------------------------------------
// TikTok streams at 30 or 60 fps (30 by default here). Drawing faster only takes the graphics
// card away from the local AI; ?fps= in the address overrides the setting.
let frameInterval = 1000 / 30;

// Music plays through the audio mixer, which ducks it smoothly under speech.
let trackIndex = 0;
function playNextTrack() {
  const tracks = settings.music?.tracks || [];
  if (!tracks.length || preview) return audio.playMusic(null, 0);
  trackIndex = (trackIndex + 1) % tracks.length;
  audio.playMusic(`/assets/music/${encodeURIComponent(tracks[trackIndex])}`, settings.music?.volume ?? 0.25);
}
audio.music.addEventListener("ended", playNextTrack);

function applySettings(next) {
  const musicChanged = JSON.stringify(next.music?.tracks) !== JSON.stringify(settings.music?.tracks);
  settings = next;
  const layout = settings.layout || {};
  stage.style.setProperty("--subtitle-y", `${layout.subtitleY ?? 60}%`);
  stage.style.setProperty("--comment-y", `${layout.commentY ?? 13}%`);
  stage.style.setProperty("--banner-y", `${layout.giftBannerY ?? 30}%`);
  stage.classList.toggle("hide-top-gifter", layout.showTopGifter === false);
  frameInterval = 1000 / (Number(params.get("fps")) || settings.fps || 30);
  const q = post.setQuality(preview ? "low" : settings.graphics);
  renderer.shadowMap.enabled = q.shadows;
  lighting?.setShadows(q.shadows, q.shadowSize);
  resize();
  audio.setMusicVolume(settings.music?.volume ?? 0.25);
  if (musicChanged) {
    trackIndex = -1;
    playNextTrack();
  }
}

function resize() {
  const ratio = landscape ? 16 / 9 : 9 / 16;
  let w = innerWidth;
  let h = innerHeight;
  if (w / h > ratio) w = h * ratio;
  else h = w / ratio;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  stage.style.fontSize = `${(w / (landscape ? 1920 : 1080)) * 40}px`;
  // The quality profile fixes the rendered frame size: Ultra renders 2160x3840 whether the
  // window is 1080x1920 (supersampled) or 2160x3840 (native). The small panel preview stays cheap.
  const pr = preview ? Math.min(devicePixelRatio, 1) : post.pixelRatioFor(w, h);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  post.setSize(w, h, pr);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  overlay.resize(w, h);
}
addEventListener("resize", resize);
applySettings(settings);

const unlock = document.getElementById("unlock");
if (!preview && !audio.running) {
  unlock.hidden = false;
  unlock.onclick = () =>
    audio.unlock().then(() => {
      unlock.hidden = true;
    });
}

// --- Speech: lines arrive as a stream of clips, sentence by sentence -------------------
// The server starts a line (segStart), may attach the viewer's comment (segComment) and his
// mood (segMood), then sends each clip as soon as its audio is ready: the reader voice first,
// then his reply sentence by sentence. segEnd says nothing more is coming. One scheduler plays
// lines strictly in order and clips strictly in sequence, so voices never overlap. Each clip's
// start is reported back so the server can measure when he is actually heard.
const speech = { talking: false, mood: "warm" };
const lines = []; // lines in arrival order: { id, clips: [], comment, mood, ended, wake }
let running = false;
let cancelWait = null;

const wait = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancelWait = () => {
      clearTimeout(timer);
      resolve();
    };
  });

const estimate = (text) => text.split(/\s+/).length / 2.6 + 0.6;

function lineFor(id) {
  let line = lines.find((l) => l.id === id);
  if (!line) {
    line = { id, clips: [], comment: null, mood: "warm", ended: false, wake: null };
    lines.push(line);
  }
  return line;
}

// Waits until the line has another clip or has ended. Under heavy load sentences can be 10-20 s
// apart, so it waits for the segment's end (the server always sends one, after its own model
// timeout) and gives up only after 45 s; a line given up on is closed, so a clip arriving even
// later is dropped instead of starting a new line out of order.
function nextClip(line, index) {
  if (line.clips[index] || line.ended) return Promise.resolve(line.clips[index]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      line.wake = null;
      line.ended = true;
      skippedIds.add(line.id);
      resolve(line.clips[index]);
    }, 45_000);
    line.wake = () => {
      if (!line.clips[index] && !line.ended) return;
      clearTimeout(timer);
      line.wake = null;
      resolve(line.clips[index]);
    };
  });
}

// Time for viewers to read a message on screen when it is not read out loud.
const readingMs = (text) => Math.min(3500, Math.max(1500, 1000 + String(text).length * 45));

// A line plays in one place on screen: the viewer's message appears in the caption as soon as
// his turn to answer it begins and stays while it is read out, then the caption hands over to
// his reply, sentence by sentence.
async function playLine(line) {
  audio.duck(true); // music and thunder drop under speech
  hub.emit("line", { phase: "start", id: line.id });
  let shownAt = 0;
  const showViewer = () => {
    if (!line.comment || line.replying) return;
    shownAt ||= performance.now();
    line.captionId = overlay.showViewerLine(line.comment);
  };
  line.onComment = showViewer; // the translation can arrive while the message is up
  showViewer();
  for (let i = 0; ; i++) {
    const clip = await nextClip(line, i);
    if (!clip || line.skipped) break;
    if (clip.role === "reader") {
      if (!preview) send({ t: "clipStart", id: line.id, role: "reader" });
      line.readAloud = true;
      hub.emit("speech", { phase: "start", role: "reader", seconds: clip.audio?.duration || 1.5, text: clip.text });
      if (clip.audio) await audio.play(clip.audio, { voice: "reader" });
      else await wait(1500);
      hub.emit("speech", { phase: "end", role: "reader" });
      await wait(150);
      continue;
    }
    // Not read out: leave the message up long enough to read before he answers it.
    if (shownAt && !line.readAloud && !line.replying) {
      const left = readingMs(line.comment.text) - (performance.now() - shownAt);
      if (left > 0) await wait(left);
      if (line.skipped) break;
    }
    line.replying = true;
    if (!preview) send({ t: "clipStart", id: line.id, role: clip.role });
    speech.talking = true;
    speech.mood = line.mood;
    const seconds = clip.audio?.duration || estimate(clip.text);
    line.captionId = overlay.showSubtitle(clip.text, seconds);
    hub.emit("speech", { phase: "start", role: "reply", seconds, text: clip.text });
    if (clip.audio) await audio.play(clip.audio, { voice: "creature" });
    else await wait(seconds * 1000);
    hub.emit("speech", { phase: "end", role: "reply" });
  }
  // The caption lingers a moment after the last word.
  line.onComment = null;
  speech.talking = false;
  audio.duck(false);
  hub.emit("line", { phase: "end", id: line.id });
  const shown = line.captionId;
  if (shown) setTimeout(() => overlay.hideSubtitle(shown), 900);
}
async function runLines() {
  if (running) return;
  running = true;
  while (lines.length) {
    const line = lines[0];
    // While a gift event is being performed his lines wait for its reaction moment.
    await events?.speechGate();
    try {
      await playLine(line);
    } catch (error) {
      console.warn("Line failed", error);
    }
    if (lines[0] === line) lines.shift();
    if (!preview && !line.skipped) send({ t: "segmentDone", id: line.id });
  }
  running = false;
}

// --- Evidence capture: still frames and short recordings, uploaded to the server ------------
// Triggered through the server (/api/capture, /api/record) for rehearsals and before/after
// comparisons. A still can use a fixed camera view; a recording captures the live picture with
// the finished audio mix, exactly as OBS would see and hear the window.
let captureView = null; // { pos: [x, y, z], look: [x, y, z] } overrides the show camera while set
const frames = (n) => new Promise((resolve) => {
  const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve());
  step();
});
const upload = (name, ext, blob) => fetch(`/api/capture/upload?name=${encodeURIComponent(name)}&ext=${ext}`, { method: "POST", body: blob });

async function capture({ name, view }) {
  if (view) {
    captureView = view;
    await frames(30); // shadows and smoothing settle
  }
  // Rendered and read back in the same task, before the browser clears the drawing buffer.
  post.render(timer.getElapsed(), 0, 0);
  const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, "image/jpeg", 0.92));
  captureView = null;
  await upload(name, "jpg", blob);
}

async function record({ name, seconds = 10 }) {
  const stream = renderer.domElement.captureStream(Math.round(1000 / frameInterval));
  try {
    stream.addTrack(audio.recordingTrack());
  } catch (error) {
    console.warn("Recording without sound", error);
  }
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start(1000);
  await new Promise((resolve) => setTimeout(resolve, Math.min(120, seconds) * 1000));
  recorder.stop();
  await stopped;
  stream.getVideoTracks().forEach((t) => t.stop());
  await upload(name, "webm", new Blob(chunks, { type: "video/webm" }));
}

// --- Server connection ---------------------------------------------------------------
let socket = null;
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// Lines the operator stopped: a clip of one that arrives late must not bring it back.
const skippedIds = new Set();
function handle(msg) {
  if (/^(clip|seg)/.test(msg.t) && skippedIds.has(msg.id)) return;
  switch (msg.t) {
    case "segStart":
      lineFor(msg.id);
      runLines();
      break;
    case "segComment": {
      const line = lineFor(msg.id);
      line.comment = msg.comment;
      line.onComment?.();
      break;
    }
    case "segMood":
      lineFor(msg.id).mood = msg.mood;
      break;
    case "clip": {
      const line = lineFor(msg.id);
      line.clips[msg.seq] = msg;
      line.wake?.();
      break;
    }
    case "segEnd": {
      const line = lineFor(msg.id);
      line.ended = true;
      line.wake?.();
      break;
    }
    case "action":
      // Gifts outrank chat commands, which outrank stunts the AI picks for itself.
      avatar.perform(msg.action, { priority: msg.fromGift ? PRIORITY.gift : msg.by ? PRIORITY.command : PRIORITY.ai });
      if (msg.by && !msg.fromGift && ACTION_LABELS[msg.action]) overlay.toast(`${msg.by} asked for ${ACTION_LABELS[msg.action]}`);
      break;
    case "gift":
      overlay.gift(msg);
      // One of the five Halloween events, or (below the first threshold) a brief spark of thanks.
      if (msg.event) events?.play(msg.event);
      else if (avatar.neckBolts) sparks.fire(() => avatar.neckBolts(), 0.5);
      overlay.setTopGifter(msg.topGifter);
      if (msg.newTop && stone) stone.carve(msg.topGifter);
      break;
    case "giftStreak":
      overlay.gift({ ...msg, total: 0, streaking: true });
      break;
    case "milestone":
      harvestMoon();
      break;
    case "meter":
      overlay.setMeter(msg.value, msg.max);
      break;
    case "eventAudition":
      if (msg.event) events?.play(msg.event);
      break;
    case "eventCancel":
      events?.cancel();
      break;
    case "eventCamera":
      cameraRig.clear();
      break;
    case "eventReset":
      resetScene();
      break;
    case "toast":
      overlay.toast(msg.text);
      break;
    case "likes":
      overlay.heartsBurst(msg.count);
      break;
    case "settings":
      applySettings(msg.settings);
      break;
    case "capture":
      if (!preview) capture(msg).catch((e) => console.warn("Capture failed", e));
      break;
    case "record":
      if (!preview) record(msg).catch((e) => console.warn("Recording failed", e));
      break;
    case "state":
      // The real LIVE began after a rehearsal: no simulated supporter stays on the badge or stone.
      if (msg.clearTop) {
        overlay.clearTopGifter();
        stone?.carve(null);
      }
      if (msg.topGifter) {
        overlay.setTopGifter(msg.topGifter);
        stone?.carve(msg.topGifter);
      }
      if (msg.meter) overlay.setMeter(msg.meter.value, msg.meter.max);
      break;
    case "skip":
      // "Unstick": stop talking, drop queued stunts and walk back to the middle.
      for (const line of lines.splice(0)) {
        line.skipped = line.ended = true;
        skippedIds.add(line.id);
        line.wake?.();
      }
      if (skippedIds.size > 200) skippedIds.delete(skippedIds.values().next().value);
      audio.stop();
      audio.duck(false);
      events?.cancel();
      cancelWait?.();
      speech.talking = false;
      overlay.hideSubtitle(overlay.captionId); // the caption goes at once, with the voice
      avatar.clear();
      avatar.perform("walk_center", { priority: PRIORITY.system });
      break;
  }
}

// Operator "Reset scene": stops any event and puts the scene back to normal (weather, lights,
// sky, mist, camera, his position) without touching supporter totals.
const MIST_COLOR = mist.color.value.clone();
function resetScene() {
  events?.cancel();
  cameraRig.clear();
  stormUntil = 0;
  weather?.setStorm(0);
  bloodUntil = 0;
  sky?.setBloodMoon(false);
  sky?.setStars?.(1);
  post.setTint(0xffffff);
  environment?.power?.(1);
  lighting?.setAura?.(0);
  mist.color.value.copy(MIST_COLOR);
  avatar.locomotion && (avatar.locomotion.faceYaw = null);
  avatar.clear();
  avatar.perform("walk_center", { priority: PRIORITY.system });
}

// Errors in the stream window go to the operator's log on the setup page, never to the broadcast.
let lastError = "";
function reportError(text) {
  console.warn(text);
  if (preview || text === lastError) return;
  lastError = text;
  send({ t: "clientError", text: String(text).slice(0, 300) });
}
addEventListener("error", (e) => reportError(`${e.message} (${String(e.filename || "").split("/").pop()}:${e.lineno})`));
addEventListener("unhandledrejection", (e) => reportError(`unhandled: ${e.reason?.message || e.reason}`));

// Which events this window can perform (their places, props and effects are all ready).
function reportEvents() {
  if (!preview && events) send({ t: "eventsAvailable", available: events.available });
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  // ?tag= names a window (e.g. a rehearsal window), so capture commands can address only it.
  const tag = (params.get("tag") || "").replace(/[^\w-]/g, "").slice(0, 24);
  socket = new WebSocket(`${protocol}://${location.host}/ws?role=stream${preview ? "&preview=1" : ""}${tag ? `&tag=${tag}` : ""}`);
  socket.onopen = () => {
    hub.emit("connection", { state: "open" });
    reportEvents();
  };
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handle(msg);
    hub.emit("message", msg);
  };
  socket.onclose = () => {
    hub.emit("connection", { state: "closed" });
    setTimeout(connect, 1500);
  };
}
connect();

// --- Camera: follows him, leans in while he talks, pulls back for stunts -------------
const look = new THREE.Vector3(0.5, 1.6, 0.6);
const desired = new THREE.Vector3();
const lookTarget = new THREE.Vector3();
// Graves, branches and fences between him and the camera push the camera in front of them.
const occluders = environment ? Object.values(environment.meshes).filter((m) => m.name !== "soil" && m.name !== "road") : [];
const solidProps = occluders.filter((m) => !(config.environment.foliage || []).includes(m.name));
const ray = new THREE.Raycaster();
ray.firstHitOnly = true; // every check here needs only the nearest hit (three-mesh-bvh)
let clearDistance = Infinity;
let nextOcclusionCheck = 0;
function checkOcclusion(from, to) {
  const dir = to.clone().sub(from);
  const length = dir.length();
  ray.set(from, dir.normalize());
  ray.far = length;
  const hit = ray.intersectObjects(occluders, false)[0];
  clearDistance = hit ? Math.max(1.6, hit.distance - 0.35) : Infinity;
}

function updateCamera(dt, t) {
  if (captureView) {
    camera.position.set(...captureView.pos);
    camera.lookAt(...captureView.look);
    return;
  }
  // A gift event's authored shot (checked when it was set) takes over and eases in; clearing it
  // eases back to the normal camera from wherever it is, so there is never a cut.
  if (eventShot) {
    const k = 1 - Math.exp(-dt * 1.6);
    if (eventShot.cut) {
      camera.position.copy(eventShot.pos);
      look.copy(eventShot.track ? eventShot.track() : eventShot.look);
      eventShot.cut = false;
    }
    camera.position.lerp(eventShot.pos, k);
    // A tracking shot keeps him in the narrow portrait frame: one quick smoothing, no lag.
    if (eventShot.track) look.lerp(eventShot.track(), 1 - Math.exp(-dt * 7));
    else look.lerp(eventShot.look, k);
    releasedShot = true;
    // His head and hands stay below TikTok's top bar in event shots too: the lens opens a little
    // while they would not.
    const bones = avatar.bones;
    if (bones?.head) {
      const top = (hub.ctx?.layout?.tiktok?.top ?? 0.12) + 0.03;
      const highest = Math.min(screenY(bones.head, 0.28), ...[bones.hand_l, bones.hand_r].filter(Boolean).map((h) => screenY(h)));
      eventShot.boost = eventShot.boost || 0;
      if (highest < top) eventShot.boost = Math.min(14, eventShot.boost + dt * 14);
      else if (highest > top + 0.06) eventShot.boost = Math.max(0, eventShot.boost - dt * 3);
    }
    const fov = (eventShot.fov || BASE_FOV) + (eventShot.boost || 0);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 2);
      camera.updateProjectionMatrix();
    }
    if (shake > 0.01) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.1;
      camera.position.y += (Math.random() - 0.5) * shake * 0.1;
      shake *= Math.exp(-dt * 6);
    }
    camera.lookAt(look);
    return;
  }
  const base = avatar.root.position;
  const stunt = avatar.current?.type === "stunt";
  const walking = avatar.current?.type === "walk";
  const close = speech.talking && !stunt && !walking;
  // Arms-up stunts get room above him from their first moment, before the hands get there.
  if (stunt && ARMS_UP.has(avatar.current.name)) framing.pull = Math.max(framing.pull, 0.9);
  const distance = (stunt ? 5.6 : close ? 3.3 : 4.6) + framing.pull;
  const height = (stunt ? 1.7 : close ? 2.25 : 2.05) + framing.pull * 0.12;
  const orbit = Math.sin(t * 0.09) * (close ? 0.22 : 0.4);
  desired.set(base.x + Math.sin(orbit) * distance, base.y + height + Math.sin(t * 0.21) * 0.05, base.z + Math.cos(orbit) * distance);
  lookTarget.set(base.x, base.y + (stunt ? 1.15 : close ? 1.95 : 1.5) - framing.drop + framing.raise + framing.pull * 0.22, base.z);
  // Where the fence stops the camera backing off, the lens widens a little instead.
  const fov = BASE_FOV + framing.pull * 4.5;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
  }
  if (environment) {
    desired.z = Math.min(desired.z, 4.8); // stay inside the fence
    desired.x = THREE.MathUtils.clamp(desired.x, -5.8, 5.8);
    if (t > nextOcclusionCheck) {
      nextOcclusionCheck = t + 0.25;
      checkOcclusion(lookTarget, desired);
    }
    const offset = desired.clone().sub(lookTarget);
    if (offset.length() > clearDistance) desired.copy(lookTarget).addScaledVector(offset.normalize(), clearDistance);
    // Never let a bush fill the lens: while foliage rises into the first metre and a half of
    // the view, the camera moves in towards him.
    for (let i = 0; i < 10 && foliageInLens(desired, lookTarget); i++) desired.lerp(lookTarget, 0.08);
  }
  // Back from an event shot that is far away: cut to the normal view rather than fly back.
  if (releasedShot && camera.position.distanceTo(desired) > 3) {
    camera.position.copy(desired);
    look.copy(lookTarget);
  }
  releasedShot = false;
  const k = 1 - Math.exp(-dt * (stunt ? 2.2 : 1.4));
  camera.position.lerp(desired, k);
  look.lerp(lookTarget, k);
  if (shake > 0.01) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.12;
    camera.position.y += (Math.random() - 0.5) * shake * 0.12;
    shake *= Math.exp(-dt * 6);
  }
  camera.lookAt(look);
  checkFraming(dt, close);
}

// Framing is checked against the layout's protected regions every frame: his head and raised
// hands must stay below TikTok's top bar (the camera eases back while they would not), and while
// he talks his face must stay above the caption box (the camera aims a little lower until it
// does). Both ease off again once there is room, so the frame never jumps.
const framing = { pull: 0, drop: 0, raise: 0 };
const BASE_FOV = camera.fov;
const ARMS_UP = new Set(["celebrate", "jacks", "reanimate", "stretch", "roar", "handstand", "backflip", "wave"]);
const probe = new THREE.Vector3();
function screenY(object, lift = 0) {
  object.getWorldPosition(probe);
  probe.y += lift;
  probe.project(camera);
  return (1 - probe.y) / 2; // 0 at the top of the frame, 1 at the bottom
}
// How far outside the frame's left/right margin a point is (0 when inside).
function sideOverflow(object, margin = 0.05) {
  object.getWorldPosition(probe).project(camera);
  const x = (probe.x + 1) / 2;
  return Math.max(0, margin - x, x - (1 - margin));
}
function checkFraming(dt, talking) {
  const bones = avatar.bones;
  if (!bones?.head) return;
  const layout = hub.ctx?.layout;
  const top = (layout?.tiktok?.top ?? 0.12) + 0.03;
  const captions = layout?.regions?.captions?.y ?? (settings.layout?.subtitleY ?? 58) / 100;
  const hands = [bones.hand_l, bones.hand_r].filter(Boolean);
  const highest = Math.min(screenY(bones.head, 0.28), ...hands.map((h) => screenY(h)));
  const outside = Math.max(0, ...hands.map((h) => sideOverflow(h)));
  if (highest < top || outside > 0) framing.pull = Math.min(2.6, framing.pull + dt * 2.5);
  else if (highest > top + 0.06) framing.pull = Math.max(0, framing.pull - dt * 0.5);
  const face = screenY(bones.head, 0.1);
  if (talking && face > captions - 0.05) framing.drop = Math.min(0.6, framing.drop + dt * 0.5);
  else if (!talking || face < captions - 0.12) framing.drop = Math.max(0, framing.drop - dt * 0.3);
  // And below the supporter and event information at the top (a vote card must never sit over
  // his face): the camera aims a little higher, so he sits lower in the frame.
  const info = layout?.regions?.info;
  const infoBottom = info ? info.y + info.h : 0.31;
  const brow = screenY(bones.head, 0.2);
  if (brow < infoBottom + 0.01) framing.raise = Math.min(0.5, framing.raise + dt * 0.5);
  else if (brow > infoBottom + 0.06) framing.raise = Math.max(0, framing.raise - dt * 0.3);
}

// The key light stays in front of his face and the rim behind him, whatever drives the camera.
const lensProbe = new THREE.Vector3();
const lensDir = new THREE.Vector3();
function foliageInLens(from, to) {
  const h = environment?.heights;
  if (!h?.plants) return false;
  lensDir.subVectors(to, from).normalize();
  for (const d of [0, 0.35, 0.7, 1.05, 1.4]) {
    lensProbe.copy(from).addScaledVector(lensDir, d);
    if (h.sample(h.plants, lensProbe.x, lensProbe.z) > lensProbe.y - 0.45) return true;
  }
  return false;
}

const toCamera = new THREE.Vector3();
function updateCharacterLights() {
  const base = avatar.root.position;
  keyLight.position.set(base.x + 1.4, base.y + 3.1, base.z + 2.9);
  rimLight.position.set(base.x - 1.4, base.y + 2.9, base.z - 1.9);
  faceTarget.position.set(base.x, base.y + 1.95, base.z);
  toCamera.subVectors(camera.position, faceTarget.position).setY(0).normalize();
  faceFill.position.copy(faceTarget.position).addScaledVector(toCamera, 2.4);
  faceFill.position.y += 0.35;
}

const orbitControls = debug ? new OrbitControls(camera, renderer.domElement) : null;
if (orbitControls) {
  camera.position.set(0.5, 6, 9);
  orbitControls.target.set(0.5, 1, 0);
}
if (debug || params.has("expose")) window.debugScene = { THREE, scene, camera, orbit: orbitControls, environment, avatar, renderer, overlay, post, effect, handle };

const timer = new THREE.Timer();
let nextFrame = 0;

// Measured performance: the last 300 frame intervals, for the ?stats=1 readout and rehearsals.
const stats = { frameMs: [], last: 0 };
window.streamStats = () => {
  const s = [...stats.frameMs].sort((a, b) => a - b);
  const pct = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0).toFixed(1);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const c = renderer.domElement;
  return {
    render: `${c.width}x${c.height}`,
    fps: +(1000 / mean).toFixed(1),
    p95ms: pct(0.95),
    p99ms: pct(0.99),
    worstMs: pct(1),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
  };
};
// The setup page shows how the stream window is actually running (resolution, fps, memory).
if (!preview) setInterval(() => send({ t: "stats", stats: window.streamStats() }), 10_000);
if (params.has("stats")) {
  const hud = document.createElement("pre");
  hud.className = "stats-hud";
  stage.appendChild(hud);
  setInterval(() => {
    const s = window.streamStats();
    hud.textContent = `${s.render} · ${s.fps} fps · p95 ${s.p95ms} ms · worst ${s.worstMs} ms${s.heapMB ? ` · ${s.heapMB} MB` : ""}`;
  }, 1000);
}

function frame(now) {
  requestAnimationFrame(frame);
  if (now < nextFrame - 1) return;
  nextFrame = Math.max(nextFrame + frameInterval, now);
  if (stats.last) stats.frameMs.push(now - stats.last);
  stats.last = now;
  if (stats.frameMs.length > 300) stats.frameMs.shift();
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.05);
  const t = timer.getElapsed();
  const nowMs = performance.now();
  if (stormUntil && nowMs > stormUntil) {
    stormUntil = 0;
    weather?.setStorm(0);
  }
  if (bloodUntil && nowMs > bloodUntil) {
    bloodUntil = 0;
    sky?.setBloodMoon(false);
    post.setTint(0xffffff);
  }

  updateHarvest(nowMs);
  updateAmbient(dt);
  audio.update(dt);
  const flash = lighting ? lighting.update(t, dt, stormUntil ? 1 : 0) : 0;
  room?.update(t, dt);
  sky?.update(t, dt, flash);
  weather?.update(t, dt, flash, camera);
  environment?.update(t, dt);
  bats?.update(t, dt);
  ghosts?.update(t, dt);
  bolts?.update(dt);
  fireworks?.update(dt);
  // A failing gift event is cancelled (its cleanup restores the scene); the show carries on.
  try {
    events?.update(dt, t);
    activities?.update(dt);
  } catch (error) {
    reportError(`gift event: ${error?.message || error}`);
    events?.cancel();
  }
  arcs.update(dt);
  hub.emit("frame", { dt, t });
  if ((weatherReport -= dt) <= 0 && weather) {
    weatherReport = 0.5;
    hub.emit("weather", { rain: weather.rainLevel, storm: stormUntil ? 1 : 0, wind: wind.strength.value });
  }
  stone?.update(dt);
  dust.update(dt);
  sparks.update(dt);
  // His own voice is all the mouth analyser hears (the reader has its own chain), so between
  // lines it only moves for his nonverbal sounds.
  const voiced = speech.talking || audio.level > 0.02;
  avatar.update(dt, t, { level: voiced ? audio.level : 0, bands: audio.bands, mouth: audio.mouth, talking: speech.talking, voiced, mood: speech.mood, camera: camera.position });
  if (orbitControls) orbitControls.update();
  else updateCamera(dt, t);
  updateCharacterLights();
  overlay.update(dt);
  renderer.info.reset(); // count every pass of the frame, not just the last one
  post.render(t, dt, flash);
}
renderer.info.autoReset = false;

// Warm-up: the first gift of the night used to stall the stream while the graphics driver
// compiled shaders for effects nobody had seen yet. One of each is created far below the
// ground, compiled (in parallel where the driver allows) and drawn once before the first frame;
// they then expire on their own as usual.
async function prewarm() {
  const away = new THREE.Vector3(0, -60, 0);
  ghosts?.rise([away]);
  bolts?.strike(away.clone(), { from: away.clone().add(new THREE.Vector3(0, 4, 0)) });
  fireworks?.burst(away.clone(), 0xffffff);
  bats?.add({ orbit: false, from: away.clone(), life: 0.5 });
  dust.burst(away, 0.1);
  arcs.zap(away, away.clone().add(new THREE.Vector3(0, 1, 0)), 0.2);
  arcs.update(0);
  sparks.lines.visible = true;
  const removeSignatures = events.prewarm();
  try {
    await renderer.compileAsync(scene, camera);
  } catch (error) {
    console.warn("Shader warm-up skipped", error);
  }
  post.render(0, 0, 0);
  removeSignatures();
  sparks.lines.visible = false;
}
await prewarm();

// Add-on modules get the scene through the hub and follow the show by its events.
let weatherReport = 0;
if (debug || params.has("expose")) Object.assign(window.debugScene, { events, cameraRig, hub });
hub.ctx = { THREE, scene, camera, renderer, post, stage, avatar, environment, spots, ground, overlay, audio, sky, lighting, weather, events, cameraRig, effect, send, preview, get speech() { return speech; }, linesPending: () => lines.length > 0 };
// Between conversations he looks after the place: pumpkins, the gate, the apparatus.
const activityGap = Number(params.get("activityGap")); // seconds, for testing
activities = preview || params.has("still") ? null : new Activities(hub, events, activityGap > 0 ? { minGap: activityGap, maxGap: activityGap } : {});
initSound(hub, audio);
initChoices(hub);
reportEvents();
hub.emit("ready", { ctx: hub.ctx });
requestAnimationFrame(frame);
