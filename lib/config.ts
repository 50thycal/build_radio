/**
 * Central configuration. Every tunable number in Build OS Radio lives here so
 * that cost, chunking and safety limits can be changed without touching logic.
 *
 * Nothing in this file may be imported from a client component: it reads
 * server-only environment variables.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, received "${raw}"`);
  }
  return parsed;
}

function str(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

/** Cost + runtime planning model. Calibrated from the Build OS Radio budget:
 *  17,000 characters ~= 20 minutes ~= $1.70. */
export const costConfig = {
  /** ElevenLabs list price used for *estimates*. Never treated as billing truth. */
  usdPer1kCharacters: num('ELEVENLABS_USD_PER_1K_CHARS', 0.1),
  /** Speaking rate used to predict runtime from character count. */
  charactersPerSecond: num('RUNTIME_CHARS_PER_SECOND', 14.2),
  /** Words per minute, used for the secondary runtime sanity check. */
  wordsPerMinute: num('RUNTIME_WORDS_PER_MINUTE', 136),
} as const;

/** Chunking limits. ElevenLabs Text-to-Dialogue degrades on very long inputs,
 *  so we target small, speaker-aligned requests. */
export const chunkConfig = {
  /** Target ceiling for a single generation request. */
  maxCharactersPerChunk: num('MAX_CHARS_PER_CHUNK', 2000),
  /** Below this we prefer to merge a chunk with its neighbour. */
  minCharactersPerChunk: num('MIN_CHARS_PER_CHUNK', 400),
  /** Hard ceiling for a single dialogue line before we split inside it. */
  maxCharactersPerLine: num('MAX_CHARS_PER_LINE', 2000),
} as const;

/** Spend protection. These are the guard rails that stop a runaway bill. */
export const safetyConfig = {
  /** Reject an episode whose script exceeds this many characters. */
  maxEpisodeCharacters: num('MAX_EPISODE_CHARACTERS', 30_000),
  /** Reject an episode whose *estimated* cost exceeds this. */
  maxEstimatedCostUsd: num('MAX_ESTIMATED_COST_USD', 3),
  /** Per-chunk generation attempts, including the first. Never unbounded. */
  maxAttemptsPerChunk: num('MAX_ATTEMPTS_PER_CHUNK', 3),
  /** Total paid requests a single job may ever issue. Absolute backstop. */
  maxRequestsPerJob: num('MAX_REQUESTS_PER_JOB', 60),
  /** Wall-clock budget for one serverless invocation before the job hands off
   *  to a fresh invocation. Keeps us under the platform function timeout. */
  invocationBudgetMs: num('INVOCATION_BUDGET_MS', 45_000),
  /** A job that has not made progress for this long is considered stuck and
   *  may be reclaimed by the cron sweeper. */
  jobLeaseMs: num('JOB_LEASE_MS', 5 * 60_000),
} as const;

export const elevenLabsConfig = {
  apiKey: str('ELEVENLABS_API_KEY'),
  baseUrl: str('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io'),
  model: str('ELEVENLABS_MODEL_ID', 'eleven_v3'),
  /** MP3 keeps stitching cheap: frames concatenate losslessly. */
  outputFormat: str('ELEVENLABS_OUTPUT_FORMAT', 'mp3_44100_128'),
  hostVoiceId: str('ELEVENLABS_HOST_VOICE_ID'),
  guestVoiceId: str('ELEVENLABS_GUEST_VOICE_ID'),
  /** Optional additional roles: ELEVENLABS_VOICE_<ROLE>=<voice id>. */
  requestTimeoutMs: num('ELEVENLABS_TIMEOUT_MS', 120_000),
} as const;

export const authConfig = {
  adminPassword: str('ADMIN_PASSWORD'),
  sessionSecret: str('SESSION_SECRET'),
  internalSecret: str('INTERNAL_GENERATION_SECRET'),
  githubWebhookSecret: str('GITHUB_WEBHOOK_SECRET'),
  sessionTtlSeconds: num('SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
} as const;

export const githubConfig = {
  /** "owner/repo" — when set, episode specs are read through the GitHub API so
   *  a spec edit takes effect without waiting for a redeploy. */
  repo: str('GITHUB_REPO'),
  branch: str('GITHUB_BRANCH', 'main'),
  token: str('GITHUB_TOKEN'),
  apiBaseUrl: str('GITHUB_API_BASE_URL', 'https://api.github.com'),
} as const;

export const storageConfig = {
  /** "vercel-blob" in production, "local" for development. The local driver
   *  always writes to public/media so the path stays statically analysable. */
  driver: str('MEDIA_STORE_DRIVER', process.env.BLOB_READ_WRITE_TOKEN ? 'vercel-blob' : 'local'),
  blobToken: str('BLOB_READ_WRITE_TOKEN'),
  /** Public prefix used by the local driver when building URLs. */
  localPublicPrefix: str('MEDIA_STORE_LOCAL_PREFIX', '/media'),
} as const;

export const dbConfig = {
  url: str('DATABASE_URL', 'file:./data/build-os-radio.db'),
  authToken: str('DATABASE_AUTH_TOKEN'),
} as const;

/** Absolute base URL of this deployment, used for job self-continuation. */
export function appBaseUrl(): string {
  const explicit = str('APP_BASE_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = str('VERCEL_PROJECT_PRODUCTION_URL') || str('VERCEL_URL');
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return 'http://localhost:3000';
}
