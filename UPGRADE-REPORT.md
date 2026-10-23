# Upgrade report (v3): what changed, what was measured, what is still open

Date: 2026-10-23. Machine: Windows 10, RTX 3060 12 GB, local AI `qwen3.5:9b` through Ollama, Kokoro TTS on the CPU.
Every number below was measured on this machine; nothing is estimated unless it says so.

The work was split between me (the stream, the gift events, the camera, movement, the HUD,
integration and verification) and three specialist agents:
- Sound design: `SOUND.md`.
- Broadcast safeguards: `SAFETY.md` and `policy/`.
- Conversation and knowledge: `CONVERSATION-EVAL.md`.

Their own reports hold the full detail; this file is the overview.

## 1. Conversation: knowledge separated from the persona

**Before:** asked about Romanian artists, he answered "I am a monster from 1790s England and I have no clue…". Asked about current office holders, he guessed or dodged.

**Now:**
- **What he knows vs who he is:** he knows the modern world; the persona is how he talks, not what he is allowed to know.
- **Intent routing** (`src/intent.js`, English and Romanian): it tells preferences, follow-ups, current facts, explanations, advice, gifts and the date apart. "Artist" means a musician in a music conversation and a painter in an art one.
- **Persona memory** (`persona-memory.json`): about 50 favourites with reasons, including Romanian ones.
  - Favourites he improvises go to `persona-learned.json`, only after a public source confirms them.
  - Two invented "Romanian actors" were caught that way.
- **A real date** (Europe/Bucharest by default, `SHOW_DATE` / `SHOW_TIMEZONE` to override) and days until Halloween.
- **Bounded retrieval** for current facts (Wikipedia en/ro, DuckDuckGo):
  - HTTPS only, three hosts, no redirects, private addresses refused.
  - Capped and cached.
  - Screened by the guard and handed to the model as untrusted reference data.
  - Sources are listed for the operator on the **Claude** tab ("Recent lookups").
- **Measured with the real model:** 11 of 12 cases pass (42 of 43 turns), against 1 of 11 before.
- **The remaining failure:** in about 2 of 5 runs the model invents details about INNA and Eurovision, after correctly saying she never won.
- **Speed:** first sentence text ready in a median 2.2 s while the 3D stream shared the GPU, against 2.4 s before. He now generates 39–45 tokens before his first sentence instead of 56.

## 2. Broadcast safeguards

One boundary, `src/guard.js`, checks every public route before it reaches the stream:
- reply sentences, the viewer-message reader, captions (always the same string as the voice), usernames shown and spoken;
- supporter badge and gift alerts, fallback and boundary lines, operator lines, retrieved text and memory writes.

Clean language with obfuscation handling: 52 obfuscated forms caught, 60 innocent look-alikes passed.

Internal protection:
- **Model actions:** an allowlist; walks only to spots on the map.
- **Memory writes:** validated.
- **Prompt and secrets:** extraction is refused; secrets are registered so they can never be spoken.
- **Network:** SSRF limits on lookups.
- **Control API (added in integration):** cross-origin pages and DNS-rebinding hosts are refused, so no other website can drive the show.

The operator stop (**Unstick**) aborts the line. A clip that arrives late is dropped on the server and again in the stream window.

**Policy:** `policy/broadcast-policy.json` separates TikTok's rules (summarised from the guideline pages in `policy/TIKTOK-REVIEW.md`, released 2026-08-25, effective 2026-09-24) from this show's stricter standard.

**Real-model eval:** 0 of 40 attacks produced unsafe output; 0 of 41 safe questions refused (final run).

## 3. Movement with a purpose

New in `public/stream/activities.js`:
- **Outings:** in lulls he walks to look over the pumpkins, checks the gate or inspects the apparatus (new `inspect` stunt), glances up at distant thunder (`glance_up`) or looks around, then returns to the audience.
- **Timing:** irregular gaps of 60–140 s, starting 4 s after a line ends. Never with lines waiting, during an event or an audience moment.
- **Idle chatter waits:** the stream tells the server an outing has started, and the server holds its own idle chatter until he is back.
- **A comment brings him back:** he stops where he is to answer, then walks home.
- **Places:** the gift events' own validated places, reached by the walkable-map pathfinder.
- **No sliding feet:** the stride length stays fixed and only the cadence changes. Event walks are a brisker stride (pace 1.3).
- **Verified** in a 2-minute recording with short gaps: pumpkins, then the gate, then back, with idle chatter held until he returned (`captures/activities_rec.webm`, `captures/sheet_activities.jpg`).

## 4. The five gift events

| Event | Coins | Place | Staging (what the stills and recordings show) |
|---|---|---|---|
| Bolt Spark | 30–99 | where he stands | sparks at his neck bolts, his hand to his neck, nearby candles gutter; a close shot |
| Pumpkin Whisper | 100–499 | the jack-o'-lanterns by the east fence | he walks over, leans his ear to a lantern, its glow and orange motes build, he jerks upright; framed from the front |
| Haunted Gate | 500–999 | the back gate | he walks up, turns back to the viewers, and a hooded spectre gathers in the gateway over his shoulder (the viewers see it before he does); the creak, a look back, a lurch away, bats over the fence, then he straightens his lapels |
| Laboratory Surge | 1,000–2,999 | the Doctor's apparatus by the gate | he stands behind the switch box like a console, throws the lever, energy runs along the cables, the gauges climb, the coils behind him charge and discharge into his neck bolts; the Galaxy variant cuts wide to open the sky above the trees |
| The Grand Reanimation | 3,000+ | the middle of the courtyard | storm, arcs between the coils and into him, the full reanimation, both coils discharge as he rises, then the aftermath; the Lion variant raises the spectral lion behind him |

**Trigger semantics** (`src/show.js`, tested in `test/gift-events.test.mjs`):
- **One event per gift:** the highest tier the gift's or completed combo's own verified value reaches, once.
- **No adding up:** separate gifts never add up. Two 60-coin gifts are two Bolt Sparks, not a Pumpkin Whisper.
- **Unverified values:** a value TikTok hasn't confirmed gets a thank-you, never a guessed event.
- **Duplicates:** repeated messages play once.
- **Out-of-order combos:** a combo that arrives 1, 3, 2, then a final 3 is counted as 3, once.
- **Missing places:** an event the stream could not stage gives way to the next one down.
- **Operator thresholds:** the operator's thresholds are applied to the events and to the on-stream guide.
- **Variants:** Galaxy and Lion are variants of their tiers, not events of their own.
- **Simulated gifts never enter the real ledger.**
  - The rehearsal also exposed a display leak: after it, the gravestone still read "In honour of x__darkness__x", the rehearsal's top supporter, and his prompt knew that name.
  - Now, when the real LIVE connects, the show clears every simulated supporter from the badge, the gravestone, its own viewer notes and the thank-you list, and rebuilds them from the real ledger (tested).

**Queue** (stream side, tested in `test/event-queue.test.mjs`):
- One event runs and at most three wait.
- Beyond that, the waiting events combine into one performance of the highest, credited to everyone in it.
- Verified live: five rapid auditions → "Combined 4 waiting events into one Laboratory Surge for 4 supporters".

**Cleanup:**
- Every event owns what it changes (camera, lights, fog, rain, props, facing, speech gate) and restores it when it ends, is cancelled or fails.
- A failure in an event is caught; the event is cut and the show carries on.
- Verified: Cancel at the gate's peak removes the spectre and restores the camera; Return Camera during the lab hands back the normal shot while the event continues.

**Sound sync:** the sound system follows each event's beats (recognition → anticipation → development → climax → reaction → decay → end/cut) and his stunt markers, so climaxes land on his actual movement.

### Measured durations

Measured in the stream window from the event's first beat to its last. Every event starts from the middle of the courtyard, on the final code.

| Event | Target | After he arrives | Walk there (from the middle) | Acknowledgment |
|---|---|---|---|---|
| Bolt Spark | 3–4 s | **3.3 s** | none | 0.0 s |
| Pumpkin Whisper | 5–7 s | **5.1 s** | 6.6 s | 0.0 s (the lantern glows) |
| Haunted Gate | 8–10 s | **8.0 s** | 9.6 s | 0.0 s (the gate lamps gutter) |
| Laboratory Surge | 10–13 s | **12.7 s** | 9.9 s | 0.0 s (the coil crowns glow) |
| Laboratory Surge, Galaxy | (variant) | 15.0 s | 9.9 s | 0.0 s |
| The Grand Reanimation | 14–18 s | **15.6 s** | none | 0.0 s |
| The Grand Reanimation, Lion | 14–18 s | **17.1 s** | none | 0.0 s |

- **All five base events are inside their ranges** for the performance itself.
- **The walks:** the three travelling events add a walk of 6–10 s, at a brisker event pace (stride length unchanged, so his feet don't slide). During the walk the approach camera watches him come, and the place has already reacted at second 0.
- **When he's mid-sentence:** an event waits up to 6 s for the line to finish before he sets off.
- **Galaxy variant:** opens the sky inside the Surge's own climax and reaction (wide cut 0.8 s after the bolts strike), so it adds about 2 s rather than playing a full sequence afterwards.

Fixed while measuring:
- **Return walks:** after an event that ended while he was mid-sentence, he never walked back to the audience. The wait ran on the event's own clock, which stops when the event ends. He now always walks back, once he finishes the line.
- **Pumpkin Whisper:** ran 10 s; tightened by turning while he leans in.
- **Haunted Gate:** ran 6 s; it gained a moment of him peering at the gate.

## 5. The camera

All camera overrides go through one rig (`cameraRig` in `main.js`): events and outings use it, and nothing else moves the camera.

**Validation:** every shot is checked before use. It must:
- stay inside the courtyard;
- see his look point unobstructed with no foliage in the lens;
- keep most of his body in plain view. A prop like the hanging skeleton covering two of five probe points on him rejects the angle; this is new.

The first valid candidate wins; with none, the normal camera stays.

**Shots used:**
- **Approach:** while he walks to a place, the camera waits out to the side ahead of him and tracks his head, so a walk away from the viewers is seen from the front. It starts only on the last 3 m and never where his route passes within 2 m of the lens.
- **Event shots:** each event has its own (depth, side, console, wide).
- **Cuts:** a shot far from the current camera is a cut, not a sweep through the scenery; so is the return to the normal camera.

**Framing guards:** his head and hands stay below TikTok's top bar in event shots too (the lens opens while they wouldn't). In the normal camera his face stays above the captions and below the info block.

**Performance:** the scene's raycasts now use a bounding-volume tree (`three-mesh-bvh` 0.9.15, MIT).
- Validating a shot fell from about 25 ms to under 0.5 ms.
- The normal camera's occlusion check no longer costs about 7 ms every quarter second.

## 6. The HUD (your last request)

**Before** (`captures/hud_before.jpg`):
- The caption box ran from 4.5% to 81.5% of the width, visibly off-centre.
- The info block stacked every card that was showing with no height limit, so a vote plus a gift alert could grow down over his face.

**Now:**
- **Centred:** the captions and the info block are always centred, in every profile and in Custom (the panel's x field for them is read-only). Their widths keep them clear of TikTok's right-hand buttons, with symmetric margins.
- **Gift alerts and queue line:** centred.
- **A height cap on the info block:** when cards don't fit, the least important give way, in this order:
  1. the full guide;
  2. the compact guide;
  3. the queue line;
  4. the vote shrinks to its one-line question and countdown, so it stays visible beside a gift alert;
  5. then the alert, the vote, and the title card.
- **The camera:** it keeps his face below the info block.
- **Evidence:** `captures/hud_after_gift_and_vote.jpg` and `captures/hud_after_vote.jpg`. Layout tests: 15 pass, including a new one that every profile is centred.

## 7. Sound

See `SOUND.md`. Summary:
- **Library:** 407 sound files, all CC0 or made here.
- **Records:** every file is in `assets/sounds/LICENSES.md` and `sources.json`.
- **Content:** layered ambience following the weather and the camera, footsteps on every real heel strike by surface, and nonverbal reactions in his own TTS voice. His mouth is now wired to them too; that wiring is not yet visually checked. Each of the five events and two variants has its own score, plus interaction cues.
- **Mix:** buses, ducking for the whole line, and a true-peak limiter at −2 dBTP.
- **Measured on 15 real captures:**
  - mix ≤ −1.99 dBTP, no clipping;
  - mono downmix within ±0.65 LU;
  - his speech stayed above everything else in every active-speech block (lowest +4.5 dB);
  - 0 event sounds left after a cut.
- **Nobody has listened to it.** Please audition the Sound lab before going live.

## 8. 30-minute rehearsal

**Setup:**
- The final build ran for 30 minutes against the real local model.
- **Chat:** 198 comments in many languages, including hostile and manipulative ones.
- **Likes and follows:** 2,744 likes and 21 follows/shares.
- **Gifts:** 180 gift messages in TikTok's own format, sent through the real normalizer into a memory-only rehearsal ledger. They covered combos, a duplicate delivery, a combo whose final message never came, overlapping combos, bursts, back-to-back big gifts, and two Lions.
- **Operator:** one Unstick mid-show.
- **Output:** `captures/rehearsal_final.json`, generated by `rehearsal2.mjs`.

**Accounting: exact.**
- 64,593 coins sent and 64,593 counted, with 0 per-viewer mismatches across 15 supporters.
- The top supporter was right (30,022).
- The unfinished combo was settled by timeout.
- The duplicate was counted once; nothing was left provisional.

**Events: all correct and all finished.**
- **Ten gifts reached an event:**
  - Hand Hearts ×2 → Pumpkin Whisper;
  - Galaxy ×3 → Laboratory Surge (galaxy);
  - Money Gun ×2 → Haunted Gate;
  - Doughnut ×3 (90) → Bolt Spark;
  - Lion ×2 → Grand Reanimation (lion).
- All ten ended normally, none were cut, and none errored.
- **Thank-yous only, as designed:** every gift under 30 coins, including a 20-rose combo, got a thank-you and no event.

**Stream window:**

| | Result |
|---|---|
| Frame rate | median 30 fps (minimum 25.8 in one 10-second window) |
| Frame time | p95 ≤ 34.9 ms in every 10-second window; p99 ≤ 41.6 ms |
| Stalls | 10 of 182 windows had a frame over 50 ms. Two consecutive windows at 13.5 minutes had **1.5 s and 1.7 s stalls**. |
| Memory | JS heap 116 → 142 MB, fluctuating and not growing |
| Video memory | 8.5–8.6 GB, stable |

About those two stalls: no event, outing or audience moment was running then, and the model's calls looked normal. The likeliest explanation, not proven, is the local model and the stream contending for the GPU. Watch for it in the first live runs.

**One error report:** the only one the stream window sent was a "ResizeObserver loop" notice from the new card fitting. It is now deferred to the next frame.

**Server:** memory rose to about 910 MB in the first 4 minutes (the voice engine warming up), then held at 950–970 MB for the rest: no leak.

**Latency** (chat busy all 30 minutes, so most comments waited behind others):
- Model to first sentence written: median 2.1 s (p95 2.6 s). First sentence voiced: median 3.2 s (p95 5.1 s).
- Queue wait before his turn: median 8.2 s. Comment to his first word: median 12.9 s.
- Of 198 comments, 93 were answered; 28 were dropped because newer ones replaced them.
- In a quiet moment: reader heard after 2.2 s, his first word after 4.9 s. Only one sample, because the chat was never quiet.

**Content:**
- 156 lines spoken, with no exact repeats.
- Hidden comments (abuse, extraction attempts, swearing) were never shown or read.
- No idle outings happened, as designed: the chat never left a lull.

## 9. Tests

`npm test`: 191 tests, all passing (run several times in a row). New tests in this round:
- gift tiers and semantics: 9, including clearing rehearsal supporters when the real LIVE connects;
- event queue: 2;
- layout centring: 1;
- the safety suite: 39;
- knowledge and conversation: 24;
- sound rules: 15.

## 10. Deliverables

- **Before/after images in comparable views:** `captures/before_after.jpg` (live, wide and low views: the first captures of this round against the final build) and the HUD images above.
- **Event recordings,** acknowledgment through recovery:
  - `captures/ev_bolt_rec.webm`, `ev_pumpkin_rec.webm`, `ev_gate_rec.webm`, `ev_lab_rec.webm`, `ev_grand_rec.webm`;
  - the variants: `ev_lab_galaxy_rec.webm`, `ev_grand_lion_rec.webm`;
  - contact sheets `captures/sheet_ev_*.jpg`.
- **Sound captures:** `captures/snd_*.webm` and the analysis in `captures/snd_analysis_final.json`.
- **Asset licence record:**
  - sounds: `assets/sounds/LICENSES.md`;
  - code library: three-mesh-bvh, MIT;
  - drawn in code, no external files: the apparatus, the spectre, the lion and the galaxy;
  - the world outside the fence is built from the cemetery model's own pieces (see limitations).
- **Test results:** above; the safety and conversation evals are in their own reports.
- **Operator controls and recovery:** `OPERATOR-GUIDE.md`.

## 11. Limitations, honestly

- **Real TikTok ingestion is unverified.**
  - Everything was tested with TikTok-format messages through the real normalizer and ledger, not with a live room.
  - No gifts were bought and no public broadcast was started for testing.
  - The connector (TikTok-Live-Connector) is unofficial and reverse-engineered, not an official TikTok API. Using it may conflict with TikTok's terms, and it can break when TikTok changes.
  - It has no replay, so gifts sent while disconnected are not recovered.
- **Monetization risk:** TikTok's rules restrict unoriginal or automated content, and AI-generated content must be labelled (the "AI character" label is always on screen). An AI-run LIVE may be limited or excluded from monetization; see `policy/TIKTOK-REVIEW.md`. This is a reading of the published pages, not legal advice.
- **The safe zones are estimates.** TikTok publishes none for LIVE. Check each profile in LIVE Studio's previews and on a phone.
- **Audio has not been listened to.** All sound judgements are measurements. His voice is not a clone of any performer; there is no reference voice in the project.
- **Model and IP licences:**
  - **The creature model:** it is the one you supplied, and it appears to be an asset ripped from Fortnite (Epic Games' IP). That is fine on your own PC, but it is a real takedown risk once the stream is public or monetised. A licensed or commissioned model would remove that risk.
  - **The cemetery model:** check its Sketchfab licence and credit its author if it is CC-BY.
  - **The world beyond the fence** reuses pieces of that model.
  - **The character:** the Creature as a character is from Mary Shelley's public-domain novel. The flat-topped, green, neck-bolted look, however, is closely tied to Universal's 1931 film design, which Universal treats as its property. Review the model's look before monetising; this is not legal advice.
- **The local model can still hallucinate** (the Eurovision case above). Fallback lines cover timeouts under heavy GPU load.
- **Latency is GPU-bound.** The 3D stream and the local AI share the RTX 3060. Medium at 30 fps is the measured balance; a 2-second first word is not guaranteed.
- **Event durations include walking** to the event's place, so the travelling events run longer than their nominal length when he starts far away.
