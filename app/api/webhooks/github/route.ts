/**
 * GitHub push webhook (integration option B).
 *
 * Verifies the signature over the raw body, records the delivery id so a
 * replay is free, then queues whatever became ready_for_audio.
 *
 * The ElevenLabs key is never here: GitHub only ever names episodes, and this
 * deployment decides what that costs.
 */
import { verifyGitHubSignature } from '@/lib/auth';
import { authConfig } from '@/lib/config';
import { json, unauthorized } from '@/lib/http';
import { recordDelivery, setDeliveryResult } from '@/lib/db/store';
import { episodesFromPush, type PushPayload } from '@/lib/github/webhook';
import { triggerEpisodes } from '@/lib/jobs/trigger';
import { logger } from '@/lib/log';
import { githubConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!authConfig.githubWebhookSecret) {
    return json({ error: 'GITHUB_WEBHOOK_SECRET is not configured' }, { status: 503 });
  }

  // The signature covers the exact bytes GitHub sent; never re-serialise.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  if (!(await verifyGitHubSignature(rawBody, signature))) {
    await logger.warn('webhook.rejected', { reason: 'bad signature' }, { persist: false });
    return unauthorized('Invalid signature');
  }

  const event = request.headers.get('x-github-event') ?? 'unknown';
  const deliveryId = request.headers.get('x-github-delivery') ?? `${event}-${Date.now()}`;

  if (event === 'ping') return json({ status: 'pong' });
  if (event !== 'push') return json({ status: 'ignored', event });

  // Recorded before any work starts, so a redelivery mid-run is still a no-op.
  const isFirstDelivery = await recordDelivery(deliveryId, 'github');
  if (!isFirstDelivery) {
    await logger.info('webhook.duplicate', { deliveryId }, { persist: false });
    return json({ status: 'duplicate', deliveryId });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(rawBody) as PushPayload;
  } catch {
    await setDeliveryResult(deliveryId, 'invalid json');
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { branch, changed, removed } = episodesFromPush(payload);
  const expectedBranch = githubConfig.branch || payload.repository?.default_branch || 'main';
  if (branch && branch !== expectedBranch) {
    await setDeliveryResult(deliveryId, `ignored branch ${branch}`);
    return json({ status: 'ignored', reason: `push was to ${branch}, watching ${expectedBranch}` });
  }

  if (changed.length === 0) {
    await setDeliveryResult(deliveryId, 'no episode changes');
    return json({ status: 'no-op', removed });
  }

  const outcomes = await triggerEpisodes({ slugs: changed, triggerSource: 'github-webhook' });
  await setDeliveryResult(deliveryId, outcomes.map((outcome) => `${outcome.slug}:${outcome.result}`).join(', '));
  await logger.info('webhook.handled', { deliveryId, outcomes }, { persist: false });

  return json({ status: 'ok', deliveryId, outcomes, removed });
}
