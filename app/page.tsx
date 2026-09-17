/**
 * The library: what this app is for. A private podcast shelf, newest first.
 */
import Link from 'next/link';
import { Masthead } from '@/components/masthead';
import { formatDuration } from '@/lib/cost';
import { listEpisodeViews, syncEpisodes } from '@/lib/episode/service';

export const dynamic = 'force-dynamic';

function formatDate(value: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default async function LibraryPage() {
  // Keep the shelf honest: refresh from the authored specs on every visit.
  await syncEpisodes().catch(() => undefined);
  const episodes = await listEpisodeViews();
  const published = episodes.filter((view) => view.record.status === 'published' && view.record.audioUrl);
  const upcoming = episodes.filter((view) => view.record.status !== 'published');

  return (
    <main className="shell">
      <Masthead current="library" />

      {published.length === 0 ? (
        <div className="empty-state">
          No finished episodes yet.
          <br />
          Publish a spec with <code>&quot;status&quot;: &quot;ready_for_audio&quot;</code>, then generate it in the Studio.
        </div>
      ) : (
        <ul className="episode-list">
          {published.map(({ record, spec }) => (
            <li key={record.slug}>
              <Link href={`/episodes/${record.slug}`} className="episode-card">
                <h2>{record.title}</h2>
                {spec.subtitle ? <p className="subtitle">{spec.subtitle}</p> : null}
                <div className="meta-row">
                  <span className="project-tag">{record.project}</span>
                  <span className="dot">{formatDate(record.publishedAt)}</span>
                  <span className="dot">{formatDuration(record.audioDurationSeconds)}</span>
                  <span className="play-hint">▶ Play</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {upcoming.length > 0 ? (
        <section className="section">
          <h3>In production</h3>
          <ul className="episode-list">
            {upcoming.map(({ record, estimate }) => (
              <li key={record.slug}>
                <Link href={`/admin/episodes/${record.slug}`} className="episode-card">
                  <h2>{record.title}</h2>
                  <div className="meta-row">
                    <span className="project-tag">{record.project}</span>
                    <span className="dot">{record.status.replace(/_/g, ' ')}</span>
                    <span className="dot">~{formatDuration(estimate.estimatedRuntimeSeconds)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
