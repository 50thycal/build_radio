/**
 * Safety net.
 *
 * Runs on a schedule to (a) refresh the cached specs and (b) resume any job
 * whose continuation poke was lost or whose worker died mid-render. Without
 * this, a dropped HTTP call would leave an episode stuck in "generating".
 */
import { verifyInternalSecret } from '@/lib/auth';
import { json, unauthorized } from '@/lib/http';
import { findResumableJobs } from '@/lib/db/store';
import { syncEpisodes } from '@/lib/episode/service';
import { triggerJobRun } from '@/lib/jobs/dispatch';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorised(request: Request): boolean {
  if (verifyInternalSecret(request)) return true;
  // Vercel Cron sends this header with the project's CRON_SECRET.
  const header = request.headers.get('authorization') ?? '';
  const cronSecret = process.env.CRON_SECRET ?? '';
  return cronSecret !== '' && header === `Bearer ${cronSecret}`;
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorised(request)) return unauthorized();

  const sync = await syncEpisodes().catch((error) => ({ error: String(error) }));
  const resumable = await findResumableJobs(3);
  for (const job of resumable) await triggerJobRun(job.id);
  if (resumable.length > 0) {
    await logger.info('cron.resumed', { jobIds: resumable.map((job) => job.id) }, { persist: false });
  }

  return json({ status: 'ok', sync, resumed: resumable.map((job) => ({ id: job.id, slug: job.slug })) });
}

export const GET = handle;
export const POST = handle;
