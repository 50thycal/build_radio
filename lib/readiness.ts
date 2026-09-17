/**
 * Configuration readiness.
 *
 * A fresh deployment has no credentials, and the useful thing for it to do is
 * say precisely what is missing rather than fail opaquely. This module is the
 * single source of that answer: it backs /api/health and the status panel in
 * the studio.
 *
 * It never reveals a secret's value — only whether one is present.
 */
import { dbConfig, elevenLabsConfig, authConfig, githubConfig, storageConfig } from './config';

export type CheckStatus = 'ok' | 'warn' | 'missing';

export type ReadinessCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Environment variables that resolve this check, for the setup UI. */
  variables: string[];
};

export type Readiness = {
  /** True when an episode can actually be rendered end to end. */
  canGenerate: boolean;
  /** True when finished audio will survive the next deployment. */
  storageDurable: boolean;
  checks: ReadinessCheck[];
  environment: {
    isVercel: boolean;
    nodeEnv: string;
    databaseDriver: 'remote' | 'file';
    mediaDriver: string;
    episodeSource: 'github' | 'filesystem';
  };
};

const present = (value: string): boolean => value.trim().length > 0;

/**
 * Evaluate configuration.
 *
 * `missing` means a capability is unavailable; `warn` means it works but not in
 * the way a production deployment should (ephemeral storage, no live spec
 * reads). Nothing here performs I/O — see `probeDatabase` for that.
 */
export function evaluateReadiness(env: NodeJS.ProcessEnv = process.env): Readiness {
  const isVercel = present(env.VERCEL ?? '');
  const isRemoteDb = /^(libsql|wss?|https):/.test(dbConfig.url);
  const checks: ReadinessCheck[] = [];

  checks.push({
    key: 'internal',
    label: 'Internal automation secret',
    status: present(authConfig.internalSecret) ? 'ok' : 'missing',
    detail: present(authConfig.internalSecret)
      ? 'Job continuation and the GitHub Action can authenticate.'
      : 'Required: the job runner calls itself with this, so renders cannot continue without it.',
    variables: ['INTERNAL_GENERATION_SECRET'],
  });

  checks.push({
    key: 'provider',
    label: 'ElevenLabs API key',
    status: present(elevenLabsConfig.apiKey) ? 'ok' : 'missing',
    detail: present(elevenLabsConfig.apiKey)
      ? `Renderer ready (model ${elevenLabsConfig.model}, ${elevenLabsConfig.outputFormat}).`
      : 'Without it, episodes can be written and priced but never rendered.',
    variables: ['ELEVENLABS_API_KEY'],
  });

  const hasVoices = present(elevenLabsConfig.hostVoiceId) && present(elevenLabsConfig.guestVoiceId);
  checks.push({
    key: 'voices',
    label: 'Host and guest voices',
    status: hasVoices ? 'ok' : 'missing',
    detail: hasVoices
      ? 'Both default voices are configured.'
      : 'Copy two voice ids from the ElevenLabs voice library. A spec can override per speaker.',
    variables: ['ELEVENLABS_HOST_VOICE_ID', 'ELEVENLABS_GUEST_VOICE_ID'],
  });

  checks.push({
    key: 'database',
    label: 'Operational database',
    status: isRemoteDb ? 'ok' : isVercel ? 'warn' : 'ok',
    detail: isRemoteDb
      ? 'Remote libSQL / Turso: job and cost state persists.'
      : isVercel
        ? 'Using a temporary file database. It is wiped on every deployment and is not shared between serverless instances — set DATABASE_URL to a Turso URL before generating anything.'
        : 'Local file database. Fine for development.',
    variables: ['DATABASE_URL', 'DATABASE_AUTH_TOKEN'],
  });

  const blobConfigured = storageConfig.driver === 'vercel-blob' && present(storageConfig.blobToken);
  checks.push({
    key: 'storage',
    label: 'Media storage',
    status: blobConfigured ? 'ok' : isVercel ? 'missing' : 'warn',
    detail: blobConfigured
      ? 'Vercel Blob: finished audio is durable.'
      : isVercel
        ? 'No Blob store connected. Finished audio cannot be written on a read-only filesystem.'
        : 'Local filesystem (data/media). Fine for development.',
    variables: ['BLOB_READ_WRITE_TOKEN'],
  });

  checks.push({
    key: 'github',
    label: 'GitHub spec source',
    status: present(githubConfig.repo) ? 'ok' : 'warn',
    detail: present(githubConfig.repo)
      ? `Reading specs live from ${githubConfig.repo}@${githubConfig.branch}.`
      : 'Reading the specs bundled with this deployment. Set GITHUB_REPO to pick up spec edits without redeploying.',
    variables: ['GITHUB_REPO', 'GITHUB_BRANCH', 'GITHUB_TOKEN'],
  });

  const byKey = new Map(checks.map((check) => [check.key, check]));
  const ok = (key: string) => byKey.get(key)?.status === 'ok';

  return {
    canGenerate: ok('provider') && ok('voices') && ok('internal') && byKey.get('storage')?.status !== 'missing',
    storageDurable: blobConfigured,
    checks,
    environment: {
      isVercel,
      nodeEnv: env.NODE_ENV ?? 'development',
      databaseDriver: isRemoteDb ? 'remote' : 'file',
      mediaDriver: storageConfig.driver,
      episodeSource: present(githubConfig.repo) ? 'github' : 'filesystem',
    },
  };
}

/** Actually touch the database, so the report reflects reality not intent. */
export async function probeDatabase(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { getDb } = await import('./db/client');
    const db = await getDb();
    const result = await db.execute('SELECT COUNT(*) AS n FROM episodes');
    return { ok: true, detail: `Connected. ${String(result.rows[0]?.n ?? 0)} episode(s) cached.` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/** Env vars still to set, in the order a first-time setup should set them. */
export function missingVariables(readiness: Readiness): string[] {
  return readiness.checks
    .filter((check) => check.status === 'missing')
    .flatMap((check) => check.variables);
}
