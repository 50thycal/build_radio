# Acceptance checklist

Work top to bottom. Do not attempt a 20-minute episode before the short one
succeeds — a failure at 17,000 characters costs about $1.70 to discover, and a
failure at 4,000 costs about $0.42.

---

## Stage 0 — offline (no account, no spend)

```bash
npm install
npm test                 # 108 tests
npm run typecheck
npm run build
npm run episodes:validate
npm run generate:local -- pipeline-that-pays-for-itself --dry-run
```

Expected from the dry run:

```
Estimated runtime      5:06
Words                  724
Characters             4,151
Dialogue chunks        3
Estimated cost         $0.42
```

- [ ] Tests pass
- [ ] Build succeeds
- [ ] Sample spec validates and prices as above

---

## Stage 1 — ElevenLabs proof (the first real milestone)

Put `ELEVENLABS_API_KEY`, `ELEVENLABS_HOST_VOICE_ID` and
`ELEVENLABS_GUEST_VOICE_ID` in `.env.local`, then run the preflight — it costs
under a cent and tests the whole provider contract (key, both voices, the
Text-to-Dialogue endpoint, and whether the bytes returned are MP3 our stitcher
can join):

```bash
npm run check:provider
```

- [ ] Preflight passes and `out/preflight.mp3` has two distinct voices

Only then spend real money on the sample:

```bash
npm run generate:local -- pipeline-that-pays-for-itself
```

- [ ] Three chunks render without error
- [ ] `out/pipeline-that-pays-for-itself.mp3` exists and plays
- [ ] Host and guest are audibly different voices
- [ ] Chunk transitions are inaudible — no click, gap or overlap
- [ ] Reported final duration matches what the player shows
- [ ] Note the printed characters-per-second; set `RUNTIME_CHARS_PER_SECOND`
      if it differs much from 14.2

If this stage fails, nothing downstream matters. Fix it here, where there is no
database, no storage and no webhook in the way.

---

## Stage 2 — full pipeline locally

```bash
npm run db:init
npm run dev
```

1. Sign in at `http://localhost:3000` with `ADMIN_PASSWORD`.
2. Open `/admin` → the sample appears under **Drafts**.
3. `npm run episodes:publish -- pipeline-that-pays-for-itself`, then refresh.
4. It moves to **Ready to generate** with the estimate panel visible.
5. Press **Generate episode · $0.42**.

- [ ] Status walks through queued → generating → stitching → uploading → published
- [ ] The chunk grid fills in left to right
- [ ] The episode appears in the library with the right duration
- [ ] Playback works: play, pause, scrub, ±15s, speed
- [ ] Reload mid-episode — playback resumes where you left off
- [ ] `/admin/episodes/<slug>` shows actual characters, actual cost, request
      ids and the job log

---

## Stage 3 — deployed

Deploy to Vercel with the environment from the README, then:

- [ ] `curl https://<app>/api/health` reports `"status": "ready"` — if not, it
      names exactly which variables are still missing
- [ ] Sign-in works; an incognito window is redirected to `/login`
- [ ] `/api/jobs/run` without the internal secret returns 401
- [ ] The library loads on the iPhone and looks right in Safari
- [ ] "Add to Home Screen" gives a full-screen app
- [ ] Playback, scrubbing and background audio work on the device
- [ ] Resume position survives closing and reopening the app

---

## Stage 4 — GitHub automation

With `BUILD_OS_RADIO_URL` and `INTERNAL_GENERATION_SECRET` set as repository
secrets:

1. `npm run episodes:publish -- <a-new-draft>`
2. Commit and push.

- [ ] The **Publish episodes** workflow runs and reports the slug
- [ ] The app queues exactly one job
- [ ] The episode renders and publishes without you touching the UI

Then prove the money guard:

- [ ] Re-run the same workflow from the Actions tab → response is `duplicate`
      and **no second render happens**
- [ ] Push an unrelated commit touching a draft → response is `skipped_draft`
- [ ] (Option B only) Replay a webhook delivery from GitHub's UI → response is
      `duplicate`

---

## Stage 5 — the full-length episode

Only now. `building-from-an-iphone` ships ready for exactly this: 16,301
characters, 9 chunks, ~20:30, $1.63 estimated.

```bash
npm run episodes:publish -- building-from-an-iphone
git add episodes && git commit -m "Publish building-from-an-iphone" && git push
```

- [ ] Estimate reads roughly: 20 minutes, ~2,970 words, ~16,300 characters,
      9 chunks, ~$1.63
- [ ] Generation completes, hand-offs between invocations included
- [ ] Actual character count is within a few percent of the estimate
- [ ] Actual runtime is within a minute or so of the estimate
- [ ] ElevenLabs' own usage page agrees with the recorded cost
- [ ] Chunk transitions are inaudible across all nine joins
- [ ] Scrubbing to 15:00 on the iPhone lands at 15:00
- [ ] Total spend is under the $2.00 budget

Record the measured numbers and tune `RUNTIME_CHARS_PER_SECOND` and
`ELEVENLABS_USD_PER_1K_CHARS`. The telemetry is stored precisely so these
constants stop being guesses.

---

## Failure drills (worth doing once)

| Drill | How | Expected |
| --- | --- | --- |
| Bad API key | Set a wrong `ELEVENLABS_API_KEY`, generate | Fails immediately, `error_kind: auth`, one request only, episode status `failed` |
| Partial failure | Fail mid-render, then press **Regenerate failed chunks** | Only the failed chunks are re-billed |
| Spec edited mid-flight | Queue a job, edit the spec, let the job run | Job cancels with "content changed", nothing is spent |
| Over budget | Set `MAX_ESTIMATED_COST_USD=0.1`, generate | Refused before any request |
| Lost continuation | Stop the app mid-render, restart | Cron sweep resumes the job; no chunk is paid for twice |
