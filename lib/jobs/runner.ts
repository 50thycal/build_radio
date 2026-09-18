/**
 * Generation pipeline.
 *
 * Shape of a run:
 *   queue -> lease -> generate pending chunks -> stitch -> upload -> publish
 *
 * Properties this module is responsible for:
 *   - a draft is never rendered; only ready_for_audio (or an explicit retry of
 *     an episode already past that gate) can spend money
 *   - one paid render per content version: replayed triggers reuse the job
 *   - chunk audio is persisted as it is produced, so an invocation that runs
 *     out of time resumes instead of re-paying
 *   - every provider request is written to the cost ledger, success or failure
 *   - failure is an explicit state with a preserved reason, never a silent stop
 */
import { chunkAudioKey, episodeAudioKey, createMediaStore, type MediaStore } from '../storage/media-store';
import { writeManifest } from '../episode/manifest';
import { createStitcher, type Stitcher } from '../audio/stitcher';
import { elevenLabsConfig, safetyConfig } from '../config';
import { ElevenLabsClient, ProviderError, withRetries, type DialogueInput } from '../elevenlabs';
import { rawCostForCharacters, roundUsd } from '../cost';
import { logger } from '../log';
import { sha256 } from '../episode/version';
import {
  buildRenderPlan,
  chunkTextHash,
  deriveChapters,
  type RenderPlan,
} from '../episode/service';
import type { EpisodeSpec } from '../episode/schema';
import {
  claimJob,
  extendJobLease,
  finishJob,
  findActiveJob,
  getEpisode,
  getJob,
  leaseJob,
  listChunks,
  listJobs,
  markChunkFailed,
  markChunkGenerated,
  markChunkGenerating,
  publishEpisodeAudio,
  recordAttempt,
  releaseJob,
  resetChunks,
  setEpisodeStatus,
  updateJobProgress,
  upsertChunkPlan,
  type JobKind,
  type JobRecord,
} from '../db/store';

export type QueueResult =
  | { status: 'queued'; job: JobRecord; plan: RenderPlan }
  | { status: 'duplicate'; job: JobRecord; reason: string }
  | { status: 'already_generated'; reason: string }
  | { status: 'rejected'; reason: string };

export type QueueOptions = {
  slug: string;
  kind?: JobKind;
  triggerSource?: string;
};

/**
 * Queue a render, applying every gate that protects the budget.
 *
 * Order matters: the cheap refusals (wrong status, missing voice, over budget)
 * all happen before a job row exists, so a rejected episode leaves no state to
 * clean up.
 */
export async function queueGeneration(options: QueueOptions): Promise<QueueResult> {
  const kind: JobKind = options.kind ?? 'generate';
  const triggerSource = options.triggerSource ?? 'manual';
  const record = await getEpisode(options.slug);
  if (!record) return { status: 'rejected', reason: `Unknown episode "${options.slug}"` };

  if (record.status === 'draft') {
    return {
      status: 'rejected',
      reason: 'Episode is a draft. Set status to "ready_for_audio" in GitHub to allow paid generation.',
    };
  }

  const spec = JSON.parse(record.specJson) as EpisodeSpec;
  const plan = buildRenderPlan(spec);

  if (plan.missingVoices.length > 0) {
    return {
      status: 'rejected',
      reason: `No voice id for speaker(s): ${plan.missingVoices.join(', ')}. Set voice_id in the spec or ELEVENLABS_*_VOICE_ID.`,
    };
  }
  if (!plan.limits.ok) return { status: 'rejected', reason: plan.limits.reason };
  if (plan.chunks.length > safetyConfig.maxRequestsPerJob) {
    return {
      status: 'rejected',
      reason: `Episode needs ${plan.chunks.length} requests, above MAX_REQUESTS_PER_JOB (${safetyConfig.maxRequestsPerJob}).`,
    };
  }

  // Already rendered at this exact content version: nothing to buy.
  if (
    kind === 'generate' &&
    record.status === 'published' &&
    record.audioUrl &&
    record.contentVersion === plan.contentVersion
  ) {
    return {
      status: 'already_generated',
      reason: 'This exact version is already published. Use "Regenerate" to pay for a new render.',
    };
  }

  // A run already in flight absorbs the trigger instead of duplicating it.
  const active = await findActiveJob(options.slug);
  if (active && active.contentVersion === plan.contentVersion) {
    return { status: 'duplicate', job: active, reason: `Job ${active.id} is already ${active.status}` };
  }

  await upsertChunkPlan(
    options.slug,
    plan.contentVersion,
    plan.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      sequence: chunk.sequence,
      characters: chunk.characters,
      textHash: chunkTextHash(chunk),
      speakers: chunk.speakers.join(','),
      estimatedCostUsd: roundUsd(rawCostForCharacters(chunk.characters)),
    })),
  );

  if (kind === 'regenerate_all') await resetChunks(options.slug, plan.contentVersion);
  if (kind === 'regenerate_failed') await resetChunks(options.slug, plan.contentVersion, { onlyFailed: true });

  const idempotencyKey = await buildIdempotencyKey(options.slug, plan.contentVersion, kind);
  const claim = await claimJob({
    slug: options.slug,
    contentVersion: plan.contentVersion,
    kind,
    idempotencyKey,
    triggerSource,
    chunkCount: plan.chunks.length,
    estimatedCostUsd: plan.estimate.estimatedCostUsd,
    characters: plan.estimate.characters,
  });

  if (!claim.created) {
    return { status: 'duplicate', job: claim.job, reason: `Reusing job ${claim.job.id} for the same request` };
  }

  await setEpisodeStatus(options.slug, 'queued');
  await logger.info(
    'job.queued',
    {
      kind,
      triggerSource,
      chunkCount: plan.chunks.length,
      characters: plan.estimate.characters,
      estimatedCostUsd: plan.estimate.estimatedCostUsd,
      contentVersion: plan.contentVersion,
    },
    { jobId: claim.job.id, slug: options.slug },
  );

  return { status: 'queued', job: claim.job, plan };
}

/**
 * Idempotency key.
 *
 * `generate` collapses to one key per content version — replay it as often as
 * you like, it costs once. Regenerations are deliberate, so their key includes
 * how many jobs already exist for that version: two clicks in the same moment
 * collapse, a decision to regenerate tomorrow does not.
 */
async function buildIdempotencyKey(slug: string, contentVersion: string, kind: JobKind): Promise<string> {
  if (kind === 'generate') return `${slug}:${contentVersion}:generate`;
  const jobs = await listJobs({ slug, limit: 200 });
  const priorForVersion = jobs.filter((job) => job.contentVersion === contentVersion && job.status !== 'queued').length;
  return `${slug}:${contentVersion}:${kind}:${priorForVersion}`;
}

export type RunOptions = {
  jobId: string;
  /** Wall-clock budget for this invocation; the job resumes after it expires. */
  budgetMs?: number;
  now?: () => number;
  client?: ElevenLabsClient;
  mediaStore?: MediaStore;
  stitcher?: Stitcher;
  sleep?: (ms: number) => Promise<void>;
};

export type RunResult =
  | { status: 'completed'; jobId: string; durationSeconds: number; audioUrl: string; actualCostUsd: number }
  | { status: 'incomplete'; jobId: string; chunksRemaining: number; reason: string }
  | { status: 'failed'; jobId: string; reason: string }
  | { status: 'skipped'; jobId: string; reason: string };

/**
 * Execute (or continue) a job.
 *
 * Returning `incomplete` is normal, not an error: the caller re-invokes the
 * endpoint and the next invocation picks up exactly where this one stopped.
 */
export async function runJob(options: RunOptions): Promise<RunResult> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? safetyConfig.invocationBudgetMs;
  const deadline = now() + budgetMs;

  const leased = await leaseJob(options.jobId, safetyConfig.jobLeaseMs);
  if (!leased) {
    const current = await getJob(options.jobId);
    return {
      status: 'skipped',
      jobId: options.jobId,
      reason: current ? `Job is ${current.status} and leased elsewhere` : 'Job not found',
    };
  }

  const record = await getEpisode(leased.slug);
  if (!record) {
    await finishJob(leased.id, 'failed', { error: 'Episode record disappeared', errorKind: 'missing_episode' });
    return { status: 'failed', jobId: leased.id, reason: 'Episode record disappeared' };
  }

  // Render from the spec captured at queue time, not from whatever GitHub says
  // now: a mid-flight edit must not splice two versions into one file.
  const spec = JSON.parse(record.specJson) as EpisodeSpec;
  const plan = buildRenderPlan(spec);
  if (plan.contentVersion !== leased.contentVersion) {
    await finishJob(leased.id, 'cancelled', {
      error: `Episode changed while queued (${leased.contentVersion} -> ${plan.contentVersion})`,
      errorKind: 'content_changed',
    });
    await setEpisodeStatus(leased.slug, 'ready_for_audio');
    return { status: 'failed', jobId: leased.id, reason: 'Episode content changed while the job was queued' };
  }

  const mediaStore = options.mediaStore ?? createMediaStore();
  const stitcher = options.stitcher ?? createStitcher();
  const client =
    options.client ??
    new ElevenLabsClient({
      apiKey: elevenLabsConfig.apiKey,
      modelId: elevenLabsConfig.model,
      outputFormat: elevenLabsConfig.outputFormat,
    });

  await setEpisodeStatus(leased.slug, 'generating');

  let requestsUsed = leased.requestsUsed;
  let actualCostUsd = leased.actualCostUsd;
  /** How long a chunk takes, learned from this run. Generation is slower than
   *  realtime, so this starts pessimistic and adapts to what we measure. */
  let expectedChunkMs = safetyConfig.chunkTimeBudgetMs;
  let chunksThisInvocation = 0;

  for (const chunk of plan.chunks) {
    const stored = (await listChunks(leased.slug, plan.contentVersion)).find(
      (candidate) => candidate.chunkId === chunk.chunkId,
    );
    if (stored?.status === 'generated' && stored.audioKey) continue; // already paid for

    if (requestsUsed >= safetyConfig.maxRequestsPerJob) {
      const reason = `Request cap reached (${safetyConfig.maxRequestsPerJob}); refusing to spend further`;
      await failJob(leased, reason, 'request_cap');
      return { status: 'failed', jobId: leased.id, reason };
    }

    // Reserve room for the stitch and upload that follow the final chunk.
    const isFinalChunk = chunk.sequence === plan.chunks.length - 1;
    const timeLeft = deadline - now();
    const timeNeeded = expectedChunkMs + (isFinalChunk ? safetyConfig.finaliseReserveMs : 0);

    // Yielding before the first chunk would make no progress at all and the
    // job would ping-pong between invocations forever, so the first chunk
    // always runs — with its provider timeout clamped to the time available.
    if (chunksThisInvocation > 0 && timeLeft < timeNeeded) {
      const remaining = plan.chunks.length - (await countGenerated(leased.slug, plan.contentVersion));
      await releaseJob(leased.id);
      await logger.info(
        'job.yield',
        { chunksRemaining: remaining, timeLeftMs: timeLeft, expectedChunkMs },
        { jobId: leased.id, slug: leased.slug },
      );
      return {
        status: 'incomplete',
        jobId: leased.id,
        chunksRemaining: remaining,
        reason: 'Not enough time left in this invocation for another chunk; job resumes on the next run',
      };
    }

    const inputs: DialogueInput[] = chunk.segments.map((segment) => ({
      speaker: segment.speaker,
      voiceId: plan.voices[segment.speaker],
      text: segment.text,
    }));

    await markChunkGenerating(leased.slug, plan.contentVersion, chunk.chunkId);
    const attemptNumber = (stored?.attempts ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const estimatedCost = roundUsd(rawCostForCharacters(chunk.characters));

    // Abort ourselves before the platform kills the function: a killed
    // invocation still bills the provider but stores nothing.
    const providerTimeoutMs = Math.max(
      5_000,
      deadline - now() - safetyConfig.providerAbortMarginMs,
    );
    const chunkStartedMs = now();

    try {
      const generated = await withRetries(() => client.generateDialogue(inputs, { timeoutMs: providerTimeoutMs }), {
        maxAttempts: Math.max(1, safetyConfig.maxAttemptsPerChunk - (stored?.attempts ?? 0)),
        baseDelayMs: 1000,
        maxDelayMs: 15_000,
        sleep: options.sleep,
        onRetry: ({ attempt, delayMs, error }) => {
          requestsUsed += 1;
          void logger.warn(
            'chunk.retry',
            { chunkId: chunk.chunkId, attempt, delayMs, kind: error.kind, status: error.status },
            { jobId: leased.id, slug: leased.slug },
          );
        },
      });

      requestsUsed += 1;
      const key = chunkAudioKey(leased.slug, plan.contentVersion, chunk.chunkId);
      // Record where the object actually landed, not where we asked to put it.
      // Vercel Blob appends a random suffix to the pathname, so the requested
      // key does not exist afterwards and reading by it fails at stitch time —
      // after every chunk has been paid for.
      const storedChunk = await mediaStore.put(key, generated.audio, 'audio/mpeg');

      // Our own count and the provider's disagree, and we do not control the
      // meaning of their header. Spending is bounded by the pre-flight estimate
      // either way, so for the record of what was spent take the larger: a
      // system built to avoid surprise bills should never round down.
      const billedCharacters = Math.max(generated.characters, generated.providerCharacterCost ?? 0);
      const chunkCost = roundUsd(rawCostForCharacters(billedCharacters));
      actualCostUsd = roundUsd(actualCostUsd + chunkCost);

      await markChunkGenerated(leased.slug, plan.contentVersion, chunk.chunkId, {
        audioKey: storedChunk.key,
        durationSeconds: 0,
        actualCostUsd: chunkCost,
        providerRequestId: generated.requestId,
      });
      await recordAttempt({
        jobId: leased.id,
        slug: leased.slug,
        contentVersion: plan.contentVersion,
        chunkId: chunk.chunkId,
        attempt: attemptNumber,
        status: 'succeeded',
        httpStatus: generated.httpStatus,
        providerRequestId: generated.requestId,
        characters: generated.characters,
        billable: true,
        estimatedCostUsd: chunkCost,
        providerCharacterCost: generated.providerCharacterCost,
        latencyMs: generated.latencyMs,
        startedAt,
      });

      // A later chunk is never assumed faster than the slowest one so far.
      expectedChunkMs = Math.max(expectedChunkMs, now() - chunkStartedMs);
      chunksThisInvocation += 1;

      const completed = await countGenerated(leased.slug, plan.contentVersion);
      await updateJobProgress(leased.id, { chunksCompleted: completed, requestsUsed, actualCostUsd });
      await extendJobLease(leased.id, safetyConfig.jobLeaseMs);
      await logger.info(
        'chunk.generated',
        {
          chunkId: chunk.chunkId,
          characters: generated.characters,
          // Logged next to our own count so a divergence is visible rather
          // than silently absorbed into the cost figure.
          providerCharacterCost: generated.providerCharacterCost,
          audioKey: storedChunk.key,
          bytes: generated.audio.byteLength,
          latencyMs: generated.latencyMs,
          chunkWallClockMs: now() - chunkStartedMs,
          providerRequestId: generated.requestId,
          costUsd: chunkCost,
        },
        { jobId: leased.id, slug: leased.slug },
      );
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError((error as Error).message, { kind: 'unknown', retryable: false });
      requestsUsed += 1;
      await recordAttempt({
        jobId: leased.id,
        slug: leased.slug,
        contentVersion: plan.contentVersion,
        chunkId: chunk.chunkId,
        attempt: attemptNumber,
        status: 'failed',
        httpStatus: providerError.status,
        providerRequestId: providerError.requestId,
        errorKind: providerError.kind,
        errorMessage: providerError.message,
        characters: chunk.characters,
        // A failed request may still be metered by the provider; flag it so the
        // ledger can be reconciled against the real invoice.
        billable: providerError.kind === 'server' || providerError.kind === 'empty_response',
        estimatedCostUsd: 0,
        startedAt,
      });
      await markChunkFailed(leased.slug, plan.contentVersion, chunk.chunkId, providerError.message);
      await updateJobProgress(leased.id, { requestsUsed, actualCostUsd });
      const reason = `Chunk ${chunk.chunkId} failed after ${attemptNumber} attempt(s): ${providerError.message}`;
      await failJob(leased, reason, providerError.kind);
      return { status: 'failed', jobId: leased.id, reason };
    }
  }

  return finalise(leased, plan, mediaStore, stitcher, actualCostUsd, requestsUsed, record.contentVersion);
}

async function countGenerated(slug: string, contentVersion: string): Promise<number> {
  const chunks = await listChunks(slug, contentVersion);
  return chunks.filter((chunk) => chunk.status === 'generated').length;
}

async function failJob(job: JobRecord, reason: string, kind: string): Promise<void> {
  await finishJob(job.id, 'failed', { error: reason, errorKind: kind });
  await setEpisodeStatus(job.slug, 'failed', { error: reason });
  await logger.error('job.failed', { reason, kind }, { jobId: job.id, slug: job.slug });
}

/** Stitch, upload, publish. Runs only when every chunk has audio. */
async function finalise(
  job: JobRecord,
  plan: RenderPlan,
  mediaStore: MediaStore,
  stitcher: Stitcher,
  actualCostUsd: number,
  requestsUsed: number,
  previousContentVersion: string,
): Promise<RunResult> {
  await setEpisodeStatus(job.slug, 'stitching');
  const chunkRecords = await listChunks(job.slug, plan.contentVersion);
  const missing = plan.chunks.filter((chunk) => {
    const record = chunkRecords.find((candidate) => candidate.chunkId === chunk.chunkId);
    return !record || record.status !== 'generated' || !record.audioKey;
  });
  if (missing.length > 0) {
    const reason = `Cannot stitch: ${missing.length} chunk(s) have no audio (${missing.map((c) => c.chunkId).join(', ')})`;
    await failJob(job, reason, 'incomplete_chunks');
    return { status: 'failed', jobId: job.id, reason };
  }

  let stitched;
  try {
    const parts = await Promise.all(
      plan.chunks.map(async (chunk) => {
        const record = chunkRecords.find((candidate) => candidate.chunkId === chunk.chunkId)!;
        return { chunkId: chunk.chunkId, sequence: chunk.sequence, data: await mediaStore.get(record.audioKey!) };
      }),
    );
    stitched = await stitcher.stitch(parts);
  } catch (error) {
    const reason = `Stitching failed: ${(error as Error).message}`;
    await failJob(job, reason, 'stitch_failed');
    return { status: 'failed', jobId: job.id, reason };
  }

  await setEpisodeStatus(job.slug, 'uploading');
  const key = episodeAudioKey(job.slug, plan.contentVersion);
  let stored;
  try {
    stored = await mediaStore.put(key, stitched.data, stitched.contentType);
  } catch (error) {
    const reason = `Upload failed: ${(error as Error).message}`;
    await failJob(job, reason, 'upload_failed');
    return { status: 'failed', jobId: job.id, reason };
  }

  const chapters = deriveChapters(plan.episode, plan.chunks, stitched.partOffsets);
  const isRerender = previousContentVersion === plan.contentVersion && job.kind !== 'generate';
  const checksum = sha256(stitched.data);

  await publishEpisodeAudio({
    slug: job.slug,
    audioKey: stored.key,
    audioUrl: stored.url,
    durationSeconds: stitched.durationSeconds,
    checksum,
    actualCharacters: plan.estimate.characters,
    actualCostUsd,
    regenerationCostUsd: isRerender ? actualCostUsd : 0,
    chapters,
  });

  // Leave storage self-describing: this is what lets a lost database be
  // rebuilt instead of the episode becoming unreachable audio.
  await writeManifest(
    {
      manifestVersion: 1,
      slug: job.slug,
      contentVersion: plan.contentVersion,
      audioKey: stored.key,
      audioUrl: stored.url,
      durationSeconds: stitched.durationSeconds,
      checksum,
      actualCharacters: plan.estimate.characters,
      actualCostUsd,
      chapters,
      publishedAt: new Date().toISOString(),
    },
    mediaStore,
  );
  await updateJobProgress(job.id, {
    chunksCompleted: plan.chunks.length,
    requestsUsed,
    actualCostUsd,
  });
  await finishJob(job.id, 'succeeded');
  await logger.info(
    'job.succeeded',
    {
      durationSeconds: Math.round(stitched.durationSeconds),
      bytes: stitched.data.byteLength,
      frameCount: stitched.frameCount,
      chunkCount: plan.chunks.length,
      requestsUsed,
      actualCostUsd,
      estimatedCostUsd: plan.estimate.estimatedCostUsd,
      audioKey: stored.key,
    },
    { jobId: job.id, slug: job.slug },
  );

  return {
    status: 'completed',
    jobId: job.id,
    durationSeconds: stitched.durationSeconds,
    audioUrl: stored.url,
    actualCostUsd,
  };
}
