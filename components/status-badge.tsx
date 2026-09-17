import type { EpisodeStatus } from '@/lib/episode/schema';

const CLASS_BY_STATUS: Record<EpisodeStatus, string> = {
  draft: 'badge-draft',
  ready_for_audio: 'badge-ready',
  queued: 'badge-progress',
  generating: 'badge-progress',
  stitching: 'badge-progress',
  uploading: 'badge-progress',
  published: 'badge-published',
  failed: 'badge-failed',
};

const LABEL_BY_STATUS: Record<EpisodeStatus, string> = {
  draft: 'Draft',
  ready_for_audio: 'Ready',
  queued: 'Queued',
  generating: 'Generating',
  stitching: 'Stitching',
  uploading: 'Uploading',
  published: 'Published',
  failed: 'Failed',
};

export function StatusBadge({ status }: { status: EpisodeStatus }) {
  return <span className={`badge ${CLASS_BY_STATUS[status] ?? 'badge-draft'}`}>{LABEL_BY_STATUS[status] ?? status}</span>;
}
