/**
 * The bridge from "a spec changed in GitHub" to "a render is running".
 *
 * Shared by the webhook and the GitHub Action endpoint so both entry points
 * apply exactly the same rules — most importantly that only `ready_for_audio`
 * spends money.
 */
import { createEpisodeSource, type EpisodeSource } from '../episode/source';
import { syncEpisode } from '../episode/service';
import { logger } from '../log';
import { queueGeneration } from './runner';
import { triggerJobRun } from './dispatch';

export type TriggerOutcome = {
  slug: string;
  result: 'queued' | 'duplicate' | 'already_generated' | 'skipped_draft' | 'rejected' | 'invalid' | 'not_found';
  detail?: string;
  jobId?: string;
};

export type TriggerOptions = {
  slugs: string[];
  triggerSource: string;
  source?: EpisodeSource;
  /** Set false in tests to avoid firing HTTP at ourselves. */
  dispatch?: boolean;
};

/**
 * Sync each named spec and queue the ones asking to be rendered.
 *
 * Every outcome is reported rather than thrown: one bad spec in a push must
 * not stop the other episodes in the same push from rendering.
 */
export async function triggerEpisodes(options: TriggerOptions): Promise<TriggerOutcome[]> {
  const source = options.source ?? createEpisodeSource();
  const outcomes: TriggerOutcome[] = [];

  for (const slug of options.slugs) {
    const loaded = await syncEpisode(slug, source);
    if (!loaded) {
      outcomes.push({ slug, result: 'not_found' });
      continue;
    }
    if (!loaded.ok) {
      const detail = loaded.issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('; ');
      await logger.warn('episode.invalid', { detail }, { slug });
      outcomes.push({ slug, result: 'invalid', detail });
      continue;
    }
    if (loaded.episode.status === 'draft') {
      outcomes.push({ slug, result: 'skipped_draft', detail: 'Draft specs never trigger paid generation' });
      continue;
    }
    if (loaded.episode.status !== 'ready_for_audio') {
      // Already past the gate (published, failed, mid-flight): a spec push is
      // not an instruction to re-render. Regeneration is always explicit.
      outcomes.push({
        slug,
        result: 'skipped_draft',
        detail: `Status is "${loaded.episode.status}"; only "ready_for_audio" triggers generation`,
      });
      continue;
    }

    const queued = await queueGeneration({ slug, triggerSource: options.triggerSource });
    switch (queued.status) {
      case 'queued':
        outcomes.push({ slug, result: 'queued', jobId: queued.job.id });
        if (options.dispatch !== false) await triggerJobRun(queued.job.id);
        break;
      case 'duplicate':
        outcomes.push({ slug, result: 'duplicate', jobId: queued.job.id, detail: queued.reason });
        break;
      case 'already_generated':
        outcomes.push({ slug, result: 'already_generated', detail: queued.reason });
        break;
      default:
        outcomes.push({ slug, result: 'rejected', detail: queued.reason });
        break;
    }
  }

  return outcomes;
}
