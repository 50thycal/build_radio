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
/**
 * Generation is slower than realtime — a two minute chunk can take a minute or
 * more — so one invocation needs room for at least one chunk plus the stitch.
 * INVOCATION_BUDGET_MS must stay below this; the runner also clamps each
 * provider request so it aborts before the platform kills the function.
 */
export const maxDuration = 300;

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
