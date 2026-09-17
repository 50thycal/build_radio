import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMp3 } from '../lib/audio/mp3';
import { chunkEpisode } from '../lib/chunking';
import { getEpisode, listAttempts, listChunks, listJobs } from '../lib/db/store';
import { buildRenderPlan, deriveChapters, syncEpisodes } from '../lib/episode/service';
import { queueGeneration, runJob } from '../lib/jobs/runner';
import { InMemoryMediaStore } from '../lib/storage/media-store';
import { resetTestDb, useTestDb } from './helpers/db';
import { MemoryEpisodeSource, makeDialogue, makeEpisode } from './helpers/episodes';
import { createProviderProbe } from './helpers/provider';

const noSleep = async () => {};

async function seed(episode = makeEpisode()) {
  await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
  return episode;
}

beforeEach(async () => {
  await useTestDb();
});

afterEach(() => {
  resetTestDb();
});

describe('queue guards', () => {
  it('refuses to generate a draft', async () => {
    await seed(makeEpisode({ status: 'draft' }));
    const result = await queueGeneration({ slug: 'test-episode' });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('draft');
    expect(await listJobs()).toHaveLength(0);
  });

  it('refuses an unknown episode', async () => {
    const result = await queueGeneration({ slug: 'does-not-exist' });
    expect(result.status).toBe('rejected');
  });

  it('refuses an episode whose estimate exceeds the cost ceiling', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(200, 425) }));
    const result = await queueGeneration({ slug: 'test-episode' });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toMatch(/MAX_EPISODE_CHARACTERS|MAX_ESTIMATED_COST_USD/);
    expect(await listJobs()).toHaveLength(0);
  });

  it('refuses when a speaker has no voice id anywhere', async () => {
    const previous = process.env.ELEVENLABS_GUEST_VOICE_ID;
    delete process.env.ELEVENLABS_GUEST_VOICE_ID;
    try {
      await seed();
      const result = await queueGeneration({ slug: 'test-episode' });
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') return;
      expect(result.reason).toContain('guest');
    } finally {
      process.env.ELEVENLABS_GUEST_VOICE_ID = previous;
    }
  });

  it('queues a ready episode and records the estimate', async () => {
    await seed();
    const result = await queueGeneration({ slug: 'test-episode', triggerSource: 'github' });
    expect(result.status).toBe('queued');
    if (result.status !== 'queued') return;
    expect(result.job.status).toBe('queued');
    expect(result.job.triggerSource).toBe('github');
    expect(result.job.estimatedCostUsd).toBeGreaterThan(0);
    expect((await getEpisode('test-episode'))?.status).toBe('queued');
  });
});

describe('generation', () => {
  it('renders, stitches, uploads and publishes', async () => {
    const episode = await seed(makeEpisode({ dialogue: makeDialogue(8, 900) }));
    const plan = buildRenderPlan(episode);
    const probe = createProviderProbe({ durations: [0.4] });
    const media = new InMemoryMediaStore();

    const queued = await queueGeneration({ slug: 'test-episode' });
    expect(queued.status).toBe('queued');
    if (queued.status !== 'queued') return;

    const result = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: media,
      sleep: noSleep,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(probe.calls).toHaveLength(plan.chunks.length);

    const record = await getEpisode('test-episode');
    expect(record?.status).toBe('published');
    expect(record?.audioUrl).toBeTruthy();
    expect(record?.audioDurationSeconds).toBeGreaterThan(0);
    expect(record?.actualCostUsd).toBeGreaterThan(0);
    expect(record?.publishedAt).toBeTruthy();

    // The stored object is a real, decodable MP3 of the expected length.
    const stored = await media.get(record!.audioKey!);
    const parsed = parseMp3(stored);
    expect(parsed.durationSeconds).toBeCloseTo(record!.audioDurationSeconds!, 3);
  });

  it('sends chunks in dialogue order with the right voice per speaker', async () => {
    const episode = await seed(makeEpisode({ dialogue: makeDialogue(10, 800) }));
    const plan = buildRenderPlan(episode);
    const probe = createProviderProbe();
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: new InMemoryMediaStore(), sleep: noSleep });

    const sentTexts = probe.calls.flatMap((call) => call.texts);
    const plannedTexts = plan.chunks.flatMap((chunk) => chunk.segments.map((segment) => segment.text));
    expect(sentTexts).toEqual(plannedTexts);

    const sentVoices = probe.calls.flatMap((call) => call.voiceIds);
    const plannedVoices = plan.chunks.flatMap((chunk) =>
      chunk.segments.map((segment) => plan.voices[segment.speaker]),
    );
    expect(sentVoices).toEqual(plannedVoices);
    expect(new Set(sentVoices)).toEqual(new Set(['voice-host', 'voice-guest']));
  });

  it('writes one ledger row per provider request', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(6, 900) }));
    const probe = createProviderProbe();
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: new InMemoryMediaStore(), sleep: noSleep });

    const attempts = await listAttempts(queued.job.id);
    expect(attempts).toHaveLength(probe.calls.length);
    expect(attempts.every((attempt) => attempt.status === 'succeeded')).toBe(true);
    expect(attempts.every((attempt) => Number(attempt.characters) > 0)).toBe(true);
    expect(attempts.every((attempt) => attempt.provider_request_id !== null)).toBe(true);
  });
});

describe('spec re-sync versus runtime state', () => {
  it('keeps a published episode published when its spec is re-synced', async () => {
    const episode = await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({
      jobId: queued.job.id,
      client: createProviderProbe().client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });
    expect((await getEpisode('test-episode'))?.status).toBe('published');

    // The authored file still says ready_for_audio; a re-sync (every page load
    // does one) must not drag the episode back out of the library.
    await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
    const after = await getEpisode('test-episode');
    expect(after?.status).toBe('published');
    expect(after?.audioUrl).toBeTruthy();
  });

  it('keeps a failed episode failed when its spec is re-synced', async () => {
    const episode = await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({
      jobId: queued.job.id,
      client: createProviderProbe({ responses: [401] }).client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });
    expect((await getEpisode('test-episode'))?.status).toBe('failed');

    await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
    expect((await getEpisode('test-episode'))?.status).toBe('failed');
  });

  it('honours an explicit retraction back to draft', async () => {
    const episode = await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({
      jobId: queued.job.id,
      client: createProviderProbe().client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });

    await syncEpisodes(
      MemoryEpisodeSource.fromEpisodes([{ ...episode, status: 'draft' }]) as never,
    );
    expect((await getEpisode('test-episode'))?.status).toBe('draft');
  });
});

describe('idempotency and duplicate protection', () => {
  it('collapses a repeated trigger onto one paid job', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const first = await queueGeneration({ slug: 'test-episode', triggerSource: 'github' });
    const second = await queueGeneration({ slug: 'test-episode', triggerSource: 'github' });
    expect(first.status).toBe('queued');
    expect(second.status).toBe('duplicate');
    if (first.status !== 'queued' || second.status !== 'duplicate') return;
    expect(second.job.id).toBe(first.job.id);
    expect(await listJobs()).toHaveLength(1);
  });

  it('does not generate a second paid copy when the webhook is replayed after success', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const probe = createProviderProbe();
    const media = new InMemoryMediaStore();
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    const callsAfterFirstRun = probe.calls.length;

    const replay = await queueGeneration({ slug: 'test-episode', triggerSource: 'github' });
    expect(replay.status).toBe('already_generated');

    // Even re-running the same job id must not re-bill.
    const rerun = await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    expect(rerun.status).toBe('skipped');
    expect(probe.calls).toHaveLength(callsAfterFirstRun);
  });

  it('ignores a second poke while the job is already leased', async () => {
    // Re-poking a queued job is how a stranded render is revived, so it has to
    // be safe against the case where the job was in fact already running.
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const probe = createProviderProbe();
    const media = new InMemoryMediaStore();
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    const first = runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    const second = runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Exactly one of them did the work; the other found the lease held.
    const statuses = [firstResult.status, secondResult.status].sort();
    expect(statuses).toEqual(['completed', 'skipped']);
    // The invariant that matters: one paid request per chunk, no repeats.
    expect(probe.calls).toHaveLength(chunkEpisode(makeEpisode({ dialogue: makeDialogue(4, 900) })).length);
  });

  it('reuses already-paid chunks when a job resumes', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(12, 900) }));
    const media = new InMemoryMediaStore();

    // A clock that advances 30s per provider call, against a 45s budget:
    // the first invocation renders part of the episode and then yields.
    let clock = 0;
    const probe = createProviderProbe({ onCall: () => { clock += 30_000; } });
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    const first = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: media,
      sleep: noSleep,
      budgetMs: 45_000,
      now: () => clock,
    });
    expect(first.status).toBe('incomplete');
    if (first.status !== 'incomplete') return;
    expect(first.chunksRemaining).toBeGreaterThan(0);
    const callsAfterYield = probe.calls.length;
    expect(callsAfterYield).toBeGreaterThan(0);

    const second = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: media,
      sleep: noSleep,
    });
    expect(second.status).toBe('completed');

    const chunks = await listChunks('test-episode', queued.job.contentVersion);
    // Total provider calls equals chunk count: nothing was paid for twice.
    expect(probe.calls).toHaveLength(chunks.length);
    expect(chunks.every((chunk) => chunk.status === 'generated')).toBe(true);
  });
});

describe('failure handling', () => {
  it('fails fast on an auth error without retrying', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const probe = createProviderProbe({ responses: [401] });
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    const result = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });

    expect(result.status).toBe('failed');
    expect(probe.calls).toHaveLength(1);
    const record = await getEpisode('test-episode');
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('401');
    const attempts = await listAttempts(queued.job.id);
    expect(attempts[0].error_kind).toBe('auth');
  });

  it('retries a transient server error within the attempt cap and then succeeds', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(2, 600) }));
    const probe = createProviderProbe({ responses: [500, 500, 'ok'] });
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    const result = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });

    expect(result.status).toBe('completed');
    expect(probe.calls).toHaveLength(3);
    expect((await getEpisode('test-episode'))?.status).toBe('published');
  });

  it('stops at the attempt cap instead of retrying forever', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(2, 600) }));
    const probe = createProviderProbe({ responses: [500] });
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    const result = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });

    expect(result.status).toBe('failed');
    expect(probe.calls.length).toBeLessThanOrEqual(3);
    const chunks = await listChunks('test-episode', queued.job.contentVersion);
    expect(chunks.some((chunk) => chunk.status === 'failed')).toBe(true);
  });

  it('cancels a queued job when the spec changes underneath it', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    // The author edits the script while the job waits in the queue.
    await syncEpisodes(
      MemoryEpisodeSource.fromEpisodes([
        makeEpisode({ dialogue: [...makeDialogue(4, 900), { speaker: 'host', text: 'One more thought.' }] }),
      ]) as never,
    );

    const probe = createProviderProbe();
    const result = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: new InMemoryMediaStore(),
      sleep: noSleep,
    });

    expect(result.status).toBe('failed');
    expect(probe.calls).toHaveLength(0);
    expect((await getEpisode('test-episode'))?.status).toBe('ready_for_audio');
  });
});

describe('regeneration', () => {
  it('re-renders on an explicit regenerate and tracks the extra spend', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const media = new InMemoryMediaStore();
    const probe = createProviderProbe();

    const first = await queueGeneration({ slug: 'test-episode' });
    if (first.status !== 'queued') throw new Error('expected queued');
    await runJob({ jobId: first.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    const callsAfterFirst = probe.calls.length;
    const afterFirst = await getEpisode('test-episode');

    const regen = await queueGeneration({ slug: 'test-episode', kind: 'regenerate_all' });
    expect(regen.status).toBe('queued');
    if (regen.status !== 'queued') return;
    const rerun = await runJob({ jobId: regen.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    expect(rerun.status).toBe('completed');
    expect(probe.calls.length).toBe(callsAfterFirst * 2);

    const afterRegen = await getEpisode('test-episode');
    expect(afterRegen?.status).toBe('published');
    expect(afterRegen?.regenerationCostUsd).toBeGreaterThan(0);
    expect(afterRegen?.publishedAt).toBe(afterFirst?.publishedAt);
  });

  it('collapses a double-clicked regenerate into one job', async () => {
    await seed(makeEpisode({ dialogue: makeDialogue(4, 900) }));
    const a = await queueGeneration({ slug: 'test-episode', kind: 'regenerate_all' });
    const b = await queueGeneration({ slug: 'test-episode', kind: 'regenerate_all' });
    expect(a.status).toBe('queued');
    expect(b.status).toBe('duplicate');
    expect(await listJobs()).toHaveLength(1);
  });
});

describe('chapter derivation', () => {
  it('interpolates a chapter position inside its chunk', () => {
    const episode = makeEpisode({
      dialogue: [
        { speaker: 'host', text: 'a'.repeat(300) },
        { speaker: 'guest', text: 'b'.repeat(300) },
        { speaker: 'host', text: 'c'.repeat(300) },
      ],
      chapters: [
        { title: 'Start', start_seconds: null, dialogue_index: 0 },
        { title: 'Middle', start_seconds: null, dialogue_index: 1 },
        { title: 'End', start_seconds: null, dialogue_index: 2 },
      ],
    });
    const chunks = chunkEpisode(episode);
    expect(chunks).toHaveLength(1); // 900 characters fits one chunk
    const chapters = deriveChapters(episode, chunks, [
      { chunkId: chunks[0].chunkId, startSeconds: 0, durationSeconds: 90 },
    ]);
    // Positions track character offset, not the chunk boundary.
    expect(chapters.map((chapter) => chapter.startSeconds)).toEqual([0, 30, 60]);
  });

  it('respects an explicit start_seconds', () => {
    const episode = makeEpisode({
      chapters: [{ title: 'Fixed', start_seconds: 42, dialogue_index: 0 }],
    });
    const chunks = chunkEpisode(episode);
    const chapters = deriveChapters(episode, chunks, [
      { chunkId: chunks[0].chunkId, startSeconds: 0, durationSeconds: 10 },
    ]);
    expect(chapters).toEqual([{ title: 'Fixed', startSeconds: 42 }]);
  });

  it('skips a chapter with no anchor', () => {
    const episode = makeEpisode({ chapters: [{ title: 'Floating', start_seconds: null }] });
    const chunks = chunkEpisode(episode);
    expect(deriveChapters(episode, chunks, [{ chunkId: chunks[0].chunkId, startSeconds: 0, durationSeconds: 10 }])).toEqual([]);
  });
});
