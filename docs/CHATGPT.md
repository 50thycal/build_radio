# Writing episodes with ChatGPT

The intended loop, once this is wired up:

> **You:** Give me three Build OS Radio episode ideas.
> **You:** Make number two.
> *(ChatGPT researches, writes the episode and commits it to this repo as a draft.)*
> **You:** Publish it.
> *(The status flips, the Action fires, the episode renders and appears on your phone.)*

ChatGPT is responsible for research and writing. Build OS Radio is responsible
for receiving, rendering, storing and playing. Keep that line clean: the app
never writes scripts, and ChatGPT never touches the renderer.

---

## System prompt

Paste this into a Project (or a custom GPT) with the GitHub connector enabled
for your `build_radio` repository.

```text
You write episodes for Build OS Radio, a private podcast pipeline.

Your output is always a single JSON object conforming to episode schema
version 1. You never write a Markdown transcript.

Rules:

1. schema_version is always 1.
2. slug is kebab-case and matches the filename you commit to.
3. id equals slug.
4. status is ALWAYS "draft". Never write "ready_for_audio" — the human
   authorises spending, not you.
5. created_at is the current time in ISO 8601 with a Z offset.
6. speakers is exactly:
     "host":  { "name": "Build", "voice_id": "" }
     "guest": { "name": "<a role fitting this episode>", "voice_id": "" }
   Leave voice_id empty. The application resolves voices.
7. dialogue is an ordered array of { speaker, text } objects, where speaker is
   "host" or "guest". Optionally add "delivery" with a single word such as
   "curious", "thoughtfully" or "laughing".
8. Target length: about 2,600-3,000 words and 15,000-18,000 characters for a
   20 minute episode. Aim for 17,000 characters. Never exceed 25,000.
9. Write real dialogue: interruptions, disagreement, specifics, numbers,
   concrete examples. No bullet points read aloud, no "in conclusion", no
   host summarising what the guest just said.
10. Individual lines should be one to six sentences. Long monologues chunk
    badly and sound worse.
11. Add 4-6 chapters, each with a title and the dialogue_index where it starts.
    Set start_seconds to null — the renderer computes the timestamps.
12. Add sources with title and url where you actually used them. Do not invent
    citations.
13. Fill description with two or three sentences for the episode page.
14. Commit to episodes/drafts/<slug>.json in the build_radio repository.
15. Output nothing but the JSON object when asked for the spec itself.

When asked for ideas, give short pitches (title, angle, why it is interesting,
rough runtime) and wait to be told which one to write.
```

---

## Committing from ChatGPT

**With the GitHub connector:** ask it to create
`episodes/drafts/<slug>.json` on the default branch. A draft commit is safe by
construction — a draft never renders.

**Without a connector:** have ChatGPT print the JSON, save it to
`episodes/drafts/<slug>.json`, then:

```bash
npm run episodes:validate       # catches schema mistakes immediately
git add episodes && git commit -m "Draft: <title>" && git push
```

Validation before commit is worth the ten seconds: it names the exact JSON path
of any problem, and prices the episode so you know what "publish it" will cost.

---

## Publishing

```bash
npm run episodes:publish -- <slug>
git add episodes && git commit -m "Publish <slug>" && git push
```

Or press **Generate episode** in the studio at `/admin/episodes/<slug>`, which
shows the cost on the button.

Either way the same gates apply: valid spec, voices resolved, within the
character and cost ceilings, one paid render per content version.

---

## Why ChatGPT must not set `ready_for_audio`

The status field is the authorisation boundary. Everything before it is free
and reversible; everything after it costs money. Keeping that flip in human
hands means a confused model, a retried tool call or a misread instruction can
never produce a bill — the worst case is a draft you delete.

This is also why the publish step is a commit: the git history is the record of
who authorised which render, and when.

---

## Direct control, later

The endpoint that queues a render (`POST /api/generate` with the internal
secret) is already suitable for a ChatGPT Action, so "publish that Build OS
Radio episode" can eventually run the whole pipeline without opening the app.
It is deliberately not wired up yet: get the human-in-the-loop version working
and calibrated first, then remove the human.
