/**
 * The worker endpoint.
 *
 * Runs one job for as long as this invocation's time budget allows. If the job
 * is not finished, it pokes itself again — that chain is how a 20 minute
 * episode renders inside a serverless function with a hard timeout.
 *
 * Only the internal secret can call this: it is the endpoint that spends money.
 */
import { verifyInternalSecret } from '@/lib/auth';
import { json, unauthorized } from '@/lib/http';
import { findResumableJobs } from '@/lib/db/store';
import { triggerJobRun } from '@/lib/jobs/dispatch';
import { runJob } from '@/lib/jobs/runner';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Keep inside the lowest Vercel plan limit; raise on Pro if you prefer fewer
 *  hand-offs, and raise INVOCATION_BUDGET_MS with it. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!verifyInternalSecret(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { jobId?: string };
  let jobId = body.jobId;

  if (!jobId) {
    const resumable = await findResumableJobs(1);
    if (resumable.length === 0) return json({ status: 'idle' });
    jobId = resumable[0].id;
  }

  const result = await runJob({ jobId });

  if (result.status === 'incomplete') {
    const dispatch = await triggerJobRun(jobId);
    if (!dispatch.dispatched) {
      await logger.warn(
        'job.continuation.not_dispatched',
        { reason: dispatch.reason },
        { jobId, persist: true },
      );
    }
    return json({ ...result, continued: dispatch.dispatched });
  }

  return json(result);
}

/** Convenience for manual checks: reports what is waiting, runs nothing. */
export async function GET(request: Request): Promise<Response> {
  if (!verifyInternalSecret(request)) return unauthorized();
  const resumable = await findResumableJobs(10);
  return json({ resumable: resumable.map((job) => ({ id: job.id, slug: job.slug, status: job.status })) });
}
