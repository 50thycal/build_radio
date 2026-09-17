import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ElevenLabsClient, ProviderError } from '../lib/elevenlabs';
import { chunkEpisode } from '../lib/chunking';
import { getEpisode, listChunks } from '../lib/db/store';
import { syncEpisodes } from '../lib/episode/service';
import { queueGeneration, runJob } from '../lib/jobs/runner';
import { InMemoryMediaStore } from '../lib/storage/media-store';
import { resetTestDb, useTestDb } from './helpers/db';
import { MemoryEpisodeSource, makeDialogue, makeEpisode } from './helpers/episodes';
import { createProviderProbe } from './helpers/provider';

/**
 * A serverless invocation that is killed mid-request still bills the provider
 * but stores nothing, and the retry pays again. These tests cover the two
 * mechanisms that prevent that: the client aborts on its own deadline, and the
 * runner refuses to start a chunk it cannot finish.
 */

describe('provider request timeout', () => {
  it('aborts on the caller-supplied deadline rather than the configured one', async () => {
    // A request that never settles: only our own abort can end it.
    const client = new ElevenLabsClient({
      apiKey: 'test-key-0123456789abcdef',
      timeoutMs: 120_000,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });

    const startedAt = Date.now();
    await expect(
      client.generateDialogue([{ speaker: 'host', voiceId: 'v', text: 'hello' }], { timeoutMs: 1_000 }),
    ).rejects.toThrow(ProviderError);
    // It used the 1s override, not the 120s default.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  });

  it('reports a timeout as retryable, so a slow chunk is retried not abandoned', async () => {
    const client = new ElevenLabsClient({
      apiKey: 'test-key-0123456789abcdef',
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });

    try {
      await client.generateDialogue([{ speaker: 'host', voiceId: 'v', text: 'hello' }], { timeoutMs: 1_000 });
      expect.unreachable('should have timed out');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe('timeout');
      expect((error as ProviderError).retryable).toBe(true);
    }
  });
});

describe('invocation headroom', () => {
  beforeEach(async () => {
    await useTestDb();
  });
  afterEach(() => {
    resetTestDb();
  });

  it('never starts a second chunk it does not have time to finish', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(12, 900) });
    await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
    const chunkCount = chunkEpisode(episode).length;
    expect(chunkCount).toBeGreaterThan(2);

    // Each provider call consumes 30s of a 45s budget. With the default
    // 90s expectation for a chunk, only the first one may run.
    let clock = 0;
    const probe = createProviderProbe({ onCall: () => { clock += 30_000; } });

    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    const result = await runJob({
      jobId: queued.job.id,
      client: probe.client,
      mediaStore: new InMemoryMediaStore(),
      sleep: async () => {},
      budgetMs: 45_000,
      now: () => clock,
    });

    expect(result.status).toBe('incomplete');
    // Exactly one chunk: starting a second would have overrun the invocation.
    expect(probe.calls).toHaveLength(1);
    const chunks = await listChunks('test-episode', queued.job.contentVersion);
    expect(chunks.filter((chunk) => chunk.status === 'generated')).toHaveLength(1);
  });

  it('resumes across invocations until every chunk is paid for exactly once', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(12, 900) });
    await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
    const chunkCount = chunkEpisode(episode).length;
    const media = new InMemoryMediaStore();

    let clock = 0;
    const probe = createProviderProbe({ onCall: () => { clock += 30_000; } });
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');

    // One chunk per invocation, exactly as production would behave.
    for (let invocation = 0; invocation < chunkCount + 2; invocation += 1) {
      const result = await runJob({
        jobId: queued.job.id,
        client: probe.client,
        mediaStore: media,
        sleep: async () => {},
        budgetMs: 45_000,
        now: () => clock,
      });
      clock += 1_000;
      if (result.status === 'completed') break;
      expect(result.status).toBe('incomplete');
    }

    expect((await getEpisode('test-episode'))?.status).toBe('published');
    // The invariant that matters: one paid request per chunk, no repeats.
    expect(probe.calls).toHaveLength(chunkCount);
  });
});
