/**
 * Content addressing for episodes.
 *
 * Generation is idempotent *per content version*: if the dialogue, cast or
 * renderer settings have not changed, a repeated trigger must never produce a
 * second paid render. Cosmetic edits (title, subtitle, sources) deliberately do
 * not change the version.
 */
import { createHash } from 'node:crypto';
import type { EpisodeSpec } from './schema';

export type RenderInputs = {
  model: string;
  outputFormat: string;
  /** Resolved speaker key -> voice id, so a voice swap forces a new version. */
  voices: Record<string, string>;
};

/** Stable SHA-256 over everything that can change the rendered audio. */
export function episodeContentVersion(episode: EpisodeSpec, render: RenderInputs): string {
  const payload = {
    schema_version: episode.schema_version,
    slug: episode.slug,
    format: episode.format,
    model: render.model,
    output_format: render.outputFormat,
    voices: Object.keys(render.voices)
      .sort()
      .map((key) => [key, render.voices[key]]),
    dialogue: episode.dialogue.map((line) => [line.speaker, line.delivery ?? '', line.text]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

export function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}
