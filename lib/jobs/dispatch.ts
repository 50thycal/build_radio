/**
 * Job continuation.
 *
 * A long episode does not fit in one serverless invocation, so the runner
 * yields and the next invocation resumes it. That handoff is a call from one
 * serverless function to another, and it has to survive the caller returning.
 *
 * The naive version — start a fetch, do not await it, return — does not. Once
 * a handler returns, the platform is free to freeze or reclaim the instance,
 * and an outbound request that has not completed goes with it. Worse, ignoring
 * the response also discards a 401 or a 404, so a poke that was delivered and
 * rejected is indistinguishable from one that was never sent.
 *
 * So we await the acknowledgement. /api/jobs/run is built to answer in
 * milliseconds and do the actual render after responding, which keeps this
 * cheap: we are waiting for "I have it", not for the episode.
 */
import { appBaseUrl, authConfig, safetyConfig } from '../config';
import { logger } from '../log';

export type DispatchResult = { dispatched: boolean; reason?: string };

export async function triggerJobRun(jobId: string): Promise<DispatchResult> {
  if (!authConfig.internalSecret) {
    return { dispatched: false, reason: 'INTERNAL_GENERATION_SECRET is not configured' };
  }

  const url = `${appBaseUrl()}/api/jobs/run`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safetyConfig.dispatchAckTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authConfig.internalSecret}`,
      },
      body: JSON.stringify({ jobId }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const reason = `worker answered ${response.status}`;
      await logger.warn('job.dispatch.rejected', { status: response.status, url }, { jobId });
      return { dispatched: false, reason };
    }
    return { dispatched: true };
  } catch (error) {
    const reason =
      (error as Error).name === 'AbortError'
        ? `worker did not acknowledge within ${safetyConfig.dispatchAckTimeoutMs}ms`
        : String(error);
    // Persisted, not just logged: a job that never started is exactly the
    // failure you cannot diagnose without a record of the attempt.
    await logger.warn('job.dispatch.failed', { detail: reason, url }, { jobId });
    return { dispatched: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
