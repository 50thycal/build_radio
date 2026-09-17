/**
 * The Episode Specification is the portable heart of Build OS Radio.
 *
 * Design rules:
 *  - It is structured data, not a transcript. Audio, RSS, video and analytics
 *    are all downstream renderings of this object.
 *  - It is provider agnostic. ElevenLabs is a renderer; nothing ElevenLabs
 *    specific may become *required* here.
 *  - It is versioned from day one via `schema_version`.
 */
import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

/** Lifecycle of an episode. Authors only ever write `draft` or
 *  `ready_for_audio`; every later state is owned by the runtime. */
export const EPISODE_STATUSES = [
  'draft',
  'ready_for_audio',
  'queued',
  'generating',
  'stitching',
  'uploading',
  'published',
  'failed',
] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

/** Statuses an authored file in GitHub is allowed to declare. */
export const AUTHORED_STATUSES = ['draft', 'ready_for_audio'] as const;
export type AuthoredStatus = (typeof AUTHORED_STATUSES)[number];

export const AUDIO_STATUSES = [
  'not_generated',
  'generating',
  'stitching',
  'uploading',
  'ready',
  'failed',
] as const;
export type AudioStatus = (typeof AUDIO_STATUSES)[number];

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SpeakerSchema = z.object({
  /** Display name, e.g. "Build". */
  name: z.string().min(1),
  /** Optional override. Empty string means "resolve from configuration". */
  voice_id: z.string().default(''),
  /** Optional free-text role description for future multi-voice casting. */
  role: z.string().optional(),
});
export type Speaker = z.infer<typeof SpeakerSchema>;

const DialogueLineSchema = z.object({
  /** Key into `speakers`. Validated against the cast in `validateEpisode`. */
  speaker: z.string().min(1),
  text: z.string().min(1),
  /** Optional per-line delivery hint, e.g. "curious". Inline bracket cues such
   *  as [thoughtfully] inside `text` are also supported and passed through. */
  delivery: z.string().optional(),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

const ChapterSchema = z.object({
  title: z.string().min(1),
  /** Start time in seconds. Null until audio exists and chapters are derived. */
  start_seconds: z.number().nonnegative().nullable().default(null),
  /** Index into `dialogue` that this chapter starts at, when known. */
  dialogue_index: z.number().int().nonnegative().optional(),
});

const SourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().optional(),
});

const GenerationSchema = z.object({
  provider: z.string().default('elevenlabs'),
  model: z.string().default('eleven_v3'),
  estimated_characters: z.number().nonnegative().default(0),
  estimated_cost_usd: z.number().nonnegative().default(0),
  actual_characters: z.number().nonnegative().default(0),
  actual_cost_usd: z.number().nonnegative().default(0),
  regeneration_cost_usd: z.number().nonnegative().default(0),
  chunk_count: z.number().int().nonnegative().default(0),
});

const AudioSchema = z.object({
  status: z.enum(AUDIO_STATUSES).default('not_generated'),
  duration_seconds: z.number().nonnegative().nullable().default(null),
  url: z.string().nullable().default(null),
  /** Content hash of the stitched file, useful for cache busting. */
  checksum: z.string().nullable().default(null),
});

export const EpisodeSpecSchema = z
  .object({
    schema_version: z.number().int().positive(),
    id: z.string().min(1),
    slug: z.string().regex(slugPattern, 'slug must be kebab-case'),
    title: z.string().min(1),
    subtitle: z.string().default(''),
    project: z.string().default('build-os'),
    created_at: z.string().datetime({ offset: true }),
    status: z.enum(EPISODE_STATUSES),
    format: z.string().default('host_guest'),
    estimated_runtime_minutes: z.number().nonnegative().default(0),
    description: z.string().default(''),
    speakers: z.record(z.string(), SpeakerSchema),
    dialogue: z.array(DialogueLineSchema).min(1),
    chapters: z.array(ChapterSchema).default([]),
    sources: z.array(SourceSchema).default([]),
    generation: GenerationSchema.default({}),
    audio: AudioSchema.default({}),
    /** Free-form authoring metadata; never interpreted by the pipeline. */
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type EpisodeSpec = z.infer<typeof EpisodeSpecSchema>;

export type EpisodeValidationIssue = {
  path: string;
  message: string;
};

export type EpisodeValidationResult =
  | { ok: true; episode: EpisodeSpec; warnings: EpisodeValidationIssue[] }
  | { ok: false; issues: EpisodeValidationIssue[]; warnings: EpisodeValidationIssue[] };

/**
 * Parse and semantically validate an episode specification.
 *
 * Beyond the shape check this enforces the invariants the renderer depends on:
 * a supported schema version, every dialogue speaker present in the cast, and
 * a slug that matches the id used for storage keys.
 */
export function validateEpisode(input: unknown): EpisodeValidationResult {
  const issues: EpisodeValidationIssue[] = [];
  const warnings: EpisodeValidationIssue[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ path: '', message: 'Episode must be a JSON object' }], warnings };
  }

  const version = (input as Record<string, unknown>).schema_version;
  if (typeof version !== 'number') {
    return {
      ok: false,
      issues: [{ path: 'schema_version', message: 'schema_version is required and must be a number' }],
      warnings,
    };
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version as 1)) {
    return {
      ok: false,
      issues: [
        {
          path: 'schema_version',
          message: `Unsupported schema_version ${version}. Supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
        },
      ],
      warnings,
    };
  }

  const parsed = EpisodeSpecSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: issue.path.join('.'), message: issue.message });
    }
    return { ok: false, issues, warnings };
  }

  const episode = parsed.data;

  const speakerKeys = Object.keys(episode.speakers);
  if (speakerKeys.length === 0) {
    issues.push({ path: 'speakers', message: 'At least one speaker is required' });
  }

  episode.dialogue.forEach((line, index) => {
    if (!speakerKeys.includes(line.speaker)) {
      issues.push({
        path: `dialogue.${index}.speaker`,
        message: `Unknown speaker "${line.speaker}". Declared speakers: ${speakerKeys.join(', ') || '(none)'}`,
      });
    }
  });

  const usedSpeakers = new Set(episode.dialogue.map((line) => line.speaker));
  for (const key of speakerKeys) {
    if (!usedSpeakers.has(key)) {
      warnings.push({ path: `speakers.${key}`, message: `Speaker "${key}" is declared but never speaks` });
    }
  }

  if (episode.id !== episode.slug) {
    warnings.push({ path: 'id', message: 'id and slug differ; slug is used for storage keys and URLs' });
  }

  episode.chapters.forEach((chapter, index) => {
    if (chapter.dialogue_index !== undefined && chapter.dialogue_index >= episode.dialogue.length) {
      issues.push({
        path: `chapters.${index}.dialogue_index`,
        message: 'dialogue_index is out of range',
      });
    }
  });

  if (issues.length > 0) return { ok: false, issues, warnings };
  return { ok: true, episode, warnings };
}

/** Throwing variant for call sites that treat invalid input as a bug. */
export function parseEpisodeOrThrow(input: unknown): EpisodeSpec {
  const result = validateEpisode(input);
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
    throw new EpisodeValidationError(`Invalid episode specification — ${detail}`, result.issues);
  }
  return result.episode;
}

export class EpisodeValidationError extends Error {
  readonly issues: EpisodeValidationIssue[];
  constructor(message: string, issues: EpisodeValidationIssue[]) {
    super(message);
    this.name = 'EpisodeValidationError';
    this.issues = issues;
  }
}

/** Plain-text transcript rendering, used by the UI and by content hashing. */
export function transcriptText(episode: EpisodeSpec): string {
  return episode.dialogue
    .map((line) => `${episode.speakers[line.speaker]?.name ?? line.speaker}: ${line.text}`)
    .join('\n\n');
}

/** Total billable characters: exactly the text we will send to the provider. */
export function episodeCharacterCount(episode: EpisodeSpec): number {
  return episode.dialogue.reduce((total, line) => total + line.text.length, 0);
}

export function episodeWordCount(episode: EpisodeSpec): number {
  return episode.dialogue.reduce((total, line) => {
    const words = line.text.trim().split(/\s+/).filter(Boolean);
    return total + words.length;
  }, 0);
}
