/**
 * Studio detail: the "ready to generate" panel from the handoff brief, plus
 * chunk state, cost telemetry and the job log.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GenerationControls } from '@/components/generation-controls';
import { Masthead } from '@/components/masthead';
import { StatusBadge } from '@/components/status-badge';
import { formatDuration, formatUsd } from '@/lib/cost';
import { listEvents, listJobs } from '@/lib/db/store';
import { getEpisodeView, syncEpisode } from '@/lib/episode/service';

export const dynamic = 'force-dynamic';

export default async function AdminEpisodePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await syncEpisode(slug).catch(() => undefined);
  const view = await getEpisodeView(slug);
  if (!view) notFound();

  const { record, spec, estimate, plan, chunks } = view;
  const jobs = await listJobs({ slug, limit: 5 });
  const events = await listEvents({ slug, limit: 40 });

  const generated = chunks.filter((chunk) => chunk.status === 'generated').length;
  const failed = chunks.filter((chunk) => chunk.status === 'failed');
  const inFlight = ['queued', 'generating', 'stitching', 'uploading'].includes(record.status);

  const blockedReason = !plan.limits.ok
    ? plan.limits.reason
    : plan.missingVoices.length > 0
      ? `No voice id for: ${plan.missingVoices.join(', ')}. Set voice_id in the spec or ELEVENLABS_*_VOICE_ID.`
      : record.status === 'draft'
        ? 'This spec is a draft. Set "status": "ready_for_audio" in GitHub to allow generation.'
        : inFlight
          ? `A job is currently ${record.status}.`
          : null;

  return (
    <main className="shell">
      <Masthead current="admin" />

      <div className="meta-row" style={{ marginBottom: 10 }}>
        <span className="project-tag">{record.project}</span>
        <StatusBadge status={record.status} />
      </div>
      <h1 style={{ fontSize: 22, margin: '0 0 6px', lineHeight: 1.25 }}>{record.title}</h1>
      {spec.subtitle ? <p className="subtitle" style={{ color: 'var(--text-dim)' }}>{spec.subtitle}</p> : null}

      <section className="estimate-card" style={{ marginTop: 16 }}>
        <h3>{record.status === 'published' ? 'Generated' : 'Ready to generate'}</h3>
        <p className="title">{record.title}</p>
        <dl className="kv">
          <dt>Estimated runtime</dt>
          <dd>{formatDuration(estimate.estimatedRuntimeSeconds)}</dd>
          <dt>Words</dt>
          <dd>{estimate.words.toLocaleString()}</dd>
          <dt>Characters</dt>
          <dd>{estimate.characters.toLocaleString()}</dd>
          <dt>Dialogue chunks</dt>
          <dd>{estimate.chunkCount}</dd>
          <dt>Estimated cost</dt>
          <dd>{formatUsd(estimate.estimatedCostUsd)}</dd>
        </dl>

        {chunks.length > 0 ? (
          <>
            <div className="chunk-grid" aria-label={`${generated} of ${chunks.length} chunks generated`}>
              {chunks.map((chunk) => (
                <span
                  key={chunk.chunkId}
                  className={`chunk-pip ${chunk.status}`}
                  title={`${chunk.chunkId} · ${chunk.characters} chars · ${chunk.status}${chunk.error ? ` · ${chunk.error}` : ''}`}
                >
                  {chunk.sequence + 1}
                </span>
              ))}
            </div>
            <p className="action-note" style={{ marginTop: 8 }}>
              {generated}/{chunks.length} chunks rendered
              {failed.length > 0 ? ` · ${failed.length} failed` : ''}
            </p>
          </>
        ) : null}

        <GenerationControls
          slug={record.slug}
          estimatedCostUsd={estimate.estimatedCostUsd}
          canGenerate={blockedReason === null}
          hasAudio={Boolean(record.audioUrl)}
          hasFailedChunks={failed.length > 0}
          blockedReason={blockedReason}
        />
      </section>

      {record.error ? (
        <section className="section">
          <h3>Last error</h3>
          <p className="action-result error">{record.error}</p>
        </section>
      ) : null}

      <section className="section">
        <h3>Telemetry</h3>
        <dl className="kv">
          <dt>Content version</dt>
          <dd style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{record.contentVersion.slice(0, 16)}</dd>
          <dt>Spec source</dt>
          <dd>{record.specSource}</dd>
          <dt>Actual characters</dt>
          <dd>{record.actualCharacters ? record.actualCharacters.toLocaleString() : '—'}</dd>
          <dt>Actual cost</dt>
          <dd>{record.actualCostUsd ? formatUsd(record.actualCostUsd) : '—'}</dd>
          <dt>Regeneration spend</dt>
          <dd>{formatUsd(record.regenerationCostUsd)}</dd>
          <dt>Final duration</dt>
          <dd>{formatDuration(record.audioDurationSeconds)}</dd>
          <dt>Audio key</dt>
          <dd style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{record.audioKey ?? '—'}</dd>
          <dt>Updated</dt>
          <dd>{new Date(record.updatedAt).toLocaleString('en-GB')}</dd>
        </dl>
        {record.audioUrl ? (
          <p className="action-note" style={{ marginTop: 10 }}>
            <Link href={`/episodes/${record.slug}`} style={{ color: 'var(--accent)' }}>
              Open in the player →
            </Link>
          </p>
        ) : null}
      </section>

      {jobs.length > 0 ? (
        <section className="section">
          <h3>Jobs</h3>
          <ul className="log-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <span className="ts">{new Date(job.createdAt).toLocaleString('en-GB')}</span>
                <span className={job.status === 'failed' ? 'level-error' : undefined}>
                  {job.kind} · {job.status} · {job.chunksCompleted}/{job.chunkCount} · {job.requestsUsed} requests ·{' '}
                  {formatUsd(job.actualCostUsd)}
                  {job.error ? ` · ${job.error}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {events.length > 0 ? (
        <section className="section">
          <details className="details-block">
            <summary>Job log ({events.length} entries)</summary>
            <ul className="log-list" style={{ marginTop: 12 }}>
              {events.map((event) => (
                <li key={event.id}>
                  <span className="ts">{new Date(event.createdAt).toLocaleTimeString('en-GB')}</span>
                  <span className={event.level === 'error' ? 'level-error' : event.level === 'warn' ? 'level-warn' : undefined}>
                    {event.message}
                    {event.data ? ` ${JSON.stringify(event.data)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </main>
  );
}
