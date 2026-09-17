/**
 * Episode source: GitHub is the ledger.
 *
 * Specs live in the repository under episodes/drafts and episodes/published.
 * Two providers implement the same interface:
 *
 *   filesystem — reads the checked-out repo. Used in local development and as
 *                the fallback on Vercel (the repo ships with the deployment).
 *   github     — reads the Contents API. Used when GITHUB_REPO is set so that
 *                a spec edited on GitHub takes effect immediately, without
 *                waiting for a redeploy.
 *
 * Neither provider ever writes: authoring happens in git, by ChatGPT or by a
 * human, never by this application.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { githubConfig } from '../config';
import { validateEpisode, type EpisodeSpec, type EpisodeValidationIssue } from './schema';

/** Repository folder holding every authored spec. */
export const EPISODES_ROOT = 'episodes';
/** Sub-folders scanned, in listing order. */
export const EPISODE_FOLDERS = ['drafts', 'published'] as const;
export const EPISODE_DIRECTORIES = [
  `${EPISODES_ROOT}/drafts`,
  `${EPISODES_ROOT}/published`,
] as const;

export type EpisodeFile = {
  /** Repo-relative path, e.g. episodes/drafts/sample.json */
  path: string;
  slug: string;
  raw: string;
};

export type LoadedEpisode =
  | { ok: true; path: string; episode: EpisodeSpec; warnings: EpisodeValidationIssue[] }
  | { ok: false; path: string; slug: string; issues: EpisodeValidationIssue[] };

export interface EpisodeSource {
  readonly name: string;
  listFiles(): Promise<EpisodeFile[]>;
  readFileAt(repoPath: string): Promise<EpisodeFile | null>;
}

/**
 * Reads the checked-out repository.
 *
 * Paths are built from the literal `episodes` root so the deployment bundler
 * can trace exactly this folder rather than the whole project.
 */
export class FilesystemEpisodeSource implements EpisodeSource {
  readonly name = 'filesystem';

  async listFiles(): Promise<EpisodeFile[]> {
    const files: EpisodeFile[] = [];
    for (const folder of EPISODE_FOLDERS) {
      const directory = `${EPISODES_ROOT}/${folder}`;
      const absolute = path.join(process.cwd(), EPISODES_ROOT, folder);
      let entries: string[];
      try {
        entries = await readdir(absolute);
      } catch {
        continue; // directory absent is normal
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const raw = await readFile(path.join(absolute, entry), 'utf8');
        files.push({ path: `${directory}/${entry}`, slug: entry.replace(/\.json$/, ''), raw });
      }
    }
    return files;
  }

  async readFileAt(repoPath: string): Promise<EpisodeFile | null> {
    // Only ever read inside episodes/<folder>/<name>.json.
    const match = repoPath.match(/^episodes\/(drafts|published)\/([^/]+)\.json$/);
    if (!match) return null;
    try {
      const raw = await readFile(path.join(process.cwd(), EPISODES_ROOT, match[1], `${match[2]}.json`), 'utf8');
      return { path: repoPath, slug: match[2], raw };
    } catch {
      return null;
    }
  }
}

export class GitHubEpisodeSource implements EpisodeSource {
  readonly name = 'github';
  constructor(
    private readonly repo: string = githubConfig.repo,
    private readonly branch: string = githubConfig.branch,
    private readonly token: string = githubConfig.token,
    private readonly apiBaseUrl: string = githubConfig.apiBaseUrl,
  ) {
    if (!repo.includes('/')) {
      throw new Error(`GITHUB_REPO must be in "owner/repo" form, received "${repo}"`);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'build-os-radio',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private contentsUrl(repoPath: string): string {
    return `${this.apiBaseUrl}/repos/${this.repo}/contents/${repoPath}?ref=${encodeURIComponent(this.branch)}`;
  }

  async listFiles(): Promise<EpisodeFile[]> {
    const files: EpisodeFile[] = [];
    for (const directory of EPISODE_DIRECTORIES) {
      const response = await fetch(this.contentsUrl(directory), { headers: this.headers(), cache: 'no-store' });
      if (response.status === 404) continue;
      if (!response.ok) {
        throw new Error(`GitHub listing failed for ${directory}: ${response.status} ${await response.text()}`);
      }
      const entries = (await response.json()) as { name: string; path: string; type: string }[];
      for (const entry of entries) {
        if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue;
        const file = await this.readFileAt(entry.path);
        if (file) files.push(file);
      }
    }
    return files;
  }

  async readFileAt(repoPath: string): Promise<EpisodeFile | null> {
    const response = await fetch(this.contentsUrl(repoPath), {
      headers: { ...this.headers(), accept: 'application/vnd.github.raw+json' },
      cache: 'no-store',
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub read failed for ${repoPath}: ${response.status} ${await response.text()}`);
    }
    const raw = await response.text();
    return { path: repoPath, slug: path.basename(repoPath, '.json'), raw };
  }
}

/**
 * GitHub when configured, filesystem otherwise — with a filesystem fallback if
 * GitHub is unreachable, so a provider outage cannot take the library down.
 */
export class ResilientEpisodeSource implements EpisodeSource {
  readonly name = 'github+filesystem';
  constructor(
    private readonly primary: EpisodeSource,
    private readonly fallback: EpisodeSource,
    private readonly onFallback?: (error: Error) => void,
  ) {}

  async listFiles(): Promise<EpisodeFile[]> {
    try {
      return await this.primary.listFiles();
    } catch (error) {
      this.onFallback?.(error as Error);
      return this.fallback.listFiles();
    }
  }

  async readFileAt(repoPath: string): Promise<EpisodeFile | null> {
    try {
      return await this.primary.readFileAt(repoPath);
    } catch (error) {
      this.onFallback?.(error as Error);
      return this.fallback.readFileAt(repoPath);
    }
  }
}

export function createEpisodeSource(): EpisodeSource {
  if (!githubConfig.repo) return new FilesystemEpisodeSource();
  return new ResilientEpisodeSource(new GitHubEpisodeSource(), new FilesystemEpisodeSource(), (error) => {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        message: 'GitHub episode source unavailable, falling back to filesystem',
        detail: error.message,
      }),
    );
  });
}

/** Parse a raw episode file into a validated spec or a structured failure. */
export function parseEpisodeFile(file: EpisodeFile): LoadedEpisode {
  let json: unknown;
  try {
    json = JSON.parse(file.raw);
  } catch (error) {
    return {
      ok: false,
      path: file.path,
      slug: file.slug,
      issues: [{ path: '', message: `Invalid JSON: ${(error as Error).message}` }],
    };
  }
  const result = validateEpisode(json);
  if (!result.ok) return { ok: false, path: file.path, slug: file.slug, issues: result.issues };
  if (result.episode.slug !== file.slug) {
    return {
      ok: false,
      path: file.path,
      slug: file.slug,
      issues: [
        {
          path: 'slug',
          message: `Slug "${result.episode.slug}" does not match filename "${file.slug}.json"`,
        },
      ],
    };
  }
  return { ok: true, path: file.path, episode: result.episode, warnings: result.warnings };
}

export async function loadAllEpisodes(source: EpisodeSource = createEpisodeSource()): Promise<LoadedEpisode[]> {
  const files = await source.listFiles();
  return files.map(parseEpisodeFile);
}

export async function loadEpisodeBySlug(
  slug: string,
  source: EpisodeSource = createEpisodeSource(),
): Promise<LoadedEpisode | null> {
  for (const directory of EPISODE_DIRECTORIES) {
    const file = await source.readFileAt(`${directory}/${slug}.json`);
    if (file) return parseEpisodeFile(file);
  }
  return null;
}
