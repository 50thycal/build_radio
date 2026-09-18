/**
 * Publish manifests: how a lost database rebuilds itself.
 *
 * The architecture says GitHub owns what an episode is, object storage owns the
 * audio, and the database owns what happened when we rendered it. That only
 * holds up if the database is genuinely disposable — and it was not. Wipe it
 * and a published episode became unreachable: the MP3 was still in storage, but
 * the only record of where it lived, how long it ran and where its chapters
 * fell went with the database. The library forgot episodes it still owned.
 *
 * So every publish now writes a small JSON manifest next to the audio. It holds
 * exactly the facts needed to restore the episode row, and nothing that can be
 * recomputed from the spec. Storage becomes self-describing, and a wiped
 * database costs job history rather than the library.
 *
 * Recovery is keyed by content version, so a manifest is only ever applied to
 * the render it was written for.
 */
import { publishEpisodeAudio, type EpisodeRecord } from '../db/store';
import { logger } from '../log';
import { createMediaStore, episodeManifestKey, type MediaStore } from '../storage/media-store';

export const MANIFEST_PREFIX = 'manifests/';

export type PublishManifest = {
  manifestVersion: 1;
  slug: string;
  contentVersion: string;
  audioKey: string;
  audioUrl: string;
  durationSeconds: number;
  checksum: string;
  actualCharacters: number;
  actualCostUsd: number;
  chapters: { title: string; startSeconds: number }[];
  publishedAt: string;
};

/** Narrow an unknown parsed JSON value to a manifest we are willing to act on. */
export function parseManifest(raw: unknown): PublishManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.manifestVersion !== 1) return null;
  const strings = ['slug', 'contentVersion', 'audioKey', 'audioUrl', 'checksum', 'publishedAt'] as const;
  for (const field of strings) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) return null;
  }
  const numbers = ['durationSeconds', 'actualCharacters', 'actualCostUsd'] as const;
  for (const field of numbers) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) return null;
  }
  const chapters = Array.isArray(value.chapters)
    ? value.chapters.filter(
        (chapter): chapter is { title: string; startSeconds: number } =>
          typeof chapter === 'object' &&
          chapter !== null &&
          typeof (chapter as { title?: unknown }).title === 'string' &&
          typeof (chapter as { startSeconds?: unknown }).startSeconds === 'number',
      )
    : [];
  return { ...(value as unknown as PublishManifest), chapters };
}

/** Write the manifest for a finished render. Never fails a publish. */
export async function writeManifest(
  manifest: PublishManifest,
  mediaStore: MediaStore = createMediaStore(),
): Promise<void> {
  const key = episodeManifestKey(manifest.slug, manifest.contentVersion);
  const body = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  try {
    await mediaStore.put(key, body, 'application/json');
  } catch (error) {
    // The audio is already stored and the database already updated. A missing
    // manifest costs recoverability later, not this render now.
    await logger.warn(
      'manifest.write.failed',
      { detail: String(error), key },
      { slug: manifest.slug, persist: false },
    );
  }
}

/** Manifests found in storage, newest publish per content version. */
async function loadManifests(mediaStore: MediaStore): Promise<Map<string, PublishManifest>> {
  const objects = await mediaStore.list(MANIFEST_PREFIX);
  const byVersion = new Map<string, PublishManifest>();

  for (const object of objects) {
    let manifest: PublishManifest | null = null;
    try {
      const bytes = await mediaStore.get(object.url);
      manifest = parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      manifest = null; // A corrupt or unreadable manifest is skipped, not fatal.
    }
    if (!manifest) continue;

    // A regenerated episode leaves an older manifest behind at a different
    // storage path, so prefer the most recent publish.
    const identity = `${manifest.slug}@${manifest.contentVersion}`;
    const existing = byVersion.get(identity);
    if (!existing || manifest.publishedAt > existing.publishedAt) byVersion.set(identity, manifest);
  }

  return byVersion;
}

export type RecoveryOutcome = { recovered: string[]; checked: number };

/**
 * Restore audio for episodes whose record has lost it.
 *
 * Only episodes that could plausibly have been rendered are considered, so a
 * library of drafts costs no storage calls at all, and a steady state where
 * everything already has its audio costs none either.
 */
export async function recoverPublishedAudio(
  records: EpisodeRecord[],
  mediaStore: MediaStore = createMediaStore(),
): Promise<RecoveryOutcome> {
  const candidates = records.filter((record) => !record.audioUrl && record.status !== 'draft');
  if (candidates.length === 0) return { recovered: [], checked: 0 };

  let manifests: Map<string, PublishManifest>;
  try {
    manifests = await loadManifests(mediaStore);
  } catch (error) {
    await logger.warn('manifest.list.failed', { detail: String(error) }, { persist: false });
    return { recovered: [], checked: candidates.length };
  }

  const recovered: string[] = [];
  for (const record of candidates) {
    const manifest = manifests.get(`${record.slug}@${record.contentVersion}`);
    if (!manifest) continue;

    await publishEpisodeAudio({
      slug: record.slug,
      audioKey: manifest.audioKey,
      audioUrl: manifest.audioUrl,
      durationSeconds: manifest.durationSeconds,
      checksum: manifest.checksum,
      actualCharacters: manifest.actualCharacters,
      actualCostUsd: manifest.actualCostUsd,
      // Recovery restores a past render; it did not spend anything now.
      regenerationCostUsd: 0,
      chapters: manifest.chapters,
    });
    recovered.push(record.slug);
  }

  if (recovered.length > 0) {
    await logger.info('episodes.recovered', { slugs: recovered }, { persist: false });
  }
  return { recovered, checked: candidates.length };
}
