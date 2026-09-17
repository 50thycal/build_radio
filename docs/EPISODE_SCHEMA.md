# Episode specification — schema version 1

The episode is the durable artefact. Audio, transcripts, RSS, chapters and any
future video render are all *views* of this object, which is why it is
structured data rather than a script, and why it carries a version from day one.

Authoritative definition: [`lib/episode/schema.ts`](../lib/episode/schema.ts).
Anything that disagrees with that file is this document being out of date.

---

## File location and naming

```
episodes/drafts/<slug>.json       # authored, never renders
episodes/published/<slug>.json    # authorised for rendering
```

The filename must equal the `slug`, which must be kebab-case
(`^[a-z0-9]+(?:-[a-z0-9]+)*$`). A mismatch is a validation error, not a warning:
the slug is used for URLs and storage keys.

Which folder a spec lives in is organisational. What decides whether money is
spent is the `status` field.

---

## Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | integer | yes | Must be `1`. An unknown version is rejected before anything else is read. |
| `id` | string | yes | Stable identity. Conventionally equal to `slug`. |
| `slug` | string | yes | Kebab-case; must match the filename. |
| `title` | string | yes | Shown in the library. |
| `subtitle` | string | no | One line under the title. Defaults to `""`. |
| `project` | string | no | Category tag, e.g. `party-games`. Defaults to `build-os`. |
| `created_at` | ISO 8601 string | yes | Must include an offset (`Z` is fine). |
| `status` | enum | yes | See below. Authored files use `draft` or `ready_for_audio`. |
| `format` | string | no | Free-form, e.g. `host_guest`. |
| `estimated_runtime_minutes` | number | no | The author's guess. The app computes its own estimate and ignores this for pricing. |
| `description` | string | no | Shown on the episode page. |
| `speakers` | map | yes | Key → `{ name, voice_id, role? }`. Keys are referenced by dialogue. |
| `dialogue` | array | yes | Ordered. At least one line. |
| `chapters` | array | no | `{ title, start_seconds, dialogue_index? }`. |
| `sources` | array | no | `{ title, url?, note? }`. |
| `generation` | object | no | Portability block; the database is authoritative. |
| `audio` | object | no | Portability block; the database is authoritative. |
| `metadata` | object | no | Free-form authoring notes. Never interpreted. |

Unknown top-level fields are **rejected**, so a typo like `dialouge` fails
loudly instead of silently producing a one-line episode.

### `status`

| Value | Who sets it | Meaning |
| --- | --- | --- |
| `draft` | author | Never renders. The safe default. |
| `ready_for_audio` | author | Spending on this exact content is authorised. |
| `queued` | runtime | A job exists. |
| `generating` | runtime | Chunks are being rendered. |
| `stitching` | runtime | Chunks are being joined. |
| `uploading` | runtime | The finished file is being stored. |
| `published` | runtime | Audio exists; the episode is in the library. |
| `failed` | runtime | Explicit failure with a preserved reason. |

### `speakers`

```json
"speakers": {
  "host":  { "name": "Build", "voice_id": "", "role": "Host" },
  "guest": { "name": "Strategy Analyst", "voice_id": "" }
}
```

`voice_id` resolution order:

1. `voice_id` in the spec, if non-empty
2. `ELEVENLABS_VOICE_<KEY>` (e.g. `ELEVENLABS_VOICE_HISTORIAN`)
3. `ELEVENLABS_HOST_VOICE_ID` / `ELEVENLABS_GUEST_VOICE_ID` for the `host` and
   `guest` keys

Leave `voice_id` empty unless a specific episode needs a specific voice. Voices
are part of the content version, so changing one is correctly treated as new
content that must be re-rendered.

MVP ships two roles. Adding `historian`, `quant`, `skeptic` and so on needs no
code change — only a speaker entry and an environment variable.

### `dialogue`

```json
{ "speaker": "guest", "text": "The interesting part is debt timing.", "delivery": "thoughtfully" }
```

- `speaker` must be a key of `speakers`. An unknown speaker is an error naming
  the declared cast.
- `text` is what gets billed. Order is preserved exactly, end to end.
- `delivery` is optional and rendered as a leading `[cue] ` prefix. Inline cues
  written directly into `text` (`"[laughing] No way."`) are passed through
  untouched and are not double-prefixed. Either way the cue's characters are
  included in the estimate, because they are sent to the provider.

### `chapters`

```json
{ "title": "Cost protection", "start_seconds": null, "dialogue_index": 6 }
```

Give `dialogue_index` and leave `start_seconds` null: the renderer knows which
chunk that line landed in and when that chunk starts, so it derives the
timestamp at render time without a transcription pass. Explicit
`start_seconds` is respected if you prefer to set it by hand.

---

## Worked example

See [`episodes/drafts/pipeline-that-pays-for-itself.json`](../episodes/drafts/pipeline-that-pays-for-itself.json)
— a complete 5-minute, 3-chunk, $0.42 episode used as the acceptance test.

---

## Validation

```bash
npm run episodes:validate
```

Reports, per file: parse errors with JSON paths, unknown speakers, chapter
indices out of range, slug/filename mismatch, plus the computed word count,
character count, chunk count, runtime estimate, cost estimate and content
version. Exits non-zero on any failure, so it belongs in CI — where it already
runs.

Warnings (a declared speaker who never speaks, `id` differing from `slug`) do
not fail the build.

---

## Versioning policy

`schema_version` is checked before the shape is parsed. An unsupported version
is refused with a message naming what is supported, rather than being coerced.

When version 2 arrives:

1. Add `2` to `SUPPORTED_SCHEMA_VERSIONS`.
2. Parse both shapes, upgrading v1 to v2 in memory.
3. Leave existing v1 files on disk. They remain valid.

Since the content version hash includes `schema_version`, a migration that
changes rendered output re-renders correctly; one that does not, does not.
