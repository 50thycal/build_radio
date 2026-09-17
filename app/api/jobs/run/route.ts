/**
 * The worker endpoint.
 *
 * Runs one job for as long as this invocation's time budget allows. If the job
 * is not finished, it pokes itself again — that chain is how a 20 minute
 * episode renders inside a serverless function with a hard timeout.
 *
 * It acknowledges before it works. The caller is another serverless invocation
 * that must not be held open for the length of a render, and a caller that
 * cannot afford to wait is a caller that does not wait — which is how a poke
 * gets dropped and a job sits queued forever. Answering 202 immediately and
 * rendering in `after()` lets the caller confirm delivery in milliseconds while
 * this invocation keeps working for its full maxDuration.
 *
 * Only the internal secret can call this: it is the endpoint that spends money.
 */
import { after } from 'next/server';
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
 * provider request so it aborts before the platform kills the function. Work
 * scheduled with `after()` runs inside this same budget.
 */
export const maxDuration = 300;

/** Render the job, then hand the remainder to a fresh invocation if needed. */
async function work(jobId: string): Promise<void> {
  try {
    const result = await runJob({ jobId });
    if (result.status !== 'incomplete') return;

    const dispatch = await triggerJobRun(jobId);
    if (!dispatch.dispatched) {
      await logger.warn('job.continuation.not_dispatched', { reason: dispatch.reason }, { jobId });
    }
  } catch (error) {
    // The lease expires on its own, so the sweeper can retry; what must not
    // happen is the failure vanishing with the invocation.
    await logger.error('job.run.crashed', { detail: String(error) }, { jobId });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!verifyInternalSecret(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { jobId?: string };
  let jobId = body.jobId;

  if (!jobId) {
    const resumable = await findResumableJobs(1);
    if (resumable.length === 0) return json({ status: 'idle' });
    jobId = resumable[0].id;
  }

  const accepted = jobId;
  after(() => work(accepted));
  return json({ status: 'accepted', jobId: accepted }, { status: 202 });
}

/** Convenience for manual checks: reports what is waiting, runs nothing. */
export async function GET(request: Request): Promise<Response> {
  if (!verifyInternalSecret(request)) return unauthorized();
  const resumable = await findResumableJobs(10);
  return json({ resumable: resumable.map((job) => ({ id: job.id, slug: job.slug, status: job.status })) });
}
