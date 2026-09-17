/**
 * Start a render.
 *
 * This is the endpoint the studio's Generate button calls. The browser side of
 * this deployment is open by choice (single owner, unlisted URL), so the spend
 * guards that matter are the ones in the pipeline itself: only ready_for_audio
 * renders, one paid job per content version, and hard character and cost
 * ceilings. It queues the job and returns immediately; work happens in
 * /api/jobs/run, which still requires the internal secret.
 */
import { badRequest, json } from '@/lib/http';
import { triggerJobRun } from '@/lib/jobs/dispatch';
import { queueGeneration } from '@/lib/jobs/runner';
import { syncEpisode } from '@/lib/episode/service';
import type { JobKind } from '@/lib/db/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: JobKind[] = ['generate', 'regenerate_all', 'regenerate_failed'];

export async function POST(request: Request): Promise<Response> {
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
