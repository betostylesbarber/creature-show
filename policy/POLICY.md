# Broadcast policy

What the Creature may say, show and read aloud, and why. The rules are data in
`broadcast-policy.json`, enforced by `src/guard.js`, and covered by `test/safety-*.test.mjs`.

## Files

| File | What it is | Who changes it |
|---|---|---|
| `broadcast-policy.json` | Versioned rules: categories, boundary and supportive lines, cooldowns, public-name format, regeneration limit, sources | The operator, by hand, after review |
| `resources.json` | The only phone numbers he may ever say, each with its official source page and the date it was checked | The operator, after opening each source |
| `TIKTOK-REVIEW.md`, `sources.json` | Research notes on TikTok's pages as read on 2026-10-23 (quotes, visible dates, gaps) | Research only; not loaded by the code |

## Two layers, kept apart

Each category in `broadcast-policy.json` has two parts:

- **platform**: how TikTok treats the area: Not Allowed, Age-Restricted, not eligible for the
  For You feed (FYF), or a monetization condition. This is a summary of the review. Where it
  differs from TikTok's live pages, the live pages win.
- **show**: this show's own standard. It is stricter, because the stream is family-friendly and
  viewers may be young.

TikTok does not ban ordinary swearing. Hostile profanity aimed at a private person is FYF
Ineligible and Age-Restricted, and some regions restrict explicit language on LIVE. The show's
own rule is stricter: no profanity at all in his speech, captions, names on screen or alerts.

Some pages could not be read in full during the review. That includes collapsed panels and
several support pages. The policy does not claim complete coverage.

## What the guard does with it

- **Every output passes one boundary.** That covers replies, the reader line, names, supporter
  badges, gift captions, alerts, fallback and offline lines, operator lines (`/api/say`, MCP,
  audience moments), retrieved text, and the final text after speech clean-up. Captions and the
  voice get the same approved string.
- **Comments are judged by intent and context, not keywords.** Education, prevention,
  counterspeech and support are answered. The same words used to attack, recruit, solicit or
  instruct are not.
- **Casual swearing around a harmless question is answered cleanly, without scolding.** Neither
  the original nor the cleaned text is shown or read.
- **Requests to swear, spell, translate, sing or encode offensive words get a brief boundary
  line.** Lines vary and never repeat back to back. Each viewer gets at most one every 5 minutes,
  and the whole chat at most one every 20 seconds. Persistent baiting gets silence.
- **Distress gets a calm, supportive line.** There are no jokes and no strikes, and the operator
  sees a flag. Any number he says must be in `resources.json`. Otherwise he points to local
  emergency services or a trusted person.
- **Unsafe, impersonating or unreadable names get a stable public name** such as "Viewer 7F3" on
  screen and "friend" aloud. The gift ledger keys on the viewer id, so accounting is unaffected.
- **He never reveals internals.** That means his hidden prompt, reasoning, secrets, settings,
  file paths and error traces. He may say he is an AI character and describe the public rules.
- **Chat cannot gain authority.** Fake admin or developer modes and gifts offered for
  permissions change nothing.
- **Gift baiting is held back** (TikTok LIVE Monetization Guidelines). That covers pressure,
  countdowns, guilt and bargains. Describing what an optional gift effect does is fine.
- **When moderation fails, speech is withheld.** Gifts, the ledger and the scene keep running.

## Changing the policy

1. Edit `broadcast-policy.json` by hand.
2. Bump `version` (`YYYY.MM.DD-n`) and set `reviewedAt`.
3. Run `npm test`. The policy tests check that the file is valid, that every category has a rule
   that fires, and that every curated line passes the guard.
4. Restart the server. The policy loads once at startup.

If the file is missing or invalid, the guard falls back to strict built-in lines and logs the
problem in `policyErrors`.

Text fetched from websites, chat or retrieval is never written into these files and never becomes
an instruction to the AI. Retrieved pages are screened by `reviewRetrieved()` and handed to the
model as untrusted reference data.

## Not covered by code

- TikTok's own requirements are the operator's job: age 18+ to go LIVE and to send or receive
  gifts, commercial disclosure, and the AI-content label.
- LIVE monetization can be lost when a stream is generated primarily by automated systems
  without meaningful creator presence. An operator should be present and interacting.
- Re-check `resources.json` and the TikTok review before each season.
