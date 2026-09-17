import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { episodesFromPush } from '../lib/github/webhook';
import { listJobs, recordDelivery } from '../lib/db/store';
import { triggerEpisodes } from '../lib/jobs/trigger';
import { redact } from '../lib/log';
import { resetTestDb, useTestDb } from './helpers/db';
import { MemoryEpisodeSource, makeDialogue, makeEpisode } from './helpers/episodes';

describe('push payload interpretation', () => {
  it('extracts slugs from added and modified spec files', () => {
    const result = episodesFromPush({
      ref: 'refs/heads/main',
      commits: [
        { added: ['episodes/drafts/new-one.json'], modified: ['episodes/published/old-one.json'] },
        { modified: ['README.md', 'episodes/drafts/new-one.json'] },
      ],
    });
    expect(result.branch).toBe('main');
    expect(result.changed.sort()).toEqual(['new-one', 'old-one']);
    expect(result.removed).toEqual([]);
  });

  it('ignores files outside the episode folders', () => {
    const result = episodesFromPush({
      ref: 'refs/heads/main',
      commits: [{ modified: ['lib/config.ts', 'episodes/README.md', 'episodes/drafts/nested/deep.json'] }],
    });
    expect(result.changed).toEqual([]);
  });

  it('treats a move from drafts to published as a change, not a deletion', () => {
    const result = episodesFromPush({
      ref: 'refs/heads/main',
      commits: [{ added: ['episodes/published/moved.json'], removed: ['episodes/drafts/moved.json'] }],
    });
    expect(result.changed).toEqual(['moved']);
    expect(result.removed).toEqual([]);
  });

  it('reports the branch so pushes to other branches can be ignored', () => {
    expect(episodesFromPush({ ref: 'refs/heads/feature/x' }).branch).toBe('feature/x');
    expect(episodesFromPush({ ref: 'refs/tags/v1' }).branch).toBeNull();
  });

  it('reads the head_commit when commits is absent', () => {
    const result = episodesFromPush({
      ref: 'refs/heads/main',
      head_commit: { modified: ['episodes/drafts/solo.json'] },
    });
    expect(result.changed).toEqual(['solo']);
  });
});

describe('trigger rules', () => {
  beforeEach(async () => {
    await useTestDb();
  });
  afterEach(() => {
    resetTestDb();
  });

  it('never queues a draft', async () => {
    const source = MemoryEpisodeSource.fromEpisodes([makeEpisode({ status: 'draft' })]);
    const outcomes = await triggerEpisodes({
      slugs: ['test-episode'],
      triggerSource: 'github-webhook',
      source: source as never,
      dispatch: false,
    });
    expect(outcomes[0].result).toBe('skipped_draft');
    expect(await listJobs()).toHaveLength(0);
  });

  it('queues a ready episode exactly once across repeated pushes', async () => {
    const source = MemoryEpisodeSource.fromEpisodes([makeEpisode({ dialogue: makeDialogue(4, 800) })]);
    const first = await triggerEpisodes({
      slugs: ['test-episode'],
      triggerSource: 'github-webhook',
      source: source as never,
      dispatch: false,
    });
    const second = await triggerEpisodes({
      slugs: ['test-episode'],
      triggerSource: 'github-webhook',
      source: source as never,
      dispatch: false,
    });
    expect(first[0].result).toBe('queued');
    expect(second[0].result).toBe('duplicate');
    expect(await listJobs()).toHaveLength(1);
  });

  it('reports an invalid spec without blocking the rest of the push', async () => {
    const source = new MemoryEpisodeSource([
      { path: 'episodes/drafts/broken.json', slug: 'broken', raw: '{ "schema_version": 1 }' },
      {
        path: 'episodes/drafts/test-episode.json',
        slug: 'test-episode',
        raw: JSON.stringify(makeEpisode({ dialogue: makeDialogue(4, 800) })),
      },
    ]);
    const outcomes = await triggerEpisodes({
      slugs: ['broken', 'test-episode'],
      triggerSource: 'github-webhook',
      source: source as never,
      dispatch: false,
    });
    expect(outcomes[0].result).toBe('invalid');
    expect(outcomes[1].result).toBe('queued');
  });

  it('reports a slug with no spec file', async () => {
    const outcomes = await triggerEpisodes({
      slugs: ['ghost'],
      triggerSource: 'github-webhook',
      source: new MemoryEpisodeSource([]) as never,
      dispatch: false,
    });
    expect(outcomes[0].result).toBe('not_found');
  });

  it('does not re-render an episode whose status has moved past ready', async () => {
    const source = MemoryEpisodeSource.fromEpisodes([makeEpisode({ status: 'published' })]);
    const outcomes = await triggerEpisodes({
      slugs: ['test-episode'],
      triggerSource: 'github-webhook',
      source: source as never,
      dispatch: false,
    });
    expect(outcomes[0].result).toBe('skipped_draft');
    expect(outcomes[0].detail).toContain('published');
    expect(await listJobs()).toHaveLength(0);
  });
});

describe('webhook delivery de-duplication', () => {
  beforeEach(async () => {
    await useTestDb();
  });
  afterEach(() => {
    resetTestDb();
  });

  it('accepts a delivery id once', async () => {
    expect(await recordDelivery('delivery-1', 'github')).toBe(true);
    expect(await recordDelivery('delivery-1', 'github')).toBe(false);
    expect(await recordDelivery('delivery-2', 'github')).toBe(true);
  });
});

describe('log redaction', () => {
  it('removes live secret values from log lines', () => {
    const line = `provider said key ${process.env.ELEVENLABS_API_KEY} is invalid`;
    expect(redact(line)).not.toContain(process.env.ELEVENLABS_API_KEY!);
    expect(redact(line)).toContain('[redacted:ELEVENLABS_API_KEY]');
  });

  it('removes provider-style keys it has never seen', () => {
    expect(redact('Authorization: sk-abcdefghijklmnopqrstuvwxyz012345')).toContain('[redacted:key]');
  });
});
