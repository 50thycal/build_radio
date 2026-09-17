/**
 * GitHub Action entry point (integration option A, the default).
 *
 * The workflow watches episodes/** and posts the slugs it saw change. It
 * authenticates with INTERNAL_GENERATION_SECRET, which is the only secret
 * GitHub needs to hold — provider credentials stay in this deployment.
 */
import { verifyInternalSecret } from '@/lib/auth';
import { badRequest, json, unauthorized } from '@/lib/http';
import { recordDelivery, setDeliveryResult } from '@/lib/db/store';
import { triggerEpisodes } from '@/lib/jobs/trigger';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!verifyInternalSecret(request)) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { slugs?: unknown; deliveryId?: unknown };
  if (!Array.isArray(body.slugs) || body.slugs.some((slug) => typeof slug !== 'string')) {
    return badRequest('slugs must be an array of strings');
  }
  const slugs = (body.slugs as string[]).map((slug) => slug.trim()).filter(Boolean);
  if (slugs.length === 0) return json({ status: 'no-op', outcomes: [] });

  // The workflow sends the commit sha as the delivery id, so a re-run of the
  // same workflow does not start a second paid render.
  const deliveryId = typeof body.deliveryId === 'string' && body.deliveryId ? body.deliveryId : null;
  if (deliveryId) {
    const isFirst = await recordDelivery(`action:${deliveryId}`, 'github-action');
    if (!isFirst) return json({ status: 'duplicate', deliveryId });
  }

  const outcomes = await triggerEpisodes({ slugs, triggerSource: 'github-action' });
  if (deliveryId) {
    await setDeliveryResult(`action:${deliveryId}`, outcomes.map((o) => `${o.slug}:${o.result}`).join(', '));
  }
  await logger.info('action.handled', { deliveryId, outcomes }, { persist: false });
  return json({ status: 'ok', outcomes });
}
