import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEpisode } from '../lib/db/store';
import { syncEpisodes } from '../lib/episode/service';
import { MANIFEST_PREFIX, parseManifest } from '../lib/episode/manifest';
import { queueGeneration, runJob } from '../lib/jobs/runner';
import { InMemoryMediaStore } from '../lib/storage/media-store';
import { resetTestDb, useTestDb } from './helpers/db';
import { MemoryEpisodeSource, makeDialogue, makeEpisode } from './helpers/episodes';
import { createProviderProbe } from './helpers/provider';

/**
 * The operational database is declared disposable by the architecture, so this
 * proves it actually is. A wiped database must cost job history — never the
 * library, and never a second payment for audio already rendered.
 */

const noSleep = async () => {};

describe('rebuilding a lost database from storage', () => {
  beforeEach(async () => {
    await useTestDb();
  });
  afterEach(() => {
    resetTestDb();
  });

  it('restores a published episode after the database is destroyed', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(6, 900), status: 'ready_for_audio' });
    const source = MemoryEpisodeSource.fromEpisodes([episode]);
    // Storage survives; only the database is lost.
    const media = new InMemoryMediaStore({ addRandomSuffix: true });
    const probe = createProviderProbe();

    await syncEpisodes(source as never);
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    const run = await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });
    expect(run.status).toBe('completed');

    const before = await getEpisode('test-episode');
    expect(before?.status).toBe('published');
    const paidRequests = probe.calls.length;

    // The deployment replaces the database with an empty one.
    await useTestDb();
    expect(await getEpisode('test-episode')).toBeNull();

    // A plain sync is all that runs on an ordinary page load.
    const outcome = await syncEpisodes(source as never, media);
    expect(outcome.recovered).toEqual(['test-episode']);

    const after = await getEpisode('test-episode');
    expect(after?.status).toBe('published');
    expect(after?.audioUrl).toBe(before?.audioUrl);
    expect(after?.audioKey).toBe(before?.audioKey);
    expect(after?.audioDurationSeconds).toBe(before?.audioDurationSeconds);
    expect(after?.audioChecksum).toBe(before?.audioChecksum);
    expect(after?.chapters).toEqual(before?.chapters);
    expect(after?.actualCharacters).toBe(before?.actualCharacters);

    // Recovery is not a render: nothing was bought to get the episode back.
    expect(probe.calls).toHaveLength(paidRequests);
    // And the restored audio is genuinely readable, not just a recorded string.
    await expect(media.get(after!.audioUrl!)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('does not touch storage when there is nothing that could be recovered', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(4, 900), status: 'draft' });
    const media = new InMemoryMediaStore();
    let listCalls = 0;
    const counting = new Proxy(media, {
      get(target, property, receiver) {
        if (property === 'list') {
          listCalls += 1;
          return target.list.bind(target);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const outcome = await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never, counting);
    expect(outcome.recovered).toEqual([]);
    expect(listCalls).toBe(0);
  });

  it('will not apply a manifest belonging to a different content version', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(6, 900), status: 'ready_for_audio' });
    const media = new InMemoryMediaStore({ addRandomSuffix: true });
    const probe = createProviderProbe();

    await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });

    // The script is edited: same slug, different content version.
    const edited = makeEpisode({
      dialogue: [...makeDialogue(6, 900), { speaker: 'host', text: 'One more thought entirely.' }],
      status: 'ready_for_audio',
    });

    await useTestDb();
    const outcome = await syncEpisodes(MemoryEpisodeSource.fromEpisodes([edited]) as never, media);

    // Stale audio must never be attached to a rewritten episode.
    expect(outcome.recovered).toEqual([]);
    expect((await getEpisode('test-episode'))?.audioUrl).toBeNull();
  });

  it('reads only the manifests of episodes it is trying to recover', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(6, 900), status: 'ready_for_audio' });
    const media = new InMemoryMediaStore({ addRandomSuffix: true });
    const probe = createProviderProbe();

    await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never);
    const queued = await queueGeneration({ slug: 'test-episode' });
    if (queued.status !== 'queued') throw new Error('expected queued');
    await runJob({ jobId: queued.job.id, client: probe.client, mediaStore: media, sleep: noSleep });

    // A larger library: manifests belonging to episodes we are not recovering.
    for (const other of ['another-show', 'a-third-show', 'yet-another']) {
      await media.put(
        `${MANIFEST_PREFIX}${other}/someversion.json`,
        new TextEncoder().encode('{"manifestVersion":1}'),
        'application/json',
      );
    }

    const reads: string[] = [];
    const watched = new Proxy(media, {
      get(target, property, receiver) {
        if (property === 'get') {
          return (keyOrUrl: string) => {
            reads.push(keyOrUrl);
            return target.get(keyOrUrl);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await useTestDb();
    const outcome = await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never, watched);
    expect(outcome.recovered).toEqual(['test-episode']);

    // Exactly one manifest fetched, and it belongs to the episode being restored.
    const manifestReads = reads.filter((key) => key.includes(MANIFEST_PREFIX));
    expect(manifestReads).toHaveLength(1);
    expect(manifestReads[0]).toContain('test-episode');
  });

  it('ignores a corrupt manifest rather than failing the sync', async () => {
    const episode = makeEpisode({ dialogue: makeDialogue(4, 900), status: 'ready_for_audio' });
    const media = new InMemoryMediaStore();
    await media.put(`${MANIFEST_PREFIX}test-episode/whatever.json`, new TextEncoder().encode('{not json'), 'application/json');

    const outcome = await syncEpisodes(MemoryEpisodeSource.fromEpisodes([episode]) as never, media);
    expect(outcome.recovered).toEqual([]);
    expect(outcome.synced).toHaveLength(1);
  });

  it('rejects a manifest that is missing required facts', () => {
    expect(parseManifest({ manifestVersion: 1, slug: 'a' })).toBeNull();
    expect(parseManifest({ manifestVersion: 2, slug: 'a' })).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });
});
