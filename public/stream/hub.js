// The stream window's event hub. main.js announces what happens in the show, and add-on modules
// (the sound system, audience choices) subscribe here instead of reaching into main.js.
//
// Events (detail fields):
//   ready            { ctx }  once the scene is built; ctx is also kept as hub.ctx
//   message          the raw message object from the server (every one, after main.js handled it)
//   connection       { state: "open" | "closed" }
//   speech           { phase: "start" | "end", role: "reader" | "reply", seconds, text }
//   line             { phase: "start" | "end", id }   one line (reader + reply) beginning / done
//   step             { foot: "L" | "R", strength 0..1, surface: "stone" | "soil" | "grass", position, speed, inPlace }
//   stunt            { name, marker }  marker: start, end, cut, or a named moment (notice, climax ...)
//   impact           { strength }      a landing or stomp (dust and camera shake)
//   flash            {}                a lightning strike on him (the coils discharging into his bolts)
//   signature        { event, beat, variant, id, layer }  a gift event's beats (events.js):
//                                      event: bolt | pumpkin | gate | lab | grand; variant: galaxy | lion | null;
//                                      beat: recognition, anticipation, development, climax, reaction,
//                                      decay, end, or cut (stopped part-way); layer: true for the variant's
//                                      own beats (the Galaxy over the Laboratory Surge, the Lion over the Grand)
//   effect           { name }          a small gift effect (sparks for thank-yous below the first event)
//   lightning        { delay, strength } a flash in the sky; thunder should follow after `delay` s
//   weather          { rain, storm, wind }  every half second (rain 0..1 share drawn, storm 0..1, wind gust)
//   cue              { name, ... }     audience moments (choices.js): choice-open, choice-close,
//                                      mystery-clue, mystery-payoff, surprise
//   layout           the safe-area layout in force (overlay.js), also hub.ctx.layout
//   frame            { dt, t }         every rendered frame (keep handlers cheap)
export const hub = {
  ctx: null,
  handlers: new Map(),
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.handlers.get(name)?.delete(fn);
  },
  emit(name, detail = {}) {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(detail);
      } catch (error) {
        console.warn(`hub "${name}" handler failed`, error);
      }
    }
  },
};
