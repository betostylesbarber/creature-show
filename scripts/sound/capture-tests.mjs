// Records the sound test scenarios from a running stream window: each is a /api/record (the
// encoded webm/opus capture, exactly what the recorder hears) with the PCM taps of the master and
// its stems alongside (stream opened with ?soundtap=<capture-server port>). Drives the show
// through its own APIs (/api/event/audition, /api/say, /api/sim, /api/action) and, for the
// weather and the audio-context test, through the page (DevTools protocol).
//   node scripts/sound/capture-tests.mjs [scenario ...]   (default: all)
//   env: SHOW=http://localhost:3101  DEBUG_PORT=9333
import { cdp } from "./lib/chrome.mjs";

const SHOW = process.env.SHOW || "http://localhost:3101";
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const post = (p, body = {}) => fetch(`${SHOW}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
let page = null;
const js = async (expr) => {
  page ??= await cdp(Number(process.env.DEBUG_PORT || 9333), (t) => t.url.includes("/stream"));
  return page.evaluate(expr);
};
const record = async (name, seconds) => {
  await post("/api/record", { name, seconds });
  return sleep(0.3);
};
const waitRecorded = (seconds) => sleep(seconds + 4);
const say = (text) => post("/api/say", { text });

const SCENARIOS = {
  // 130 s of the ordinary night: drizzle, gusts, candles, details, wildlife
  async ambience() {
    await record("snd_ambience", 130);
    await waitRecorded(130);
  },
  // walking across the stone path, soil and grass, turning at each spot
  async walk() {
    await record("snd_walk", 40);
    for (const a of ["walk_crypt", "walk_tree", "walk_pumpkins", "walk_center"]) {
      await post("/api/action", { action: a });
      await sleep(9.5);
    }
    await waitRecorded(2);
  },
  // quiet conversation: a viewer's comment read out and his answers
  async conversation() {
    await record("snd_conversation", 45);
    await post("/api/sim", { kind: "comment", user: { nick: "mina_reads" }, text: "Do you ever get lonely out here at night?" });
    await sleep(14);
    await say("Lonely? Never, my friend. The owls keep me company, and the candles always listen.");
    await waitRecorded(31);
  },
  // speech while it storms: heavy rain, gusts and close thunder under his voice
  async speechStorm() {
    await js(`window.__soundHub.ctx.weather.setStorm(1), true`);
    await sleep(6);
    await record("snd_speech_storm", 40);
    await sleep(1);
    await say("Listen to that storm! The rain is pouring down on every gravestone, and the thunder rolls over the hills, but I am not afraid of it at all.");
    for (let i = 0; i < 5; i++) {
      await sleep(4);
      await js(`window.__soundHub.ctx.lighting.strike(${i % 2 ? 0.6 : 1}), true`);
    }
    await sleep(4);
    await say("Thunder is just the sky clearing its throat. Now, where were we?");
    await waitRecorded(18);
    await js(`window.__soundHub.ctx.weather.setStorm(0), true`);
  },
  async bolt() {
    await event("bolt", null, 14);
  },
  async pumpkin() {
    await event("pumpkin", null, 22);
  },
  async gate() {
    await event("gate", null, 24);
  },
  async lab() {
    await event("lab", null, 28);
  },
  async labGalaxy() {
    await event("lab", "galaxy", 36);
  },
  async grand() {
    await event("grand", null, 34);
  },
  async grandLion() {
    await event("grand", "lion", 40);
  },
  // the loudest event with him speaking over it
  async grandSpeech() {
    await record("snd_grand_speech", 34);
    await post("/api/event/audition", { id: "grand" });
    await sleep(10.5);
    await say("It is alive! The whole cemetery is glowing, thank you, thank you all!");
    await waitRecorded(24);
  },
  // a burst of small gifts and two events queued behind each other
  async rapidGifts() {
    await record("snd_rapid_gifts", 45);
    for (let i = 0; i < 12; i++) {
      post("/api/sim", { kind: "gift", user: { nick: `fan${i % 4}` }, gift: { name: ["Rose", "Heart", "Candy"][i % 3], coins: [1, 5, 10, 20][i % 4], count: 1 } });
      await sleep(0.25);
    }
    await sleep(1);
    await post("/api/sim", { kind: "gift", user: { nick: "bigfan" }, gift: { name: "Perfume", coins: 30, count: 1 } });
    await sleep(0.4);
    await post("/api/sim", { kind: "gift", user: { nick: "bigfan2" }, gift: { name: "Doughnut", coins: 100, count: 1 } });
    await waitRecorded(41);
  },
  // an event cut short by the operator, then the scene reset
  async interrupted() {
    await record("snd_interrupted", 30);
    await post("/api/event/audition", { id: "grand" });
    await sleep(7.5);
    await post("/api/event/cancel");
    await sleep(6);
    await post("/api/event/audition", { id: "lab" });
    await sleep(5);
    await post("/api/skip");
    await waitRecorded(11);
  },
  // the audio context suspended (device change, OS) and recovered; ambience must come back
  async recovery() {
    await record("snd_recovery", 30);
    await sleep(6);
    await js(`window.__sound.engine.ctx.suspend().then(() => true)`);
    await sleep(8);
    await waitRecorded(16);
  },
};

async function event(id, variant, seconds) {
  const name = `snd_ev_${id}${variant ? `_${variant}` : ""}`;
  await record(name, seconds);
  await sleep(1.5);
  await post("/api/event/audition", { id, variant });
  await waitRecorded(seconds - 1.5);
}

const wanted = process.argv.slice(2);
for (const [name, run] of Object.entries(SCENARIOS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const t0 = Date.now();
  console.log(`> ${name}`);
  await run();
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await sleep(3);
}
page?.close();
