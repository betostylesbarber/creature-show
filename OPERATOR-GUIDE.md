# Operator guide: controls and recovery

This guide is for whoever runs the show while it is live. Everything here is on the setup page at
**http://localhost:3000**. The stream window (`/stream`) has no controls of its own.

## Before going live (5 minutes)

1. `npm start`, then open the setup page. Wait for **Brain**, **Voice** and **Stream windows: 1** in the header.
   - Exactly one stream window should be connected: OBS's browser source, or one Chrome window.
   - A second open stream window also plays every event and every sound.
2. **Gifts** tab: press **Audition event** for each of the five events and watch it in OBS.
   - Auditions are simulated. Nothing reaches the supporter ledger.
3. **Sound lab** (header button): check the levels on the speakers or headphones you will monitor with.
   - Nobody has listened to the mix yet. It was only measured; see `SOUND.md`.
4. **Show settings → Layout and safe areas**: turn on **Show layout check on the stream**.
   - Compare it with TikTok LIVE Studio's LIVE and For You previews, then turn it off.
   - The TikTok zones are estimates, not official numbers.
5. Keep the **AI character** label on screen. TikTok requires AI-generated content to be labelled.
6. Close any debug or preview stream tabs. Each one renders the whole scene again and slows the local AI.

## The controls

| Where | Control | What it does |
|---|---|---|
| Header | **Unstick** | Stops him mid-sentence (the caption goes at once), drops queued lines and stunts, cancels a running gift event and audience moment, and walks him back to the middle. |
| Gifts | **Audition event** | Plays one event with no gift, for rehearsal. It is never counted. |
| Gifts | **Cancel event** | Stops the running event. Its cleanup restores the camera, lights, fog, rain, props and his facing, then he walks back to the audience. Waiting events are dropped too. |
| Gifts | **Return camera** | Gives the camera back to the normal follow shot. The event carries on. |
| Gifts | **Reset scene** | Cancels everything and puts storm, moon, stars, light, mist and his position back to normal. **Supporter totals are not reset.** |
| Gifts | Thresholds | The coin value that starts each event. They always stay in increasing order. |
| Show settings | Audience moments | Votes, mysteries and shooting stars: switch each one on or off, or make it rarer. |
| Show settings | Graphics | Keep **Medium, 30 fps** next to a local AI on a 12 GB card. Higher settings measurably slow his replies. |
| Moderation | Blocklist, hidden comments | Words never shown or read, and everything that was hidden and why. |
| Operator | Connection, session ledger, events | Whether TikTok is really delivering events, the verified totals, and every gift with its outcome. |
| Claude | Recent lookups | What he looked up for current facts (Wikipedia, DuckDuckGo) and the source of each answer. |
| Sound lab | Volumes, layers, triggers | Per-category volume (dialogue, nonverbal, ambience, weather, fx, ui, music), ambience layers, and a trigger for every sound. Saved to the show's settings. |

## When something goes wrong

| What you see | Do this |
|---|---|
| He says something off, or keeps talking | **Unstick**. The line stops at once, and a clip that arrives late is dropped, not replayed. |
| An event looks wrong, or the camera is stuck on an event angle | **Return camera** first. If the scene is still off, **Cancel event**, then **Reset scene**. |
| The scene is left dark, stormy or tinted | **Reset scene**. Totals are kept. |
| The stream window is frozen or blank | In OBS, right-click the browser source → **Refresh cache of current page**. The log shows `⚠️ Stream window: …` for errors the window reported. `/api/streamstats` shows its fps. |
| No voice | Captions keep going on their own. Look for "Voice model failed" in the log and restart `npm start` when you can. |
| Replies are slow or generic | The GPU is shared. Close extra stream tabs and keep Medium / 30 fps. When the model times out, he uses a reviewed fallback line rather than going silent. |
| TikTok shows disconnected | **Operator → Connection**. Reconnect on the Setup tab. Gifts sent while it was down are **not** recovered: the connector has no replay, so don't announce that missed gifts will be thanked. |
| A gift arrived but no event played | Check **Operator → events**. A gift's value can be "pending" (thank-you only, never a guessed event), or below the first threshold. Combos play once, when they end. |
| Events pile up during a gift burst | One plays, three wait, and anything beyond that is combined into one performance credited to everyone. The stream shows what is playing and what waits. |
| Captions or cards cover TikTok's buttons or his face | **Show settings → Layout**: try **Busy chat** or **Compact**, or set Custom numbers. Captions and the info block always stay centred. |
| A request from another web page is refused | That's intended: only pages served by this show (and OBS / the MCP bridge) can control it. |

## What the show will never do

- Ask anyone to send gifts, or suggest that gifts buy his affection.
- Invent cash values. Values are TikTok coins as reported.
- Speak a sentence before the broadcast guard has checked it.
- Read secrets, cookies or settings into a reply.
- Count an audition or a test-panel gift in the real ledger.
- Invent emergency numbers: the only numbers he gives are the verified ones in `policy/resources.json`.

## Files to know

- **Supporting docs:**
  - `README.md`: setup, going live, what viewers can do.
  - `UPGRADE-REPORT.md`: what changed, measured results, limitations.
  - `SAFETY.md` and `policy/POLICY.md`: the broadcast safeguards and how to change the policy.
  - `SOUND.md`: the sound design and its measurements.
  - `CONVERSATION-EVAL.md`: conversation quality before and after.
- **Licences:**
  - `assets/sounds/LICENSES.md` and `assets/sounds/sources.json`: one entry for every sound file.
- **Configuration:**
  - `characters/creature/character.json`: the five gift events, walk spots, commands, voices.
  - `characters/creature/persona-memory.json`: his favourites with reasons.
  - `characters/creature/persona-learned.json`: favourites he made up on air, for you to review.
