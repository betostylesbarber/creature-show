// His nonverbal reactions — a curious hum, a surprised "oh!", an amused chuckle, a thoughtful
// "hmm", a relieved "haah", effort sounds, a playful roar — rendered with his own TTS voice
// (scripts/sound/render-voice.mjs) and played through a copy of his voice chain, at the same
// pitch the stream applies to his speech (settings.voice.pitch), so it is unmistakably him.
// ReactionPolicy keeps them rare and never lets them talk over TTS; speech starting cuts a
// reaction that is still sounding.
import { ReactionPolicy } from "./rules.js";

const SETS = ["am_onyx", "am_puck", "am_michael", "bm_lewis"]; // rendered voice sets
export const KINDS = ["curious", "thoughtful", "chuckle", "surprised", "relieved", "effort", "delight", "roar"];

export class Reactions {
  constructor(engine, audio) {
    this.engine = engine;
    this.audio = audio;
    this.policy = new ReactionPolicy();
    this.voice = null;
    this.pitch = 0.93;
    this.current = new Set();
    this.enabled = true;
  }

  // The configured TTS voice: its rendered set (the deep giant's when the voice has none) and
  // its pitch. Loads the new set before dropping the old one.
  async setVoice({ id = "am_onyx", pitch = 0.93 } = {}) {
    this.pitch = Number(pitch) || 0.93;
    const set = SETS.includes(id) ? id : "am_onyx";
    if (set === this.voice) return;
    await this.engine.load((s) => s.startsWith(`nv.${set}.`));
    const old = this.voice;
    this.voice = set;
    if (old) this.engine.unload((s) => s.startsWith(`nv.${old}.`));
  }

  react(kind, { delay = 0, gainDb = 0, group = null, force = false, priority = false } = {}) {
    if (!this.enabled || !this.voice) return null;
    const now = this.engine.now;
    if (!this.policy.take(kind, now + delay, { force, priority })) return null;
    const v = this.engine.play(`nv.${this.voice}.${kind}`, {
      delay,
      gainDb,
      rate: this.pitch,
      group,
      category: "vocal",
      bus: "nonverbal",
      input: this.audio.nonverbalVoice,
      onended: () => this.current.delete(v),
    });
    if (v) this.current.add(v);
    return v;
  }

  // Speech is starting: a reaction must not overlap it.
  silence(fade = 0.08) {
    for (const v of this.current) v.stop(fade);
    this.current.clear();
  }
}
