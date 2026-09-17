/**
 * GitHub push payload interpretation.
 *
 * Kept separate from the route handler so the "which episodes changed?"
 * decision is unit-testable without constructing HTTP requests.
 */
import { EPISODE_DIRECTORIES } from '../episode/source';

export type PushPayload = {
  ref?: string;
  repository?: { full_name?: string; default_branch?: string };
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
  head_commit?: { added?: string[]; modified?: string[]; removed?: string[] } | null;
};

export type ChangedEpisodes = {
  branch: string | null;
  /** Slugs whose spec file was added or modified. */
  changed: string[];
  /** Slugs whose spec file was deleted. */
  removed: string[];
};

function slugFromPath(filePath: string): string | null {
  if (!filePath.endsWith('.json')) return null;
  const directory = EPISODE_DIRECTORIES.find((candidate) => filePath.startsWith(`${candidate}/`));
  if (!directory) return null;
  const name = filePath.slice(directory.length + 1);
  if (name.includes('/')) return null; // nested files are not episode specs
  return name.replace(/\.json$/, '');
}

/** Extract the episode slugs touched by a push event. */
export function episodesFromPush(payload: PushPayload): ChangedEpisodes {
  const branch = payload.ref?.startsWith('refs/heads/') ? payload.ref.slice('refs/heads/'.length) : null;
  const changed = new Set<string>();
  const removed = new Set<string>();

  const commits = [...(payload.commits ?? [])];
  if (payload.head_commit) commits.push(payload.head_commit);

  for (const commit of commits) {
    for (const filePath of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
      const slug = slugFromPath(filePath);
      if (slug) changed.add(slug);
    }
    for (const filePath of commit.removed ?? []) {
      const slug = slugFromPath(filePath);
      if (slug) removed.add(slug);
    }
  }

  // A file moved from drafts/ to published/ shows as both; treat it as changed.
  for (const slug of changed) removed.delete(slug);

  return { branch, changed: [...changed], removed: [...removed] };
}
