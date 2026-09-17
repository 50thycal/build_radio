/**
 * Delete a generated episode audio file.
 *
 * Removes the stitched file and resets the episode to ready_for_audio. Chunk
 * audio is kept, so re-publishing after an accidental delete costs nothing.
 */
import { hasValidSession, verifyInternalSecret } from '@/lib/auth';
import { badRequest, json, unauthorized } from '@/lib/http';
import { clearEpisodeAudio, getEpisode } from '@/lib/db/store';
import { createMediaStore } from '@/lib/storage/media-store';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const authorised = verifyInternalSecret(request) || (await hasValidSession(request));
  if (!authorised) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { slug?: string };
  const slug = body.slug?.trim();
  if (!slug) return badRequest('slug is required');

  const record = await getEpisode(slug);
  if (!record) return badRequest(`Unknown episode "${slug}"`);
  if (!record.audioKey) return json({ status: 'no-op', reason: 'Episode has no generated audio' });

  try {
    await createMediaStore().remove(record.audioKey);
  } catch (error) {
    // A missing object should still let the record be cleaned up.
    await logger.warn('audio.delete.failed', { detail: String(error) }, { slug });
  }
  await clearEpisodeAudio(slug);
  await logger.info('audio.deleted', { audioKey: record.audioKey }, { slug });
  return json({ status: 'deleted', slug });
}
