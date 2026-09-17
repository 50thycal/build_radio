/**
 * Episode page: player first, then the things a listener actually reads.
 * Generation telemetry is present but folded away — this is not a dashboard.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AudioPlayer } from '@/components/audio-player';
import { Masthead } from '@/components/masthead';
import { StatusBadge } from '@/components/status-badge';
import { formatDuration, formatUsd } from '@/lib/cost';
import { getEpisodeView } from '@/lib/episode/service';

export const dynamic = 'force-dynamic';

export default async function EpisodePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const view = await getEpisodeView(slug);
  if (!view) notFound();

  const { record, spec, estimate } = view;
  const chapters = record.chapters.length > 0 ? record.chapters : null;

  return (
    <main className="shell">
      <Masthead current="library" />

      <div className="episode-header">
        <div className="meta-row" style={{ marginBottom: 10 }}>
          <span className="project-tag">{record.project}</span>
          <StatusBadge status={record.status} />
        </div>
        <h1>{record.title}</h1>
        {spec.subtitle ? <p className="subtitle">{spec.subtitle}</p> : null}
        <div className="meta-row">
          {record.publishedAt ? (
            <span>{new Date(record.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
          ) : null}
          <span className="dot">
            {record.audioDurationSeconds
              ? formatDuration(record.audioDurationSeconds)
              : `~${formatDuration(estimate.estimatedRuntimeSeconds)} estimated`}
          </span>
        </div>
      </div>

      {record.audioUrl ? (
        <AudioPlayer
          slug={record.slug}
          src={record.audioUrl}
          durationSeconds={record.audioDurationSeconds}
          title={record.title}
        />
      ) : (
        <div className="player">
          <p className="player-empty">
            No audio yet — this episode is <strong>{record.status.replace(/_/g, ' ')}</strong>.
            {record.error ? <> Last error: {record.error}</> : null}
            <br />
            <Link href={`/admin/episodes/${record.slug}`} style={{ color: 'var(--accent)' }}>
              Open in Studio →
            </Link>
          </p>
        </div>
      )}

      {spec.description ? (
        <section className="section">
          <h3>About</h3>
          <p className="prose">{spec.description}</p>
        </section>
      ) : null}

      {chapters ? (
        <section className="section">
          <h3>Chapters</h3>
          <ul className="chapter-list">
            {chapters.map((chapter, index) => (
              <li key={`${chapter.title}-${index}`}>
                <span className="time">{formatDuration(chapter.startSeconds)}</span>
                <span>{chapter.title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {spec.sources.length > 0 ? (
        <section className="section">
          <h3>Sources</h3>
          <ul className="source-list">
            {spec.sources.map((source, index) => (
              <li key={`${source.title}-${index}`}>
                <span>
                  {source.url ? (
                    <a href={source.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                  {source.note ? <span style={{ color: 'var(--text-faint)' }}> — {source.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <h3>Transcript</h3>
        <div className="transcript">
          {spec.dialogue.map((line, index) => (
            <p className="line" key={index}>
              <span className="speaker">{spec.speakers[line.speaker]?.name ?? line.speaker}</span>
              {line.text}
            </p>
          ))}
        </div>
      </section>

      <section className="section">
        <details className="details-block">
          <summary>Generation details</summary>
          <dl className="kv">
            <dt>Status</dt>
            <dd>{record.status}</dd>
            <dt>Content version</dt>
            <dd style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{record.contentVersion.slice(0, 12)}</dd>
            <dt>Characters</dt>
            <dd>{(record.actualCharacters || estimate.characters).toLocaleString()}</dd>
            <dt>Words</dt>
            <dd>{estimate.words.toLocaleString()}</dd>
            <dt>Chunks</dt>
            <dd>{record.estimatedChunkCount}</dd>
            <dt>Estimated cost</dt>
            <dd>{formatUsd(record.estimatedCostUsd)}</dd>
            <dt>Actual cost</dt>
            <dd>{record.actualCostUsd ? formatUsd(record.actualCostUsd) : '—'}</dd>
            <dt>Regeneration spend</dt>
            <dd>{formatUsd(record.regenerationCostUsd)}</dd>
            <dt>Renderer</dt>
            <dd>
              {spec.generation.provider} / {spec.generation.model}
            </dd>
          </dl>
          <p className="action-note" style={{ marginTop: 12 }}>
            <Link href={`/admin/episodes/${record.slug}`} style={{ color: 'var(--accent)' }}>
              Studio controls and job logs →
            </Link>
          </p>
        </details>
      </section>
    </main>
  );
}
