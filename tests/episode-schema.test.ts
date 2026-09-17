import { describe, expect, it } from 'vitest';
import {
  episodeCharacterCount,
  episodeWordCount,
  transcriptText,
  validateEpisode,
} from '../lib/episode/schema';
import { parseEpisodeFile } from '../lib/episode/source';
import { makeEpisode } from './helpers/episodes';

const base = () => JSON.parse(JSON.stringify(makeEpisode())) as Record<string, unknown>;

describe('episode specification', () => {
  it('accepts a valid episode and applies defaults', () => {
    const result = validateEpisode(base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.episode.audio.status).toBe('not_generated');
    expect(result.episode.generation.provider).toBe('elevenlabs');
    expect(result.episode.chapters).toEqual([]);
  });

  it('rejects an unsupported schema version', () => {
    const result = validateEpisode({ ...base(), schema_version: 99 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe('schema_version');
    expect(result.issues[0].message).toContain('Unsupported schema_version 99');
  });

  it('rejects a missing schema version', () => {
    const { schema_version: _omitted, ...rest } = base();
    const result = validateEpisode(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe('schema_version');
  });

  it('rejects dialogue referencing an undeclared speaker', () => {
    const episode = base();
    episode.dialogue = [{ speaker: 'narrator', text: 'Who am I?' }];
    const result = validateEpisode(episode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe('dialogue.0.speaker');
    expect(result.issues[0].message).toContain('Unknown speaker "narrator"');
  });

  it('rejects an invalid lifecycle state', () => {
    const result = validateEpisode({ ...base(), status: 'sort-of-ready' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === 'status')).toBe(true);
  });

  it('rejects an empty dialogue array', () => {
    const result = validateEpisode({ ...base(), dialogue: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown top-level fields so typos are not silently ignored', () => {
    const result = validateEpisode({ ...base(), dialouge: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-kebab-case slug', () => {
    const result = validateEpisode({ ...base(), slug: 'Not A Slug' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === 'slug')).toBe(true);
  });

  it('warns about a declared speaker who never speaks', () => {
    const episode = base();
    episode.speakers = {
      host: { name: 'Build', voice_id: '' },
      guest: { name: 'Analyst', voice_id: '' },
      historian: { name: 'Historian', voice_id: '' },
    };
    const result = validateEpisode(episode);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.path === 'speakers.historian')).toBe(true);
  });

  it('rejects a chapter pointing past the end of the dialogue', () => {
    const episode = base();
    episode.chapters = [{ title: 'Nowhere', start_seconds: null, dialogue_index: 99 }];
    const result = validateEpisode(episode);
    expect(result.ok).toBe(false);
  });

  it('counts characters and words over dialogue only', () => {
    const episode = makeEpisode();
    const expectedCharacters = episode.dialogue.reduce((sum, line) => sum + line.text.length, 0);
    expect(episodeCharacterCount(episode)).toBe(expectedCharacters);
    expect(episodeWordCount(episode)).toBeGreaterThan(0);
    expect(transcriptText(episode)).toContain('Build: Welcome back');
  });
});

describe('episode files', () => {
  it('reports malformed JSON without throwing', () => {
    const result = parseEpisodeFile({ path: 'episodes/drafts/x.json', slug: 'x', raw: '{ nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].message).toContain('Invalid JSON');
  });

  it('rejects a slug that disagrees with the filename', () => {
    const raw = JSON.stringify(makeEpisode());
    const result = parseEpisodeFile({ path: 'episodes/drafts/other.json', slug: 'other', raw });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].message).toContain('does not match filename');
  });
});
