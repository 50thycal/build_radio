/**
 * Typed data access for operational state.
 *
 * Everything the pipeline needs to resume, bill and debug lives behind these
 * functions. No SQL escapes this module.
 */
import { randomUUID } from 'node:crypto';
import type { Row } from '@libsql/client';
import { getDb } from './client';
import type { EpisodeStatus } from '../episode/schema';

const now = () => new Date().toISOString();

export type JobKind = 'generate' | 'regenerate_all' | 'regenerate_failed';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ChunkStatus = 'pending' | 'generating' | 'generated' | 'failed';

export type EpisodeRecord = {
  slug: string;
  title: string;
  project: string;
  status: EpisodeStatus;
  contentVersion: string;
  specJson: string;
  specSource: string;
  estimatedCharacters: number;
  estimatedCostUsd: number;
  estimatedRuntimeSeconds: number;
  estimatedChunkCount: number;
  actualCharacters: number;
  actualCostUsd: number;
  regenerationCostUsd: number;
  audioKey: string | null;
  audioUrl: string | null;
  audioDurationSeconds: number | null;
  audioChecksum: string | null;
  /** Chapter start times derived at render time, when the spec declared any. */
  chapters: { title: string; startSeconds: number }[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type JobRecord = {
  id: string;
  slug: string;
  contentVersion: string;
  kind: JobKind;
  status: JobStatus;
  idempotencyKey: string;
  triggerSource: string;
  chunkCount: number;
  chunksCompleted: number;
  requestsUsed: number;
  attempts: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  characters: number;
  error: string | null;
  errorKind: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ChunkRecord = {
  slug: string;
  contentVersion: string;
  chunkId: string;
  sequence: number;
  characters: number;
  textHash: string;
  speakers: string;
  status: ChunkStatus;
  attempts: number;
  audioKey: string | null;
  durationSeconds: number | null;
  estimatedCostUsd: number;
  actualCostUsd: number;
  providerRequestId: string | null;
  error: string | null;
};

export type JobEvent = {
  id: string;
  jobId: string | null;
  slug: string | null;
  level: string;
  message: string;
  data: unknown;
  createdAt: string;
};

const asString = (value: unknown): string => (value == null ? '' : String(value));
const asNumber = (value: unknown): number => (value == null ? 0 : Number(value));
const asNullableString = (value: unknown): string | null => (value == null ? null : String(value));
const asNullableNumber = (value: unknown): number | null => (value == null ? null : Number(value));

function toEpisode(row: Row): EpisodeRecord {
  return {
    slug: asString(row.slug),
    title: asString(row.title),
    project: asString(row.project),
    status: asString(row.status) as EpisodeStatus,
    contentVersion: asString(row.content_version),
    specJson: asString(row.spec_json),
    specSource: asString(row.spec_source),
    estimatedCharacters: asNumber(row.estimated_characters),
    estimatedCostUsd: asNumber(row.estimated_cost_usd),
    estimatedRuntimeSeconds: asNumber(row.estimated_runtime_sec),
    estimatedChunkCount: asNumber(row.estimated_chunk_count),
    actualCharacters: asNumber(row.actual_characters),
    actualCostUsd: asNumber(row.actual_cost_usd),
    regenerationCostUsd: asNumber(row.regeneration_cost_usd),
    audioKey: asNullableString(row.audio_key),
    audioUrl: asNullableString(row.audio_url),
    audioDurationSeconds: asNullableNumber(row.audio_duration_seconds),
    audioChecksum: asNullableString(row.audio_checksum),
    chapters: row.chapters_json ? (JSON.parse(asString(row.chapters_json)) as { title: string; startSeconds: number }[]) : [],
    error: asNullableString(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    publishedAt: asNullableString(row.published_at),
  };
}

function toJob(row: Row): JobRecord {
  return {
    id: asString(row.id),
    slug: asString(row.slug),
    contentVersion: asString(row.content_version),
    kind: asString(row.kind) as JobKind,
    status: asString(row.status) as JobStatus,
    idempotencyKey: asString(row.idempotency_key),
    triggerSource: asString(row.trigger_source),
    chunkCount: asNumber(row.chunk_count),
    chunksCompleted: asNumber(row.chunks_completed),
    requestsUsed: asNumber(row.requests_used),
    attempts: asNumber(row.attempts),
    estimatedCostUsd: asNumber(row.estimated_cost_usd),
    actualCostUsd: asNumber(row.actual_cost_usd),
    characters: asNumber(row.characters),
    error: asNullableString(row.error),
    errorKind: asNullableString(row.error_kind),
    leaseExpiresAt: asNullableString(row.lease_expires_at),
    createdAt: asString(row.created_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
  };
}

function toChunk(row: Row): ChunkRecord {
  return {
    slug: asString(row.slug),
    contentVersion: asString(row.content_version),
    chunkId: asString(row.chunk_id),
    sequence: asNumber(row.sequence),
    characters: asNumber(row.characters),
    textHash: asString(row.text_hash),
    speakers: asString(row.speakers),
    status: asString(row.status) as ChunkStatus,
    attempts: asNumber(row.attempts),
    audioKey: asNullableString(row.audio_key),
    durationSeconds: asNullableNumber(row.duration_seconds),
    estimatedCostUsd: asNumber(row.estimated_cost_usd),
    actualCostUsd: asNumber(row.actual_cost_usd),
    providerRequestId: asNullableString(row.provider_request_id),
    error: asNullableString(row.error),
  };
}

/* ------------------------------------------------------------------ episodes */

export type UpsertEpisodeInput = {
  slug: string;
  title: string;
  project: string;
  status: EpisodeStatus;
  contentVersion: string;
  specJson: string;
  specSource: string;
  estimatedCharacters: number;
  estimatedCostUsd: number;
  estimatedRuntimeSeconds: number;
  estimatedChunkCount: number;
};

/**
 * Insert or refresh the cached spec + estimate for an episode.
 *
 * Runtime columns (actual cost, audio, published_at) are deliberately *not*
 * touched here: the authored spec never overwrites what the renderer learned.
 */
export async function upsertEpisode(input: UpsertEpisodeInput): Promise<void> {
  const db = await getDb();
  const timestamp = now();
  await db.execute({
    sql: `INSERT INTO episodes (
            slug, title, project, status, content_version, spec_json, spec_source,
            estimated_characters, estimated_cost_usd, estimated_runtime_sec, estimated_chunk_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            title = excluded.title,
            project = excluded.project,
            -- The authored file advances the lifecycle (draft -> ready_for_audio)
            -- but must never overwrite what the renderer learned about this
            -- same content: a re-sync after a successful render keeps
            -- 'published', and after a failure keeps 'failed'. Returning a spec
            -- to 'draft' is an explicit retraction and is always honoured.
            status = CASE
              WHEN excluded.status = 'draft' THEN 'draft'
              WHEN episodes.content_version = excluded.content_version
                   AND episodes.status IN
                       ('queued','generating','stitching','uploading','published','failed')
                THEN episodes.status
              ELSE excluded.status
            END,
            content_version = excluded.content_version,
            spec_json = excluded.spec_json,
            spec_source = excluded.spec_source,
            estimated_characters = excluded.estimated_characters,
            estimated_cost_usd = excluded.estimated_cost_usd,
            estimated_runtime_sec = excluded.estimated_runtime_sec,
            estimated_chunk_count = excluded.estimated_chunk_count,
            updated_at = excluded.updated_at`,
    args: [
      input.slug,
      input.title,
      input.project,
      input.status,
      input.contentVersion,
      input.specJson,
      input.specSource,
      input.estimatedCharacters,
      input.estimatedCostUsd,
      input.estimatedRuntimeSeconds,
      input.estimatedChunkCount,
      timestamp,
      timestamp,
    ],
  });
}

export async function getEpisode(slug: string): Promise<EpisodeRecord | null> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM episodes WHERE slug = ?', args: [slug] });
  return result.rows[0] ? toEpisode(result.rows[0]) : null;
}

export async function listEpisodes(): Promise<EpisodeRecord[]> {
  const db = await getDb();
  const result = await db.execute('SELECT * FROM episodes ORDER BY COALESCE(published_at, created_at) DESC');
  return result.rows.map(toEpisode);
}

export async function setEpisodeStatus(
  slug: string,
  status: EpisodeStatus,
  options: { error?: string | null } = {},
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE episodes SET status = ?, error = ?, updated_at = ? WHERE slug = ?',
    args: [status, options.error ?? null, now(), slug],
  });
}

export type PublishAudioInput = {
  slug: string;
  audioKey: string;
  audioUrl: string;
  durationSeconds: number;
  checksum: string;
  actualCharacters: number;
  actualCostUsd: number;
  /** Cost of this render, added to the lifetime regeneration total. */
  regenerationCostUsd?: number;
  chapters?: { title: string; startSeconds: number }[];
};

export async function publishEpisodeAudio(input: PublishAudioInput): Promise<void> {
  const db = await getDb();
  const timestamp = now();
  await db.execute({
    sql: `UPDATE episodes SET
            status = 'published',
            audio_key = ?, audio_url = ?, audio_duration_seconds = ?, audio_checksum = ?, chapters_json = ?,
            actual_characters = ?, actual_cost_usd = ?,
            regeneration_cost_usd = regeneration_cost_usd + ?,
            error = NULL, updated_at = ?, published_at = COALESCE(published_at, ?)
          WHERE slug = ?`,
    args: [
      input.audioKey,
      input.audioUrl,
      input.durationSeconds,
      input.checksum,
      JSON.stringify(input.chapters ?? []),
      input.actualCharacters,
      input.actualCostUsd,
      input.regenerationCostUsd ?? 0,
      timestamp,
      timestamp,
      input.slug,
    ],
  });
}

export async function clearEpisodeAudio(slug: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE episodes SET audio_key = NULL, audio_url = NULL, audio_duration_seconds = NULL,
            audio_checksum = NULL, status = 'ready_for_audio', published_at = NULL, updated_at = ?
          WHERE slug = ?`,
    args: [now(), slug],
  });
}

/* ---------------------------------------------------------------------- jobs */

export type ClaimJobResult =
  | { created: true; job: JobRecord }
  | { created: false; job: JobRecord; reason: 'duplicate' };

/**
 * Create a job, or return the existing job for the same idempotency key.
 *
 * This is the single most important spend guard in the system: the unique
 * index on idempotency_key means a replayed webhook, a double-clicked button
 * and a retried GitHub Action all converge on one paid render.
 */
export async function claimJob(input: {
  slug: string;
  contentVersion: string;
  kind: JobKind;
  idempotencyKey: string;
  triggerSource: string;
  chunkCount: number;
  estimatedCostUsd: number;
  characters: number;
}): Promise<ClaimJobResult> {
  const db = await getDb();
  const existing = await db.execute({
    sql: 'SELECT * FROM jobs WHERE idempotency_key = ?',
    args: [input.idempotencyKey],
  });
  if (existing.rows[0]) {
    return { created: false, job: toJob(existing.rows[0]), reason: 'duplicate' };
  }

  const id = randomUUID();
  const timestamp = now();

  await db.execute({
    sql: `INSERT INTO jobs (
            id, slug, content_version, kind, status, idempotency_key, trigger_source,
            chunk_count, estimated_cost_usd, characters, created_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(idempotency_key) DO NOTHING`,
    args: [
      id,
      input.slug,
      input.contentVersion,
      input.kind,
      input.idempotencyKey,
      input.triggerSource,
      input.chunkCount,
      input.estimatedCostUsd,
      input.characters,
      timestamp,
    ],
  });

  const stored = await db.execute({
    sql: 'SELECT * FROM jobs WHERE idempotency_key = ?',
    args: [input.idempotencyKey],
  });
  const job = toJob(stored.rows[0]);
  return job.id === id ? { created: true, job } : { created: false, job, reason: 'duplicate' };
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function listJobs(options: { slug?: string; limit?: number } = {}): Promise<JobRecord[]> {
  const db = await getDb();
  const result = options.slug
    ? await db.execute({
        sql: 'SELECT * FROM jobs WHERE slug = ? ORDER BY created_at DESC LIMIT ?',
        args: [options.slug, options.limit ?? 20],
      })
    : await db.execute({
        sql: 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?',
        args: [options.limit ?? 50],
      });
  return result.rows.map(toJob);
}

/** An episode already has work in flight when a queued/running job exists. */
export async function findActiveJob(slug: string): Promise<JobRecord | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT * FROM jobs WHERE slug = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
    args: [slug],
  });
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

/**
 * Take the lease on a job for this invocation.
 *
 * The conditional UPDATE is the concurrency guard: two invocations racing on
 * the same job means exactly one of them sees rowsAffected === 1.
 */
export async function leaseJob(id: string, leaseMs: number): Promise<JobRecord | null> {
  const db = await getDb();
  const timestamp = now();
  const expires = new Date(Date.now() + leaseMs).toISOString();
  const result = await db.execute({
    sql: `UPDATE jobs SET status = 'running', attempts = attempts + 1,
            started_at = COALESCE(started_at, ?), lease_expires_at = ?
          WHERE id = ?
            AND status IN ('queued','running')
            AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
    args: [timestamp, expires, id, timestamp],
  });
  if (result.rowsAffected === 0) return null;
  return getJob(id);
}

export async function extendJobLease(id: string, leaseMs: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE jobs SET lease_expires_at = ? WHERE id = ?',
    args: [new Date(Date.now() + leaseMs).toISOString(), id],
  });
}

export async function releaseJob(id: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "UPDATE jobs SET status = 'queued', lease_expires_at = NULL WHERE id = ? AND status = 'running'",
    args: [id],
  });
}

export async function updateJobProgress(
  id: string,
  patch: { chunksCompleted?: number; requestsUsed?: number; actualCostUsd?: number },
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (patch.chunksCompleted !== undefined) {
    sets.push('chunks_completed = ?');
    args.push(patch.chunksCompleted);
  }
  if (patch.requestsUsed !== undefined) {
    sets.push('requests_used = ?');
    args.push(patch.requestsUsed);
  }
  if (patch.actualCostUsd !== undefined) {
    sets.push('actual_cost_usd = ?');
    args.push(patch.actualCostUsd);
  }
  if (sets.length === 0) return;
  args.push(id);
  await db.execute({ sql: `UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args });
}

export async function finishJob(
  id: string,
  status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
  options: { error?: string | null; errorKind?: string | null } = {},
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE jobs SET status = ?, error = ?, error_kind = ?, finished_at = ?, lease_expires_at = NULL
          WHERE id = ?`,
    args: [status, options.error ?? null, options.errorKind ?? null, now(), id],
  });
}

/** Jobs that are queued, or running with an expired lease (crashed worker). */
export async function findResumableJobs(limit = 5): Promise<JobRecord[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT * FROM jobs
          WHERE status = 'queued'
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
          ORDER BY created_at ASC LIMIT ?`,
    args: [now(), limit],
  });
  return result.rows.map(toJob);
}

/* -------------------------------------------------------------------- chunks */

export async function upsertChunkPlan(
  slug: string,
  contentVersion: string,
  chunks: {
    chunkId: string;
    sequence: number;
    characters: number;
    textHash: string;
    speakers: string;
    estimatedCostUsd: number;
  }[],
): Promise<void> {
  const db = await getDb();
  const timestamp = now();
  await db.batch(
    chunks.map((chunk) => ({
      sql: `INSERT INTO chunks (
              slug, content_version, chunk_id, sequence, characters, text_hash, speakers,
              status, estimated_cost_usd, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
            ON CONFLICT(slug, content_version, chunk_id) DO UPDATE SET
              sequence = excluded.sequence,
              characters = excluded.characters,
              speakers = excluded.speakers,
              estimated_cost_usd = excluded.estimated_cost_usd,
              updated_at = excluded.updated_at,
              -- A changed text hash invalidates previously generated audio.
              status = CASE WHEN chunks.text_hash = excluded.text_hash THEN chunks.status ELSE 'pending' END,
              audio_key = CASE WHEN chunks.text_hash = excluded.text_hash THEN chunks.audio_key ELSE NULL END,
              text_hash = excluded.text_hash`,
      args: [
        slug,
        contentVersion,
        chunk.chunkId,
        chunk.sequence,
        chunk.characters,
        chunk.textHash,
        chunk.speakers,
        chunk.estimatedCostUsd,
        timestamp,
        timestamp,
      ],
    })),
    'write',
  );
}

export async function listChunks(slug: string, contentVersion: string): Promise<ChunkRecord[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM chunks WHERE slug = ? AND content_version = ? ORDER BY sequence ASC',
    args: [slug, contentVersion],
  });
  return result.rows.map(toChunk);
}

export async function markChunkGenerating(slug: string, contentVersion: string, chunkId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE chunks SET status = 'generating', attempts = attempts + 1, updated_at = ?
          WHERE slug = ? AND content_version = ? AND chunk_id = ?`,
    args: [now(), slug, contentVersion, chunkId],
  });
}

export async function markChunkGenerated(
  slug: string,
  contentVersion: string,
  chunkId: string,
  input: { audioKey: string; durationSeconds: number; actualCostUsd: number; providerRequestId: string | null },
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE chunks SET status = 'generated', audio_key = ?, duration_seconds = ?,
            actual_cost_usd = ?, provider_request_id = ?, error = NULL, updated_at = ?
          WHERE slug = ? AND content_version = ? AND chunk_id = ?`,
    args: [
      input.audioKey,
      input.durationSeconds,
      input.actualCostUsd,
      input.providerRequestId,
      now(),
      slug,
      contentVersion,
      chunkId,
    ],
  });
}

export async function markChunkFailed(
  slug: string,
  contentVersion: string,
  chunkId: string,
  error: string,
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE chunks SET status = 'failed', error = ?, updated_at = ?
          WHERE slug = ? AND content_version = ? AND chunk_id = ?`,
    args: [error.slice(0, 2000), now(), slug, contentVersion, chunkId],
  });
}

/** Clear generated audio so the next job re-renders. Used by "regenerate". */
export async function resetChunks(
  slug: string,
  contentVersion: string,
  options: { onlyFailed?: boolean } = {},
): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE chunks SET status = 'pending', attempts = 0, audio_key = NULL, error = NULL, updated_at = ?
          WHERE slug = ? AND content_version = ?${options.onlyFailed ? " AND status IN ('failed','generating')" : ''}`,
    args: [now(), slug, contentVersion],
  });
  return result.rowsAffected;
}

/* ------------------------------------------------------------------ ledger */

export async function recordAttempt(input: {
  jobId: string;
  slug: string;
  contentVersion: string;
  chunkId: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  httpStatus?: number | null;
  providerRequestId?: string | null;
  errorKind?: string | null;
  errorMessage?: string | null;
  characters: number;
  billable: boolean;
  estimatedCostUsd: number;
  providerCharacterCost?: number | null;
  latencyMs?: number | null;
  startedAt: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO generation_attempts (
            id, job_id, slug, content_version, chunk_id, attempt, status, http_status,
            provider_request_id, error_kind, error_message, characters, billable,
            estimated_cost_usd, provider_character_cost, latency_ms, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      input.jobId,
      input.slug,
      input.contentVersion,
      input.chunkId,
      input.attempt,
      input.status,
      input.httpStatus ?? null,
      input.providerRequestId ?? null,
      input.errorKind ?? null,
      input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
      input.characters,
      input.billable ? 1 : 0,
      input.estimatedCostUsd,
      input.providerCharacterCost ?? null,
      input.latencyMs ?? null,
      input.startedAt,
      now(),
    ],
  });
}

export async function listAttempts(jobId: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM generation_attempts WHERE job_id = ? ORDER BY started_at ASC',
    args: [jobId],
  });
  return result.rows.map((row) => ({ ...row }));
}

export async function appendEvent(input: {
  jobId?: string | null;
  slug?: string | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'INSERT INTO job_events (id, job_id, slug, level, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [
      randomUUID(),
      input.jobId ?? null,
      input.slug ?? null,
      input.level,
      input.message.slice(0, 2000),
      input.data === undefined ? null : JSON.stringify(input.data),
      now(),
    ],
  });
}

export async function listEvents(options: { jobId?: string; slug?: string; limit?: number }): Promise<JobEvent[]> {
  const db = await getDb();
  const limit = options.limit ?? 100;
  const result = options.jobId
    ? await db.execute({
        sql: 'SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?',
        args: [options.jobId, limit],
      })
    : options.slug
      ? await db.execute({
          sql: 'SELECT * FROM job_events WHERE slug = ? ORDER BY created_at DESC LIMIT ?',
          args: [options.slug, limit],
        })
      : await db.execute({ sql: 'SELECT * FROM job_events ORDER BY created_at DESC LIMIT ?', args: [limit] });

  return result.rows.map((row) => ({
    id: asString(row.id),
    jobId: asNullableString(row.job_id),
    slug: asNullableString(row.slug),
    level: asString(row.level),
    message: asString(row.message),
    data: row.data_json ? JSON.parse(asString(row.data_json)) : null,
    createdAt: asString(row.created_at),
  }));
}

/* ------------------------------------------------------- delivery receipts */

/**
 * Record a webhook delivery id. Returns false when it was already seen, which
 * is how a duplicate delivery becomes a no-op rather than a second render.
 */
export async function recordDelivery(deliveryId: string, source: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'INSERT INTO delivery_receipts (delivery_id, source, received_at) VALUES (?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING',
    args: [deliveryId, source, now()],
  });
  return result.rowsAffected === 1;
}

export async function setDeliveryResult(deliveryId: string, result: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE delivery_receipts SET result = ? WHERE delivery_id = ?',
    args: [result.slice(0, 1000), deliveryId],
  });
}
