/**
 * Job continuation.
 *
 * A long episode does not fit in one serverless invocation, so the runner
 * yields and the next invocation resumes it. Rather than block the caller, we
 * poke our own endpoint and return immediately; the cron sweeper is the safety
 * net if that poke is ever lost.
 */
import { appBaseUrl, authConfig } from '../config';
import { logger } from '../log';

export type DispatchResult = { dispatched: boolean; reason?: string };

export async function triggerJobRun(jobId: string): Promise<DispatchResult> {
  if (!authConfig.internalSecret) {
    return { dispatched: false, reason: 'INTERNAL_GENERATION_SECRET is not configured' };
  }

  const url = `${appBaseUrl()}/api/jobs/run`;
  try {
    // Fire and forget: we deliberately do not await the body. The job's own
    // state in the database is the source of truth for what happened.
    const request = fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authConfig.internalSecret}`,
      },
      body: JSON.stringify({ jobId }),
      keepalive: true,
    });
    request.catch((error) => {
      void logger.warn('job.dispatch.failed', { jobId, detail: String(error) }, { jobId, persist: false });
    });
    return { dispatched: true };
  } catch (error) {
    return { dispatched: false, reason: (error as Error).message };
  }
}
