/**
 * Episode service: the join between the authored spec (GitHub) and the
 * operational record (database).
 *
 * Everything the UI and the pipeline need about an episode is assembled here,
 * so neither of them has to know which half of the truth lives where.
 */
import { createHash } from 'node:crypto';
import { chunkEpisode, type DialogueChunk } from '../chunking';
import { elevenLabsConfig } from '../config';
import { checkSpendLimits, estimateEpisode, type EpisodeEstimate, type GuardResult } from '../cost';
import { missingVoices, resolveVoices } from '../elevenlabs';
import {
  getEpisode,
  listChunks,
  listEpisodes,
  upsertEpisode,
  type ChunkRecord,
  type EpisodeRecord,
} from '../db/store';
import { episodeContentVersion } from './version';
import {
  createEpisodeSource,
  loadAllEpisodes,
  loadEpisodeBySlug,
  type EpisodeSource,
  type LoadedEpisode,
} from './source';
import type { EpisodeSpec } from './schema';
import type { MediaStore } from '../storage/media-store';

/** Everything needed to render an episode, computed deterministically. */
export type RenderPlan = {
  episode: EpisodeSpec;
  contentVersion: string;
  voices: Record<string, string>;
  missingVoices: string[];
  chunks: DialogueChunk[];
  estimate: EpisodeEstimate;
  limits: GuardResult;
};

export function buildRenderPlan(episode: EpisodeSpec, env: NodeJS.ProcessEnv = process.env): RenderPlan {
  const voices = resolveVoices(episode.speakers, env);
  const contentVersion = episodeContentVersion(episode, {
    model: elevenLabsConfig.model,
    outputFormat: elevenLabsConfig.outputFormat,
    voices,
  });
  const chunks = chunkEpisode(episode);
  const estimate = estimateEpisode(episode, { chunks });
  return {
    episode,
    contentVersion,
    voices,
    missingVoices: missingVoices(voices),
    chunks,
    estimate,
    limits: checkSpendLimits(estimate),
  };
}

/** Hash of a chunk's exact provider payload; a change invalidates its audio. */
export function chunkTextHash(chunk: DialogueChunk): string {
  const payload = chunk.segments.map((segment) => [segment.speaker, segment.text]);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

export type SyncOutcome = {
  synced: { slug: string; status: string; contentVersion: string }[];
  invalid: { path: string; slug: string; issues: { path: string; message: string }[] }[];
  /** Episodes whose audio was restored from storage after losing the record. */
  recovered?: string[];
};

/**
 * Refresh the database's cached copy of every authored spec.
 *
 * Safe to call on any request path that lists episodes: it is idempotent and
 * never touches runtime columns.
 */
export async function syncEpisodes(
  source: EpisodeSource = createEpisodeSource(),
  mediaStore?: MediaStore,
): Promise<SyncOutcome> {
  const loaded = await loadAllEpisodes(source);
  const outcome: SyncOutcome = { synced: [], invalid: [] };

  for (const item of loaded) {
    if (!item.ok) {
      outcome.invalid.push({ path: item.path, slug: item.slug, issues: item.issues });
      continue;
    }
    const plan = buildRenderPlan(item.episode);
    await upsertEpisode({
      slug: item.episode.slug,
      title: item.episode.title,
      project: item.episode.project,
      status: item.episode.status,
      contentVersion: plan.contentVersion,
      specJson: JSON.stringify(item.episode),
      specSource: source.name,
      estimatedCharacters: plan.estimate.characters,
      estimatedCostUsd: plan.estimate.estimatedCostUsd,
      estimatedRuntimeSeconds: plan.estimate.estimatedRuntimeSeconds,
      estimatedChunkCount: plan.estimate.chunkCount,
    });
    outcome.synced.push({
      slug: item.episode.slug,
      status: item.episode.status,
      contentVersion: plan.contentVersion,
    });
  }

  // A spec sync recreates the episode rows but not what was rendered from
  // them, so this is where a database that lost its audio gets it back. It
  // costs nothing when every non-draft episode already has its audio.
  try {
    const { recoverPublishedAudio } = await import('./manifest');
    const { createMediaStore } = await import('../storage/media-store');
    const store = mediaStore ?? createMediaStore();
    outcome.recovered = (await recoverPublishedAudio(await listEpisodes(), store)).recovered;
  } catch {
    outcome.recovered = []; // Recovery is best effort; a sync must still succeed.
  }

  return outcome;
}

/** Sync a single spec, e.g. when a webhook names the file that changed. */
export async function syncEpisode(
  slug: string,
  source: EpisodeSource = createEpisodeSource(),
): Promise<LoadedEpisode | null> {
  const loaded = await loadEpisodeBySlug(slug, source);
  if (!loaded || !loaded.ok) return loaded;
  const plan = buildRenderPlan(loaded.episode);
  await upsertEpisode({
    slug: loaded.episode.slug,
    title: loaded.episode.title,
    project: loaded.episode.project,
    status: loaded.episode.status,
    contentVersion: plan.contentVersion,
    specJson: JSON.stringify(loaded.episode),
    specSource: source.name,
    estimatedCharacters: plan.estimate.characters,
    estimatedCostUsd: plan.estimate.estimatedCostUsd,
    estimatedRuntimeSeconds: plan.estimate.estimatedRuntimeSeconds,
    estimatedChunkCount: plan.estimate.chunkCount,
  });
  return loaded;
}

/** Spec + runtime state + estimate, as the UI consumes it. */
export type EpisodeView = {
  record: EpisodeRecord;
  spec: EpisodeSpec;
  estimate: EpisodeEstimate;
  plan: RenderPlan;
  chunks: ChunkRecord[];
};

export async function getEpisodeView(slug: string): Promise<EpisodeView | null> {
  const record = await getEpisode(slug);
  if (!record) return null;
  const spec = JSON.parse(record.specJson) as EpisodeSpec;
  const plan = buildRenderPlan(spec);
  const chunks = await listChunks(slug, record.contentVersion);
  return { record, spec, estimate: plan.estimate, plan, chunks };
}

export async function listEpisodeViews(): Promise<EpisodeView[]> {
  const records = await listEpisodes();
  return records.map((record) => {
    const spec = JSON.parse(record.specJson) as EpisodeSpec;
    const plan = buildRenderPlan(spec);
    return { record, spec, estimate: plan.estimate, plan, chunks: [] as ChunkRecord[] };
  });
}

/**
 * Derive chapter start times from the stitched timeline.
 *
 * A chapter declares the dialogue line it begins at. The renderer knows which
 * chunk that line fell into, when that chunk starts and how long it runs, so a
 * timestamp needs no transcription pass. Within the chunk the position is
 * interpolated by character offset — speech rate is near enough constant that
 * this lands within a few seconds, which is all a chapter mark needs.
 */
export function deriveChapters(
  spec: EpisodeSpec,
  chunks: DialogueChunk[],
  offsets: { chunkId: string; startSeconds: number; durationSeconds?: number }[],
): { title: string; startSeconds: number }[] {
  const offsetByChunk = new Map(offsets.map((offset) => [offset.chunkId, offset]));
  const derived: { title: string; startSeconds: number }[] = [];

  for (const chapter of spec.chapters) {
    if (chapter.start_seconds != null) {
      derived.push({ title: chapter.title, startSeconds: chapter.start_seconds });
      continue;
    }
    const dialogueIndex = chapter.dialogue_index;
    if (dialogueIndex === undefined) continue;
    const chunk = chunks.find(
      (candidate) => dialogueIndex >= candidate.lineRange[0] && dialogueIndex <= candidate.lineRange[1],
    );
    if (!chunk) continue;

    const offset = offsetByChunk.get(chunk.chunkId);
    if (!offset) continue;

    const charactersBefore = chunk.segments
      .filter((segment) => segment.lineIndex < dialogueIndex)
      .reduce((sum, segment) => sum + segment.characters, 0);
    const fraction = chunk.characters > 0 ? charactersBefore / chunk.characters : 0;
    const within = (offset.durationSeconds ?? 0) * fraction;

    derived.push({ title: chapter.title, startSeconds: Math.round((offset.startSeconds + within) * 10) / 10 });
  }

  return derived;
}
