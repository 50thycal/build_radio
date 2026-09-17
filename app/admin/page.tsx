/**
 * Studio: the private production view.
 *
 * Grouped by what needs attention — failures first, then work in flight, then
 * what is ready to buy, then the archive.
 */
import Link from 'next/link';
import { Masthead } from '@/components/masthead';
import { SetupChecklist } from '@/components/setup-checklist';
import { StatusBadge } from '@/components/status-badge';
import { formatDuration, formatUsd } from '@/lib/cost';
import { listJobs } from '@/lib/db/store';
import { listEpisodeViews, syncEpisodes, type EpisodeView } from '@/lib/episode/service';
import { evaluateReadiness } from '@/lib/readiness';
import type { EpisodeStatus } from '@/lib/episode/schema';

export const dynamic = 'force-dynamic';

const GROUPS: { title: string; statuses: EpisodeStatus[] }[] = [
  { title: 'Needs attention', statuses: ['failed'] },
  { title: 'In flight', statuses: ['queued', 'generating', 'stitching', 'uploading'] },
  { title: 'Ready to generate', statuses: ['ready_for_audio'] },
  { title: 'Drafts', statuses: ['draft'] },
  { title: 'Published', statuses: ['published'] },
];

function EpisodeRow({ view }: { view: EpisodeView }) {
  const { record, estimate } = view;
  return (
    <li>
      <Link href={`/admin/episodes/${record.slug}`} className="episode-card">
        <div className="meta-row" style={{ marginBottom: 6 }}>
          <span className="project-tag">{record.project}</span>
          <StatusBadge status={record.status} />
        </div>
        <h2>{record.title}</h2>
        <div className="meta-row">
          <span>{estimate.characters.toLocaleString()} chars</span>
          <span className="dot">{record.estimatedChunkCount} chunks</span>
          <span className="dot">
            {record.audioDurationSeconds
              ? formatDuration(record.audioDurationSeconds)
              : `~${formatDuration(estimate.estimatedRuntimeSeconds)}`}
          </span>
          <span className="dot">
            {record.actualCostUsd > 0
              ? `${formatUsd(record.actualCostUsd)} spent`
              : `${formatUsd(record.estimatedCostUsd)} est.`}
          </span>
        </div>
      </Link>
    </li>
  );
}

export default async function AdminPage() {
  const sync = await syncEpisodes().catch((error) => ({ synced: [], invalid: [], error: String(error) }));
  const episodes = await listEpisodeViews();
  const jobs = await listJobs({ limit: 8 });
  const readiness = evaluateReadiness();

  const lifetimeSpend = episodes.reduce((sum, view) => sum + view.record.actualCostUsd, 0);

  return (
    <main className="shell">
      <Masthead current="admin" />

      <section className="estimate-card" style={{ marginBottom: 20 }}>
        <h3>Studio</h3>
        <p className="title">{episodes.length} episode specs</p>
        <dl className="kv">
          <dt>Published</dt>
          <dd>{episodes.filter((view) => view.record.status === 'published').length}</dd>
          <dt>Lifetime provider spend</dt>
          <dd>{formatUsd(lifetimeSpend)}</dd>
          <dt>Recent jobs</dt>
          <dd>{jobs.length}</dd>
        </dl>
      </section>

      {readiness.checks.some((check) => check.status !== 'ok') ? (
        <section className="section">
          <SetupChecklist readiness={readiness} heading="Configuration" />
        </section>
      ) : null}

      {'invalid' in sync && sync.invalid.length > 0 ? (
        <section className="section">
          <h3>Invalid specs</h3>
          <ul className="episode-list">
            {sync.invalid.map((item) => (
              <li key={item.path} className="episode-card">
                <h2 style={{ fontSize: 15 }}>{item.path}</h2>
                <p className="subtitle" style={{ color: 'var(--bad)' }}>
                  {item.issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {GROUPS.map((group) => {
        const rows = episodes.filter((view) => group.statuses.includes(view.record.status));
        if (rows.length === 0) return null;
        return (
          <section className="section" key={group.title}>
            <h3>{group.title}</h3>
            <ul className="episode-list">
              {rows.map((view) => (
                <EpisodeRow key={view.record.slug} view={view} />
              ))}
            </ul>
          </section>
        );
      })}

      {jobs.length > 0 ? (
        <section className="section">
          <h3>Recent jobs</h3>
          <ul className="log-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <span className="ts">{new Date(job.createdAt).toLocaleString('en-GB')}</span>
                <span className={job.status === 'failed' ? 'level-error' : undefined}>
                  {job.slug} · {job.kind} · {job.status} · {job.chunksCompleted}/{job.chunkCount} chunks ·{' '}
                  {formatUsd(job.actualCostUsd)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
