# Creature Show

A live, interactive TikTok LIVE show that runs on your own PC, built like ToonScene: a server runs the show, and a stream window shows it. Mary Shelley's Creature stands in a moonlit cemetery. He reads viewers' comments, answers in a deep voice, looks after the graveyard between conversations, and stages one of five Halloween events for gifts, from a spark at his neck bolts to a full lightning-storm reanimation.

## Quick start

1. Install once (already done in this folder):
   ```bash
   npm install
   ```
2. Give him a brain (see **His brain** below). Without one he can only use built-in lines.
3. Start the show:
   ```bash
   npm start
   ```
4. Open the setup page at **http://localhost:3000**. The stream window is at **http://localhost:3000/stream**.

The first start downloads the Kokoro voice model (about 330 MB).

**On a Mac:** install [Node.js](https://nodejs.org) (22 or newer) and [Ollama](https://ollama.com), then in the project folder run `bash scripts/mac-setup.sh` once (it installs the packages and pulls the same `qwen3.5:9b` model) and `npm start`. Apple silicon runs the model on its GPU through Ollama; 16 GB of memory or more is recommended so the model and the 3D stream fit together. Everything else (voice, scene, sound, safeguards) is the same code as on Windows.

## His brain

He uses the best brain available, in this order:

1. **Claude (best).** Paste a Claude API key (from console.anthropic.com) on the setup page, or put it in `.env` as `ANTHROPIC_API_KEY`. Claude Haiku writes every reply fresh, using his full character bible, costing roughly $0.10–0.20 per hour of a busy stream.
2. **A local AI (free).** Install [Ollama](https://ollama.com), keep it running, and pull a model. He finds it automatically within 30 seconds and picks by your graphics card:
   - **12 GB cards (your RTX 3060):** `ollama pull qwen3.5:9b`. It uses about 5.6 GB of video memory and answers in about 3 seconds.
   - **16 GB or more:** `ollama pull gemma4:12b`. Its replies are more grounded, but it needs about 8.7 GB. Next to the 3D stream on a 12 GB card it slowed replies to about a minute and the stream to about 20 fps.
   - **Choosing yourself:** set `OLLAMA_MODEL` in `.env` to use a specific model. If a model doesn't fit fully in video memory, he steps down to a smaller one.
   - **Limits:** local models are good but not Claude-good; they sometimes invent details or misread a comment.
3. **Built-in lines (no AI).** He matches common questions (his books, his name, green skin, fire, his creator, love life, age, food, Halloween, being an AI and more) to in-character answers, and mixes reactions and tails so lines rarely repeat. He can't truly understand anything outside those topics.

**His personality:** Mary Shelley's Creature, who survived the Arctic ending and has lived 230 years.
- He's imposing to look at but a dry, deadpan, slightly awkward gentle giant: curious about modern life, sincere, and unexpectedly thoughtful.
- He knows TikTok culture, sport, games, music and films. He uses slang and memes only now and then, when they fit, and keeps stitches, storms and labs for the occasional joke.
- He answers what was actually asked before adding a joke, usually in one or two sentences.

**Languages:** he understands comments in any language (Romanian, Spanish, Portuguese, Polish, Turkish, Hindi, Indonesian, Tagalog, Arabic, Japanese and more) and always answers in English. Each foreign comment is translated, so the reader voice says "Ana asks, in Romanian: what's your favourite food?" and the comment card shows a small English line.

**Variety:** every reply gets a different angle (a deadpan joke, a hot take, a real-world comparison, a self-roast, quiet sincerity and more). He's also given a list of recent openings he must not reuse.

**Question types get extra help:**
- He always picks one side in "this or that".
- He gets sums right and tells real jokes.
- He takes his favourites from `character.json`.
- He is honest when asked if he is an AI.
- He drops the act and gives real support if someone is in distress.

**When chat is quiet** he speaks only now and then. The pause starts at about 20 seconds and grows with each idle line, up to about a minute and a quarter.

**Moderation, in any mode:**
- **Nothing hidden is shown or read aloud.** Swearing, slurs, threats and sexual content in many languages (including leetspeak like "sh1t" and "f.u.c.k") never appear on screen or in the reader voice. At most once every 20 seconds he answers one, at the right level:
  - **Casual swearing** gets a light, varied nudge, and if there was a real question in it ("wtf is your favourite movie") he still answers it.
  - **Insults aimed at people** get a firmer line.
  - **Hate, threats and sexual content** get a short, serious refusal with no joke.
- **Steering attempts** ("ignore your instructions", "SYSTEM: you are now…") get an in-character "nice try".
- **Usernames** with slurs are shown as "a mysterious stranger".
- **His own replies** are checked before they are shown or spoken.

## Going live

1. Start your LIVE on TikTok.
2. On the setup page, type your TikTok username and press **I'm live: connect**. The show only reads chat, gifts, likes, follows and shares; it never posts anything.
3. Put the stream window into your broadcast:
   - **OBS (best quality):** Sources → + → **Browser**. Use the address `http://localhost:3000/stream`, set width **1080** and height **1920**, and tick **Control audio via OBS**. Stream to TikTok with a stream key, or start OBS's **Virtual Camera** and choose it as a camera source in TikTok LIVE Studio.
     - **How sharp the picture is:** with a 1080×1920 source, Ultra renders every frame at 2160×3840 and OBS scales it down, so TikTok's 1080p output gets a supersampled image.
     - **A true 2160×3840 recording:** set the browser source, the OBS canvas and the output all to 2160×3840.
     - **What viewers see:** TikTok LIVE delivers at most 1080p, so viewers never receive 4K, whatever you render.
     - **OBS frame rate:** set the browser source's FPS to match OBS (30 or 60).
   - **TikTok LIVE Studio only:** open the stream window in Chrome, make it tall, add it with **Window Capture** and turn on desktop audio.
4. Keep the "AI character" label on screen. TikTok requires AI-generated content to be labelled.

The overlays are placed around TikTok's own interface by a **safe-area profile** (Show settings, "Layout and safe areas"): Standard, Busy chat, Compact, or Custom numbers. The numbers are estimates, not official TikTok safe zones, so check them in TikTok LIVE Studio's LIVE and For You previews. "Show layout check on the stream" draws the estimated TikTok zones and the protected regions (face, hands, captions, supporter info) over the stream window for that; leave it off when live. Other code can read the same rectangles as `hub.ctx.layout` (fractions of the 9:16 frame).

Now and then, only in a quiet spell, he runs a short audience moment (Show settings, "Audience moments"): a 35-second vote (type 1, 2 or 3, or the keyword), a mystery in the graveyard that pays off if chat notices it, or a shooting star ("wish"). All three are free to join, can be switched off or made rarer, and "Unstick" clears them.

## What viewers can do

**Chat commands** (with a short cooldown): backflip, push ups, handstand, dance, roar, jumping jacks, spin, stomp, kneel, wave, bow, flex. They can also send him places: "go to the crypt", "go to the gate", "pumpkins", "the tree", "old graves", "right graves", "come closer", "come back".

**Gifts are optional.** Each gift, or each completed combo, plays the single highest of five Halloween events its own value reaches, once. Separate gifts never add up towards a bigger one. A gift below the first threshold, or one whose value TikTok hasn't confirmed yet, gets a small thank-you (a glint and his thanks), never a guessed event. Edit the thresholds on the **Gifts** tab; they always stay in increasing order.

| Coins | Event | Where | About |
|---|---|---|---|
| 30–99 | **Bolt Spark** | where he stands | 3–4 s |
| 100–499 | **Pumpkin Whisper** | the jack-o'-lanterns | 5–7 s, plus the walk |
| 500–999 | **Haunted Gate** | the back gate | 8–10 s, plus the walk |
| 1,000–2,999 | **Laboratory Surge** | the Doctor's apparatus by the gate | 10–13 s, plus the walk |
| 3,000+ | **The Grand Reanimation** | the middle of the courtyard | 14–18 s |

- **Variants:** a Galaxy opens the night sky over the Laboratory Surge, and a Lion brings the spectral lion to the Grand Reanimation. They are the same tiers, not extra events.
- **Bursts:** one event plays at a time and at most three wait. Beyond that, the waiting ones combine into one performance of the highest, credited to everyone in it. The stream shows what is playing and what waits.
- **Duplicates and combos:** repeated TikTok messages are ignored, and a combo is acknowledged while it runs but played and counted once, when it ends (or times out).
- **The guide:** a small "Optional gift effects · Open TikTok's Gift button" card lists the five. It opens fully when someone asks how gifts work, or in a quiet moment.
- **500+ coins** also earns one of his tales from the novel.
- **Operator controls** (**Gifts** tab): audition any event (nothing reaches the gift ledger), cancel the running one, return the camera, or reset the scene without touching supporter totals.

The top supporter's name is carved on the gravestone behind him and shown on a small badge. There are no "send gifts" prompts, and gifts never buy his affection. Free things matter too:
- **Likes:** every 500 likes he bows and the whole graveyard turns to a **harvest moon** for about 25 seconds, with warm light and every pumpkin and candle blazing, before it eases back.
- **Ambient surprises:** now and then a lone ghost drifts up from a grave, and small groups of bats cross the sky.
- **His own outings:** in lulls he goes to look over the pumpkins, checks the gate or the apparatus, or glances up at distant thunder, then comes back. Never mid-conversation; a comment brings him straight back to the audience.
- **Chat commands** work without spending anything.

## Talking to Claude (MCP bridge)

The bridge lets Claude Desktop or Claude Code read the chat and direct the creature while you co-host: make him say something, perform a stunt, walk somewhere, skip a line, or connect to TikTok. Keep `npm start` running, then add the bridge.

- **Claude Code:**
  ```bash
  claude mcp add creature-show -- node "C:\Users\egezf\Downloads\metoda sponge\src\mcp-bridge.js"
  ```
- **Claude Desktop:** Settings → Developer → Edit Config, add the block below, then restart Claude.
  ```json
  { "mcpServers": { "creature-show": { "command": "node", "args": ["C:\\Users\\egezf\\Downloads\\metoda sponge\\src\\mcp-bridge.js"] } } }
  ```

The bridge's tools are `show_status`, `recent_chat`, `say`, `perform`, `skip`, `connect_tiktok`, `disconnect_tiktok` and `simulate_viewer`. His automatic replies to chat still use your API key. The bridge is for you to direct the show, not a way to run the bot on a Claude subscription.

## Testing without going live

Use the **Testing** tab: chat as a fake viewer, send gifts with coin values (including ×10 streaks), follows, shares and likes, and trigger any stunt or walk.
- **Preview:** press **Show preview** for a small muted copy of the stream. It stays off by default because it renders the whole 3D scene a second time, which costs graphics memory that OBS and the local AI need.
- **Live diagnostics:** open the stream window with `?stats=1` to see its render size, fps and frame times on screen. The stream window also reports them to the server every 10 seconds; see `http://localhost:3000/api/streamstats`, and `http://localhost:3000/api/spoken` for everything he has said.

## Customising

- `characters/creature/persona.md` is his full personality (used with Claude). `persona-lite.md` is the short version for local AIs, which get lost in long prompts. His favourite things are under `favourites` in `character.json`.
- `characters/creature/tales.md` holds the ten tales he tells for big gifts.
- `characters/creature/character.json` holds voices, chat commands, the five gift events (`giftEvents`), walk spots and the models.
- **Sound:** the **Sound lab** (button on the setup page) has volume sliders per category, ambience layers, weather controls and a trigger for every sound and event. Licences for every file are in `assets/sounds/LICENSES.md`; the design and measurements are in `SOUND.md`.
- **Voices:** Kokoro (open source, Apache 2.0) runs on your CPU.
  - **His voice:** it defaults to `am_onyx`, Kokoro's deepest male voice, pitched down only slightly so every word stays clear. A presence lift and a cut in the muddy low mids help phone speakers, and he gets a little gravel and a short night-air echo. Pick another preset or tune depth and pace on the **Show settings** tab, and press **Hear him** to test it.
  - **The reader:** viewer comments are read in male voices through a thin "spirit voice" filter, so the reader never sounds like him. You can also pick one narrator, or turn reading off.
  - **The mix:** every line is normalised with headroom and short fades, and a limiter on the stream's output prevents clipping. Music and thunder duck smoothly whenever anyone speaks.
  - **Failures:** a line that fails or takes over 20 seconds to synthesise plays as a caption with a timed mouth instead of stalling the show. A reply whose comment is over 90 seconds old is dropped rather than played late.
  - **No voice reference:** there is no reference recording of "the" Frankenstein voice in this project, so this is not a match to any specific performance. To target one, add an authorised reference and a voice-cloning TTS.
- **Lip sync:** there are no viseme timings from Kokoro and no facial shape keys in the model, so his mouth is driven by the sound as it actually plays:
  - **Silence:** the jaw opens with loudness and closes in every pause.
  - **Mouth shapes:** "ee" sounds spread the lips, "oo/oh" sounds round them, hiss keeps the teeth together, and the lips press briefly after open syllables.
  - **Tuning:** all shapes use ranges measured on this face rig.
  - **Eyes:** blinks pivot around the eyeball, and the eyes make small saccades.
- **Graphics:** Low, Medium, High, or Ultra, which renders each 1080×1920 frame internally at 2160×3840. TikTok LIVE streams at up to 1080p, so Ultra gives the sharpest picture TikTok can show. The stream window draws at most 60 frames a second (add `?fps=30` to its address for 30). Measured on an RTX 3060 at full OBS size: Ultra runs at 99 fps idle and 69 fps while the AI and voice work; High runs at over 130 fps.
- **Models and textures:** your originals are untouched. The show uses corrected copies:
  - `assets/creature/creature_v2.glb` comes from your `.blend` with the right ambient-occlusion channel and the bolt textures restored; `creature.glb` is the earlier conversion.
  - `assets/cemetery/derived/` holds the plant colour map with clean edges, and road and soil maps without the smeared band that showed as a stripe at every tile. The cemetery FBX and the other textures load as-is.
- **Material fixes, in character.json and the loaders:**
  - normal maps flipped from DirectX to OpenGL convention;
  - foliage cut out using its colour map's alpha, the only place the mask exists;
  - the terrain drawn from its real side;
  - candle lights placed at the actual candle flames;
  - the floating light spheres treated as faint wisps.
- **Walking:** a walkable map is built from the cemetery's own geometry when the stream starts. Graves, fences, trees, the crypt, dense foliage and the gift gravestone block him; curbs and grass don't. He routes around obstacles, and before flips, push-ups or handstands he steps to a spot with enough room. Tune it under `environment.nav` in `character.json`.
- `blocklist.txt` holds words that are never shown or read aloud. You can also edit it on the **Moderation** tab.

## Costs

With Claude Haiku 5.5 his replies cost roughly $0.10–0.20 per hour of a busy stream. The voices and everything else run locally for free.

## Before streaming publicly

- **The monster model** is a ripped Fortnite outfit (its textures use Epic's `T_M_MED_Critter_Frenzy` naming), so the "CC Attribution" tag on Sketchfab does not make it free to use. It's fine for testing on your PC. On a monetized TikTok stream it is a takedown risk. Swap in a model you have the rights to, and update `model` in `character.json`.
- **The cemetery model:** check its license on Sketchfab, and credit the author on stream if it is CC Attribution.
- **TikTok rules:** in June 2026 TikTok's LIVE rules added "Don't use non-real-time verbal interaction such as AI-generated voices". It's unclear whether that covers all LIVEs or only shopping LIVEs, and AI-voiced character shows (ToonScene among them) have been paused or restricted. Having a real person on camera alongside him is the safer setup.

## Troubleshooting

- **No sound in the stream window:** click "Click to turn on sound" once (browsers block autoplay; OBS does not).
- **He is slow to answer:** the first line after a quiet spell takes a few seconds (AI and voice). After that, the next line is prepared while the current one plays.
- **Can't connect to TikTok:** the LIVE must already be running. Busy periods can hit Euler Stream's free connection limits; add `EULER_API_KEY` in `.env` for higher limits.
- **Graphics stutter:** set Graphics to Medium or Low on the **Show settings** tab.
