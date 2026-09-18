# Authoring an episode

An episode is a JSON file, not a transcript. This document is the contract: an
assistant (ChatGPT, Claude, anything) can be pointed at it and produce a file
that renders without a round of schema debugging.

Put the file at `episodes/drafts/<slug>.json` and commit it to `main`.

## The rules that actually reject a file

1. **No extra fields, anywhere.** The schema is strict. An invented key such as
   `author`, `tags` or `notes` fails validation. Put anything extra under
   `metadata`, which is free-form and never interpreted.
2. **`status` must be `"draft"` or `"ready_for_audio"`.** Every other lifecycle
   state belongs to the runtime. `"ready_for_audio"` authorises paid rendering.
3. **`slug` must equal `id`**, and be kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`).
   It becomes the URL and the storage path.
4. **`created_at` must be an ISO-8601 timestamp with an offset**, e.g.
   `"2026-09-18T03:00:00Z"`. A bare date fails.
5. **Every `dialogue[].speaker` must be a key in `speakers`.** Use `host` and
   `guest`: those are the two voices the deployment has configured.
6. **Leave `voice_id` as `""`.** Empty means "use the configured voice". A real
   id here pins the episode to one voice forever and changes the content hash.
7. **`dialogue` needs at least one line**, and each `text` must be non-empty.
8. Do not fill in `generation` or `audio`. The pipeline owns those. Include them
   as the empty objects shown below, or omit them entirely.

## Length and cost

Rendering costs about **$0.10 per 1,000 characters**, and speech runs at roughly
**14 characters per second**, so:

| Target | Characters of dialogue | Cost |
| --- | --- | --- |
| 5 minutes | ~4,200 | ~$0.42 |
| 10 minutes | ~8,500 | ~$0.85 |
| 20 minutes | ~17,000 | ~$1.70 |

Count characters of `text` only — speaker names and JSON punctuation are free.

Hard ceilings refuse a job rather than trimming it: **30,000 characters** and
**$3.00 estimated**. A script over either is rejected, not truncated.

## Delivery and cues

Inline bracket cues inside `text` are passed through to the renderer, e.g.
`"[thoughtfully] That is the part people miss."` A per-line `delivery` field is
also available. Use them sparingly; they are seasoning, not structure.

## Chapters

Give each chapter a `title` and the `dialogue_index` it begins at. Leave
`start_seconds` as `null` — real timings are computed from the rendered audio,
by character offset within the chunk, and written back after publishing.

## A complete, valid file

```json
{
  "schema_version": 1,
  "id": "example-episode",
  "slug": "example-episode",
  "title": "An Example Episode",
  "subtitle": "What a valid spec looks like",
  "project": "build-os",
  "created_at": "2026-09-18T03:00:00Z",
  "status": "draft",
  "format": "host_guest",
  "estimated_runtime_minutes": 5,
  "description": "One or two sentences shown on the episode page.",
  "speakers": {
    "host": { "name": "Build", "voice_id": "", "role": "Host" },
    "guest": { "name": "Systems Analyst", "voice_id": "", "role": "Guest" }
  },
  "dialogue": [
    { "speaker": "host", "text": "This is where the episode opens." },
    { "speaker": "guest", "text": "And this is the reply.", "delivery": "measured" }
  ],
  "chapters": [
    { "title": "Opening", "start_seconds": null, "dialogue_index": 0 }
  ],
  "sources": [
    { "title": "Something referenced", "url": "https://example.com", "note": "Optional" }
  ],
  "generation": {},
  "audio": {},
  "metadata": {}
}
```

## Checking it before it costs anything

```bash
npm run episodes:validate                 # every spec, with cost estimates
npm run episodes:estimate -- <slug>       # one episode's characters and price
```

Validation reports the exact field path for any problem, so a rejected file
tells you precisely what to change.

## What happens after you commit

A push to `main` touching `episodes/**/*.json` starts the publish workflow. It
tells the deployment which slugs changed; the deployment re-reads those specs
from GitHub and renders **only** the ones marked `ready_for_audio`. A `draft` is
synced and priced but never generated.

Generation is idempotent per content version — a hash over the dialogue, cast,
voices and model. Re-running the workflow, double-firing a webhook or retrying a
job all resolve to the same render, so you pay once. Change a line of dialogue
and the hash changes, which is the system telling you this is a different
episode now.
