/**
 * Start a render.
 *
 * This is the only endpoint a human can use to spend money, so it requires a
 * session (the admin UI) or the internal secret (automation). It queues the
 * job and returns immediately; the work happens in /api/jobs/run.
 */
import { hasValidSession, verifyInternalSecret } from '@/lib/auth';
import { badRequest, json, unauthorized } from '@/lib/http';
import { triggerJobRun } from '@/lib/jobs/dispatch';
import { queueGeneration } from '@/lib/jobs/runner';
import { syncEpisode } from '@/lib/episode/service';
import type { JobKind } from '@/lib/db/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: JobKind[] = ['generate', 'regenerate_all', 'regenerate_failed'];

export async function POST(request: Request): Promise<Response> {
  const authorised = verifyInternalSecret(request) || (await hasValidSession(request));
  if (!authorised) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { slug?: string; kind?: string };
  const slug = body.slug?.trim();
  if (!slug) return badRequest('slug is required');

  const kind = (body.kind ?? 'generate') as JobKind;
  if (!KINDS.includes(kind)) return badRequest(`kind must be one of ${KINDS.join(', ')}`);

  // Pull the latest authored spec before deciding anything.
  await syncEpisode(slug);

  const result = await queueGeneration({ slug, kind, triggerSource: 'admin' });
  if (result.status === 'queued') {
    const dispatch = await triggerJobRun(result.job.id);
    return json({
      status: 'queued',
      jobId: result.job.id,
      chunkCount: result.plan.chunks.length,
      characters: result.plan.estimate.characters,
      estimatedCostUsd: result.plan.estimate.estimatedCostUsd,
      dispatched: dispatch.dispatched,
      dispatchError: dispatch.reason,
    });
  }
  if (result.status === 'duplicate') {
    return json({ status: 'duplicate', jobId: result.job.id, reason: result.reason });
  }
  if (result.status === 'already_generated') {
    return json({ status: 'already_generated', reason: result.reason });
  }
  return json({ status: 'rejected', reason: result.reason }, { status: 409 });
}
