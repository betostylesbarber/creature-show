# Sound design: report

The stream window now has a complete sound system: a living cemetery that follows the weather
and the camera, his physical presence (footsteps at every heel strike, clothing, leather,
breath, bolts), his nonverbal reactions in his own TTS voice, a distinct soundtrack for each of
the five Halloween gift events, restrained interaction cues, and a mix with a bus per kind of
sound, speech ducking and a true-peak limiter. Everything was measured in real captures of the
stream window (PCM taps of the mix and the encoded webm/opus recording).

Nothing in this report was "listened to": there are no ears on this machine. Every judgement
below that would normally be made by ear is replaced by a measurement, a spectrogram, or a
phoneme check, and says so.

## 1. Audit of what was there

| Area | Before | Problem |
|---|---|---|
| Assets | none (no sound files at all) | no ambience, foley, effects, wildlife or cues |
| Thunder | brown-noise burst, synthesized | the "crack" branch could never play (its strength from lighting.js is always < 0.05), so every thunder was the same dull rumble |
| Master | DynamicsCompressor "limiter" at -2 dB, 2 ms attack | measured +1.1 dB automatic make-up gain, no look-ahead, not true-peak aware |
| Buses | voice chains + one "bed" (music + thunder) | no separation, no per-category control |
| Ducking | bed -10 dB during a line | fine idea, kept and extended to every bus |
| Speech level | voice chain level 1.25 into master 0.92 | drove the limiter ~3 dB on syllable peaks (measured) |
| Gift events | silent | |
| Nonverbal | none | |

Kept unchanged: his voice chain and the reader's spirit chain (the TTS voice itself was not
touched), the mouth analysis, every AudioOut method main.js uses.

## 2. What was built

| File | What |
|---|---|
| `public/stream/audio.js` | the mixer, rebuilt: buses dialogue / nonverbal / ambience / weather / fx / ui / music / reverb, per-bus EQ, line-long ducking, a copy of his voice chain for nonverbal sounds, the shared outdoor reverb, the true-peak limiter, PCM debug taps. Same API as before (play, duck, stop, thunder, update, level, bands, mouth, music, playMusic, setMusicVolume, unlock, recordingTrack, fake) plus `bus()`, `setBus()` |
| `public/stream/sound/worklets.js` | AudioWorklets: `tp-limiter` (2.5 ms look-ahead, 4x oversampled peak detection, ceiling -2 dBTP, 120 ms release) and `pcm-tap` (test captures) |
| `public/stream/sound/engine.js` | loading/decoding up front, voices with fades, per-category limits, anti-repetition, cooldowns, groups that are cancelled together, crossfading loop layers, play history |
| `public/stream/sound/rules.js` | the pure decision logic (unit-tested): shuffle bag, cooldowns, voice limiter, reaction policy, gift-acknowledgment gate, duplicate filter, thunder plan, footstep plan, spatialization |
| `public/stream/sound/library.js` | the mix: bus, level, variation, reverb send, cooldown, priority per sound; category limits; default settings |
| `public/stream/sound/ambience.js` | weather/scene-driven layers and the detail scheduler |
| `public/stream/sound/foley.js` | footsteps, clothing, leather, impacts, bolt strikes, stunt timelines |
| `public/stream/sound/voice.js` | his nonverbal reactions in his own voice |
| `public/stream/sound/events.js` | the five gift events (+ galaxy / lion variants), small-gift acknowledgments, old gift effects, interaction cues, milestone |
| `public/stream/sound/index.js` | wiring to the hub, settings, loading, autoplay/suspension recovery, debug handle `window.__sound` |
| `public/sound-lab.html`, `public/sound-lab.js` | operator audition panel |
| `src/settings.js` | new `sound` key (enabled, volumes per category 0..2, ambience layers), sanitized; partial patches merge |
| `assets/sounds/` | the library: `<category>/*.ogg` (Ogg Opus), `manifest.json`, `sources.json`, `LICENSES.md`, `build-report.json`, `_src/` (unmodified sources + his voice renderings), `test/` (two speech lines for the lab) |
| `scripts/sound/` | `build.mjs` (the whole library from sources, reproducible), `render-voice.mjs`, `render-test-speech.mjs`, `import-sources.mjs`, `licenses.mjs`, `check-library.mjs`, `analyze.mjs`, `timeline.mjs`, `capture-tests.mjs`, `capture-server.mjs`, `drive.mjs`, `lib/` (WAV, DSP, BS.1770 loudness + true peak + analysis, Ogg Opus muxer, headless-Chrome codec, PNG spectrograms, slicing, voice features) |
| `test/sound-rules.test.mjs` | 15 tests: anti-repetition, cooldowns, voice limits, reaction rules, gift bursts, reconnect duplicates, thunder, footsteps, panning, event names, beat routing, library completeness, stunt timelines |

No ffmpeg, sox or Python: decoding and Opus encoding run in headless Chrome (WebCodecs
AudioEncoder + a small Ogg muxer, round-trip verified), all DSP and analysis in Node.

## 3. Event-to-sound inventory

**Environment** (always, following `weather` every 0.5 s and the camera at 4 Hz)

| Layer / detail | Source | Behaviour |
|---|---|---|
| wind (2 playheads L/R) | wind in a tree, filtered to distant air | 0.45 + gusts + storm |
| distant air | low band of a gusty wind recording | rises in a storm |
| trees: leaves and branches | wind in trees (stereo field recording) | follows the gust value strongly |
| fine rain far (2) + near drops (2) | light rural rain; light rain with distinct drops | drizzle level, + storm |
| rain on foliage / stone / iron (fence, crypt roof) / puddles | rain on leaves; on roof and concrete; on a metal porch roof; into a puddle | surface layers; iron grows most in a storm |
| heavy rain (2) | heavy rain + gutter | storm only (rain share^1.5) |
| drips | water dripping after rain | after a storm, then fade |
| candles | wood-wick candle crackle | level = what the camera sees: sum of visible candle lights / distance², relative to the first view; panned to them; follows their flicker, the reanimation's power draw and the flares |
| pumpkin fire | small campfire crackle | the same for the pumpkin lights |
| the apparatus' hum | electrical board hum, saturated for audible harmonics | by camera distance to the coils by the gate |
| supernatural air | a singing bowl an octave down in a long dark space | barely there; swells during spectral events |
| thunder far / mid / close | 5 distant rolls, 2 mid, 2 close cracks (stereo) | for every flash in the sky, at its distance delay; farther = quieter and darker; under speech -5 dB; during events one close clap per 4 s, -4 dB |
| iron fence creaks, rattles | 6 creaks, 4 rattles | 14-75 s apart, more often in gusts; rattles only in gusts or rain |
| crypt settling | 7 wood creaks | 45-130 s, panned to the crypt |
| branches | 4 shakes | in gusts |
| crows, owls, bats (+ squeaks) | 6 caws, 5 owl calls, 4 wing passes, 5 calls | 70-260 s, never within 28 s of each other, not in a storm, never while he speaks or during a gift event |

**Him** (from the animation's own events)

| Event | Sounds |
|---|---|
| `step` (each heel strike) | heel on the surface (stone 12 / soil 10 / grass 6 variants), the sole rolling through (scuff / wet press / grass brush), a body-weight thump, a splash layer in a storm; turning on the spot = lighter shuffles; his coat swings every other stride; pan and distance from the camera |
| `impact` (landings, stomps) | body thump + dirt, hardware jingle on hard landings, scaled by strength |
| `flash` (lightning strikes him) | zap + spark at his bolts |
| `stunt` start + timeline | clothing, big cloth swishes, leather creaks, hardware, breaths, effort sounds timed to each stunt's poses (motion.js): e.g. push-ups exhale on each rep, backflip "hup" at take-off, roar stunt = his own roar at the jaw opening, stretch = a relieved sigh; `cut` cancels the rest |
| stunt markers | celebrate prepare/shift/raise/settle/return, reanimate jolt, activate lever, gate startle, pumpkin listen |
| nonverbal reactions | curious, thoughtful, chuckle, surprised, relieved, effort, delight, roar: 3-6 variants each, in his voice and pitch |

**Gift events** (hub `signature` beats + stunt markers; complexity grows with the tier)

| Event | Recognition | Anticipation / development | Climax | Reaction | Decay |
|---|---|---|---|---|---|
| Bolt Spark | two static ticks | a short rising buzz; sparks between the bolts on `twitch:spark` | the snap + shoulder-twitch hardware + candle flicks | his chuckle | a last small spark |
| Pumpkin Whisper | soft "fwoomp" of the lantern, crackle starts | crackle grows, a glint; the whisper rises from the pumpkin on `listen:listen` | a pop of warm magic + flare | "oh!" | crackle settles |
| Haunted Gate | far bell, a crow | wind gust; the long iron creak on `gate_react:creak` with a spectral swell entered so it peaks with the lunge | clank, bats, his startled breath, squeaks | dignified "hmm" | a last soft creak, wind and spirit fall back |
| Laboratory Surge | relay, coil hum | hum grows; on `activate:lever`: knife switch, power sag, relay cascade, energy crawling along the cables (10 sparks in 1.1 s), buzz + crackle, then a 2.8 s charging whine with arcs leaping between the coils (L/R) | discharge into his bolts (zap + thunder crack + low impact + crackle) and a falling tail | "ahh!" | crackle and hum wind down |
| Grand Reanimation | deep bell, relay, hum | storm wind, relays; power sag, a 3.2 s charge under spectral voices, arcs, rolling thunder | full discharge + bell + body impact + tail (plus the real thunder of the strike) | "oh!" + chimes | aftermath: chimes, drips, rain easing |
| *galaxy* (on lab) | twinkles | shimmer pad, a rise entered so its peak meets the climax, twinkles | crystal bloom (stereo) | "ahh!" | pad fades, twinkles thin out |
| *lion* (on grand) | distant growl | a closer growl | the spectral lion's roar with low-mid weight (not sub-bass), candles blaze | his impressed chuckle | chimes |

`cut` (operator cancel, reset, a failed event) and `t:"skip"` stop everything an event owns
within 0.35 s: its one-shots, loops and pending timers; the ambience boosts reset.

**Gifts below 30 coins**: one of 6 single glints / 4 two-note / 4 three-note figures (D-minor
pentatonic, a recorded crystal bell) plus a tiny spark; in a burst at most 2 full + 2 softer per
3 s (measured: 12 gifts in 3 s gave 4 acknowledgments), -6 dB while he speaks.

**Interaction cues** (`cue` from the choices module): choice-open, choice-close, mystery-clue
(+ his curious hum), mystery-payoff (+ delight), surprise; likes milestone (harvest-moon chime,
candle crackle swells with the candles); top supporter carved into the stone (chisel taps).
Chat messages, counters, captions, toasts and connection problems make no sound.

## 4. Source material

**Downloaded** (all CC0 1.0; full table with authors, links and what was changed:
`assets/sounds/LICENSES.md`, machine-readable `assets/sounds/sources.json`):
- Freesound, 79 recordings (CC0-only searches, each sound page's licence link checked):
  field recordings of rain, wind, trees, thunder, fire and candles, iron gates and metal creaks,
  wood creaks, crows, tawny owls, bats, boots on stone/mud/grass/gravel, leather, jacket cloth,
  breaths, electric arcs, a Tesla coil, Jacob's ladders, relays and contactors, mains hum, a
  lion, church and Notre-Dame bells, a crystal and a tubular bell, wind chimes, a singing bowl,
  singing glass, a chime texture, a cymbal swell, fireworks, whooshes, flame bursts, stone
  scrapes, chisel taps, ghostly whispering. Freesound's original files need a login, so these
  are its HQ OGG previews (~192 kbps Vorbis), measured and inspected before use.
- Kenney *RPG Audio* (cloth, belt, leather, creaks, latch) and *Impact Sounds* (soft/punch
  impacts), 26 files, CC0, original OGG.

**Rejected after measurement / spectrogram inspection**: Kenney footsteps (0.11 s, almost all
sub-bass), "Closeup Thunder Strike 01" (85 clipped runs), "Long Rumbling Thunder" (clipped),
"high thunder suburb" (traffic), "USPS wind" (tonal hum), "thuja squeaking" (clipped), two
fireworks recordings (1369 and 4476 clipped runs), "LION ROAR" and two other lion roars
(clipped), "Bonfire Being Lit" and "fire-whoosh" (clipped, sub-bass), "candle sounds" (noise),
two jacket cloth passes (-60 LUFS, hum), a leather bag recording (too quiet), mud footsteps
with background noise, a wing-flap recording that is almost only sub-bass. 18 more imported
candidates ended up unused and were removed.

**Created**:
- His nonverbal sounds: 35 interjections rendered with Kokoro in each preset voice (am_onyx,
  am_puck, am_michael, bm_lewis: 140 files) at the voice's natural pitch; the stream plays them
  at `settings.voice.pitch` through a copy of his voice chain, exactly like his speech. Every
  text was checked against Kokoro's phonemes first: "Hm", "Mm", "Mmm", "Hmph", "Hhhh", "Hngh",
  "Hrrm", "Mhm" are spelled out as letters ("aitch em ...") and were rejected; kept texts like
  "Hmm?" (/hˈəm/), "Huh huh.", "Heh heh heh.", "Oh!", "Haah.", "Hup!", "Raaaah!". Real breaths
  (a CC0 recording, 10% lower) cover inhales and exhales, which TTS cannot make.
- Synthesized: the charging whines and the bolt buzz (electrical energy); the reverbs are
  generated impulses. Everything else is edited, layered recordings.

**Replaced**: the synthesized brown-noise thunder (kept only as a fallback if the library fails
to load) and the compressor "limiter".

## 5. The mix

- **Buses**: dialogue (his voice, the reader) · nonverbal (his reactions through a copy of his
  voice chain, his foley) · ambience · weather · fx · ui · music · reverb (shared outdoor
  impulse, 1.4 s, dark, a few early reflections; footsteps send only a little, wildlife and
  distant details more; speech stays dry apart from its own short echo).
- **Ducking**: for the whole line (reader + reply, including the gaps), so it never pumps
  between words: ambience -6, weather -6, fx -8, ui -3, nonverbal -2, music -10 dB; attack
  τ 60 ms, release τ 0.5 s. His nonverbal sounds never start over speech or a pending line,
  and are cut (80 ms) if a line starts.
- **EQ**: high-pass per bus (nonverbal 45, ambience 60, weather 45, fx 45, ui 140, reverb
  180 Hz), weather -2 dB at 3.2 kHz and -3 dB shelf at 8 kHz (rain never abrasive), ambience
  -2 dB shelf at 9 kHz, fx -1.5 dB at 2.8 kHz (room for his presence peak). Assets themselves
  are filtered in the build (rumble, traffic, harsh highs).
- **No bus compressors**: Chrome's DynamicsCompressor adds automatic make-up gain (measured:
  +5.8 dB for the fx-bus settings, +1.1 dB for the old master limiter), so levels are set by
  gain staging and the limiter only protects.
- **Limiter**: true-peak, look-ahead AudioWorklet, ceiling -2 dBTP (Opus adds up to ~0.5 dB).
  Master gain lowered 0.92 → 0.8: measured limiter gain reduction during speech went from
  max 3.0 dB / p90 2.6 dB to max 1.7 dB / p90 1.0 dB / median 0.
- **Levels**: assets are levelled in the build (one-shots -20 LUFS at their loudest 400 ms,
  loops -23 LUFS integrated, ≤ -3.5 dBTP before encoding); the in-context balance lives in
  `library.js` and was set from the captures (section 6).
- **Space**: pans are subtle (footsteps ±0.35, details ±0.65), from the camera's view of the
  source; distance lowers level and top end; stereo beds are two decorrelated mono playheads;
  nothing important is hard-panned; only thunder.close and the galaxy bloom are stereo files.

## 6. Measurements

Captures are in `captures/` (`snd_*.webm` = the stream window's own recording of canvas + final
mix, Opus; `snd_*_master.wav` = PCM of the final mix after the limiter; the `_dialogue` and
`_bed` stems — his voice and everything else, used for the speech-to-background ratio — were
deleted after analysis to save 450 MB; the numbers are in `captures/snd_analysis_final.json`). Loudness: ITU-R BS.1770-4
(K-weighting implemented and checked against the standard's 48 kHz coefficients; a 997 Hz
full-scale sine reads 0.00 LUFS stereo / -3.01 LUFS one channel). True peak: 4x oversampled.
SBR = speech-to-background ratio in the 400 ms blocks where he is actually speaking (within
10 LU of his speech level).

Final run (all scenarios recorded from the real stream window at 1080x1920 / 30 fps, the show
running with its local AI, choices and mysteries; `node scripts/sound/capture-tests.mjs`):

| Capture | What happens | Length | Integrated (LUFS) | Short-term max | Momentary max | LRA | True peak mix / webm (dBTP) | Clipping mix / webm | Mono downmix | Sub < 40 Hz (rel.) | His speech (LUFS) | Rest of mix (LUFS) | SBR mean / worst 5% / min (dB) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambience | 2 min of the ordinary night (he chatted part of it) | 120 s | -25.6 | -15.5 | -11.6 | 16.5 LU | -2.00 / -1.94 | 0 / 0 | -0.13 LU | -34.1 dB | -14.3 | -30.2 | 20.6 / 13.3 / 11.9 |
| walk | crypt, tree, pumpkins, centre: stone and soil, turns | 40 s | -18.3 | -13.1 | -7.2 | 17.9 LU | -2.00 / -1.55 | 0 / 0 | +0.39 LU | -35.7 dB | -11.6 | -29.2 | 23.6 / 17.7 / 16.1 |
| conversation | a viewer comment read out, his answers | 45 s | -17.8 | -15.7 | -10.6 | 18.4 LU | -1.99 / -1.58 | 0 / 0 | +0.65 LU | -43.4 dB | -14.5 | -31.6 | 20.5 / 14.1 / 11.3 |
| speech in storm | heavy rain, gusts, 5 close lightning strikes under two lines | 40 s | -16.3 | -13.5 | -9.1 | 11.4 LU | -2.00 / -1.66 | 0 / 0 | ±0 LU | -41.1 dB | -13.0 | -25.5 | 13.5 / 7.5 / 6.0 |
| Bolt Spark | audition | 14 s | -26.6 | -21.2 | -17.0 | 10.9 LU | -3.20 / -3.26 | 0 / 0 | -0.19 LU | -49.4 dB | – | -24.7 | – |
| Pumpkin Whisper | audition (+ his reaction speech) | 22 s | -20.9 | -14.7 | -10.0 | 21.6 LU | -2.00 / -1.92 | 0 / 0 | +0.15 LU | -33.2 dB | -12.7 | -26.8 | 16.8 / 10.7 / 5.8 |
| Haunted Gate | audition | 24 s | -25.3 | -20.5 | -17.0 | 8.3 LU | -4.17 / -3.93 | 0 / 0 | -0.22 LU | -30.0 dB | – | -23.4 | – |
| Laboratory Surge | audition (re-recorded after the last loop change) | 28 s | -24.1 | -17.5 | -13.4 | 13.6 LU | -1.99 / -1.98 | 0 / 0 | -0.28 LU | -25.3 dB | – | -22.1 | – |
| Lab Surge · Galaxy | audition | 36 s | -23.8 | -17.2 | -13.5 | 14.3 LU | -2.00 / -2.13 | 0 / 0 | -0.44 LU | -26.9 dB | – | -21.8 | – |
| Grand Reanimation | audition (+ his reaction speech) | 34 s | -18.6 | -14.6 | -10.2 | 16.1 LU | -2.00 / -1.93 | 0 / 0 | +0.12 LU | -31.0 dB | -12.4 | -21.5 | 17.9 / 10.6 / 10.1 |
| Grand · Lion | audition (+ his reaction speech) | 40 s | -18.2 | -15.4 | -10.5 | 21.0 LU | -2.00 / -1.85 | 0 / 0 | +0.09 LU | -26.2 dB | -14.1 | -18.8 | 20.8 / 15.6 / 13.6 |
| speech over Grand | the loudest event with a line spoken into it | 34 s | -17.5 | -14.9 | -9.8 | 16.8 LU | -2.00 / -1.67 | 0 / 0 | +0.07 LU | -29.4 dB | -12.8 | -20.3 | 21.7 / 14.7 / 13.4 |
| rapid gifts | 12 small gifts in 3 s, then a 30 and a 100 coin gift (two queued events), his thanks | 45 s | -17.3 | -14.3 | -9.8 | 22.2 LU | -2.00 / -1.78 | 0 / 0 | +0.03 LU | -41.6 dB | -14.2 | -32.3 | 18.5 / 9.7 / 4.5 |
| interrupted | Grand cancelled after 7.5 s, Lab started then "skip" | 30 s | -23.6 | -16.6 | -12.1 | 19.5 LU | -2.00 / -1.66 | 0 / 0 | -0.11 LU | -30.5 dB | -15.5 | -27.4 | 13.5 / 8.8 / 5.6 |
| recovery | audio context suspended mid-capture | 27.3 s | -28.5 | -21.0 | -16.0 | 8.0 LU | -3.95 / -4.13 | 0 / 0 | -0.25 LU | -34.7 dB | -17.1 | -30.6 | 18.6 / 9.9 / 9.9 |

More measurements:
- **Speech intelligibility**: in every capture his speech stayed above everything else in
  every active-speech block (minimum +4.5 dB, in a burst of gift acknowledgments); during the
  storm with close thunder the worst 5% of speech blocks were +7.5 dB; speaking into the Grand
  Reanimation +14.7 dB (worst 5%). Before the fixes below the storm capture had blocks where
  thunder was 11 dB *louder* than his voice.
- **Ambience level**: while he is silent the bed (everything but his voice) measures -29.9 LUFS
  over 109 s (idle night), -28.2 while walking; with speech it ducks by 6 dB.
- **Events** (rest-of-mix only): momentary / short-term maximum — Bolt Spark -15.0 / -19.2,
  Pumpkin Whisper -15.8 / -21.2, Haunted Gate -15.0 / -18.6, Laboratory Surge -11.0 / -15.5,
  Galaxy -11.3 / -15.1, Grand Reanimation -10.3 / -14.0, Lion -10.7 / -13.4 (his speech peaks
  at -7 to -10 LUFS momentary). The bigger events are 4-5 dB stronger at their climax, the
  rest of the difference is structure (4 → 12 layers, longer arcs). In the Grand event the
  build-up now stays 5-10 dB under the climax (it had peaked at its own start).
- **Encoded capture**: the webm/opus recordings measure within 0.1 LU of the PCM mix; their
  true peak is at most -1.55 dBTP (Opus adds up to 0.45 dB over the -2 dBTP limiter ceiling).
- **Limiter**: during speech, gain reduction max 1.7 dB, 90th percentile 1.0 dB, median 0
  (before: 3.0 / 2.6 dB). Idle: 0 dB.
- **Clicks**: no transient outliers in 120 s of ambience without speech (loop crossfades, detail
  starts and stops); the outliers found in other captures were inspected as spectrograms and
  are footstep heels, spark crackles and speech plosives. Library check (all 407 files decoded
  from Opus): no clipping, worst file true peak -1.55 dBTP, one file started at -41 dBFS
  (a relay clunk) — every one-shot now starts with a 3 ms fade; the two former sample-exact
  loops (hum, coil) showed a small step at the Opus wrap point and now use crossfaded segments
  like every other layer.
- **Repetition**: 872 plays over the final suite, 0 immediate repeats of randomly chosen
  variants (3 repeats were the deliberately chosen charging variant).
- **Bursts**: 12 small gifts in 3 s produced 4 acknowledgments (2 full, 2 soft), no stacking.
- **Interruption**: after the operator's cancel the event's sound stopped at once; the rest of
  the mix fell from -20 to the storm's natural decay (-27) and back to the night (-33) as the
  rain eased; the lab test showed 0 event voices and 0 event loops left after a cut, for all
  seven events.
- **Recovery**: the suspended context was resumed by the sound system after 2.7 s (the capture
  is shorter by exactly that), with no backlog burst; the bed afterwards matched the bed before
  (-30 to -31 LUFS per-second momentary maximum before, -29 to -30 after).
- **Performance**: 30 fps (p95 34.8 ms, worst 41 ms) with the sound running; library decoding
  3.9 s after the scene is ready; per update: candle/scene check 0.014 ms, weather 0.001 ms,
  starting a sound 0.08 ms.

## 7. Reliability

- **Preloading**: every sound is decoded before the first event (measured 3.9 s after the
  scene is ready); only the voice set of the configured TTS voice is loaded (a voice change loads the
  new set first, then frees the old). Files carry the build stamp so a rebuilt library is never
  served stale from the browser cache.
- **Memory budget**: ≤ 96 MB decoded PCM; measured 89.8 MB (one voice set). Low-band sounds
  decode at 8-24 kHz, everything mono except two stereo files, loops 14-30 s (random segments
  with equal-power crossfades never repeat in the same place). On disk 12.9 MB of Opus
  (407 files; plus the build sources in `_src/`: 71 MB of Freesound previews, 0.3 MB Kenney,
  30 MB of his float-WAV voice renderings).
- **Voices**: 48 total, per category limits (e.g. steps 6, vocal 1, ack 2, event 12, wildlife
  2, thunder 3); a new sound steals the oldest voice of lower or equal priority or is dropped.
- **Anti-repetition**: shuffle bags never repeat a variant immediately and avoid the last few;
  pitch/gain jitter is small (his voice ±0.25 semitones). Measured over the whole capture
  suite: 880 plays, 0 immediate repeats among randomly chosen variants (the only repeats were a
  deliberately chosen variant and single-variant bells).
- **Cooldowns**: per sound (wildlife 30-50 s, creaks 9-14 s, cues 1-5 s ...), reactions (6 s
  between any two, 15-25 s per kind; a gift event's reaction may come 2.5 s after another).
- **Timing**: all scheduling on the audio clock; the main thread looks ahead ~4 s for loops
  and does ~10 cheap updates per second; event sounds follow the event's beats and stunt markers
  on the frame clock, so nothing drifts against the picture. Per-frame cost: one timestamp
  check.
- **Cancellation**: event sounds, loops and timers belong to the event and stop together on
  `cut` / `skip`; stunts' scheduled foley stops on the stunt's `cut`. Measured in the lab test:
  0 event voices and 0 event loops remain after a cut, for all seven events.
- **Reconnect**: sounds come only from live events; the server never replays gifts and the
  state message it re-sends makes no sound; identical gift messages within 4 s play once;
  `initSound` runs once.
- **Autoplay / suspension**: nothing is scheduled while the context is not running (no
  backlog bursting out later); the context is resumed every 3 s if suspended; ambience starts
  when it runs. Measured: suspended mid-capture, the mix resumed within ~0.4 s with no burst
  (see snd_recovery).
- **Preview**: the panel's muted preview loads nothing and plays nothing.

## 8. Operating it

- **Sound lab**: `http://localhost:<port>/sound-lab.html` (operator only). Click *Turn on
  sound*; per-category volume sliders with meters (saved to the show's `sound` settings, applied
  live to every stream window); sound effects on/off; ambience start/stop, rain and wind
  sliders, drizzle/gusty/storm presets, layer switches (saved); every ambience detail and
  thunder distance; footsteps per surface and strength, a 10-step walk, turning, landings, a
  bolt strike, every stunt's foley; each nonverbal kind in any of the four voices and any pitch;
  every gift event with its real beat and marker timeline, a *Cut* button, small gifts and a
  10-gift burst; all interaction cues; a speech check through the real dialogue chain, also
  over the Grand event. The header shows decoded memory, voices, loops, an approximate
  momentary loudness, peak and limiter reduction.
- **Settings** (`settings.json` → `sound`): `enabled`, `volumes.{dialogue, nonverbal,
  ambience, weather, fx, ui, music}` (0..2), `layers.{wind, trees, rain, rainSurfaces,
  thunder, candles, creaks, wildlife, supernatural, lab}`. `POST /api/settings {"sound": {...}}`
  accepts partial patches.
- **Rebuilding the library**: `node scripts/sound/build.mjs [--only prefix]`, then
  `node scripts/sound/licenses.mjs`; new TTS voice sets: `node scripts/sound/render-voice.mjs
  assets/sounds/_src/voice scripts/sound/voice-nonverbal.json <voiceId>` and rebuild.
- **Testing**: `npm test` (the `sound-*` tests); captures: open the stream with
  `?soundtap=3102`, run `node scripts/sound/capture-server.mjs`, then
  `node scripts/sound/capture-tests.mjs` and `node scripts/sound/analyze.mjs <names>`.

## 9. Limitations and what could not be verified

- **Not heard.** Timbre, "does this sound like a breath / a hum / a lion", naturalness and
  taste are not verified by listening. Substitutes used: loudness and true-peak measurements,
  spectrograms of every candidate and capture, Kokoro phoneme checks for every interjection,
  envelope analysis. Please audition the sound lab and a capture before going live.
- **Phones / headphones / speakers**: not physically auditioned. Measured instead: mono
  downmix changes ≤ ±1 LU, sub-bass < 40 Hz is ≥ 22 dB below the total in every capture,
  nothing important is hard-panned, every event's payoff sits in the low mids and above.
- **Sources are lossy previews** (Freesound HQ OGG ~192 kbps); masters are the unmodified
  previews plus a reproducible build, not lossless originals. Nothing audible was found in the
  spectrograms, but compression artefacts cannot be ruled out by measurement alone.
- **Grass footsteps** were not reached by the walking test routes (stone and soil were);
  grass is auditioned in the lab.
- **His mouth does not move** for nonverbal reactions (rigged.js only animates it while
  `talking`).
- The voice sets cover the four Kokoro voices of the presets; a custom voice id falls back to
  the deep giant's set at the configured pitch.

## 10. Changes suggested in files this work does not own

1. `public/stream/events.js`, `cue()`: the galaxy / lion layers emit the same `event`,
   `variant` and `id` as their base event, so the sound system tells the two beat sequences
   apart by order. Adding a flag makes it unambiguous:
   `this.ctx.hub.emit("signature", { event: ev.type, beat, variant: variant || null, id: ev.run.id, layer: variant !== ev.run.variant || undefined })`
   — or pass `layer: true` from the two `new Galaxy(...)` / `new Lion(...)` callbacks.
2. `public/stream/events.js` HauntedGate uses the stunt marker `creak` (the brief named
   `startle`); both are handled, no change needed — noted for consistency.
3. `public/panel.html`: a link to `/sound-lab.html`.
4. Optional, `public/stream/main.js`: let his mouth follow nonverbal sounds, e.g.
   `talking: speech.talking || audio.nonverbalSpeaking` with a small analyser on
   `audio.nonverbalVoice` (not implemented, to keep main.js untouched).
5. Optional, `src/server.js` static files: no `Cache-Control`/`ETag` headers; the sound
   library works around it with a build stamp in its URLs.
