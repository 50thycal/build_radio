/**
 * Episode fixtures.
 */
import type { EpisodeSpec } from '../../lib/episode/schema';
import { parseEpisodeOrThrow } from '../../lib/episode/schema';

export function makeEpisode(overrides: Partial<Record<string, unknown>> = {}): EpisodeSpec {
  return parseEpisodeOrThrow({
    schema_version: 1,
    id: 'test-episode',
    slug: 'test-episode',
    title: 'Test Episode',
    subtitle: 'A fixture',
    project: 'build-os',
    created_at: '2026-09-17T14:00:00Z',
    status: 'ready_for_audio',
    format: 'host_guest',
    estimated_runtime_minutes: 4,
    speakers: {
      host: { name: 'Build', voice_id: '' },
      guest: { name: 'Analyst', voice_id: '' },
    },
    dialogue: [
      { speaker: 'host', text: 'Welcome back to Build OS Radio.' },
      { speaker: 'guest', text: 'Glad to be here. Let us dig in.' },
    ],
    ...overrides,
  });
}

/** Alternating host/guest dialogue of a requested per-line length. */
export function makeDialogue(lineCount: number, charactersPerLine: number) {
  const sentence = (index: number) => {
    const body = `This is sentence ${index} about strategy and timing. `;
    let text = '';
    while (text.length < charactersPerLine) text += body;
    return text.slice(0, charactersPerLine).trim();
  };
  return Array.from({ length: lineCount }, (_, index) => ({
    speaker: index % 2 === 0 ? 'host' : 'guest',
    text: sentence(index),
  }));
}

/** An in-memory EpisodeSource so tests need no filesystem or network. */
export class MemoryEpisodeSource {
  readonly name = 'memory';
  constructor(private readonly files: { path: string; slug: string; raw: string }[]) {}

  static fromEpisodes(episodes: EpisodeSpec[], directory = 'episodes/drafts'): MemoryEpisodeSource {
    return new MemoryEpisodeSource(
      episodes.map((episode) => ({
        path: `${directory}/${episode.slug}.json`,
        slug: episode.slug,
        raw: JSON.stringify(episode),
      })),
    );
  }

  async listFiles() {
    return this.files;
  }

  async readFileAt(repoPath: string) {
    return this.files.find((file) => file.path === repoPath) ?? null;
  }
}
