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
   *  to a fresh invocation. Must stay comfortably under the platform function
   *  timeout (see maxDuration in app/api/jobs/run/route.ts). */
  invocationBudgetMs: num('INVOCATION_BUDGET_MS', 240_000),
  /** Assumed time to render one chunk before we have measured a real one.
   *  Generation runs slower than realtime, so a ~2 minute chunk can take a
   *  minute or more; the runner adapts this upward from observation. */
  chunkTimeBudgetMs: num('CHUNK_TIME_BUDGET_MS', 90_000),
  /** Time held back for stitching and uploading the finished episode. */
  finaliseReserveMs: num('FINALISE_RESERVE_MS', 30_000),
  /** Never let a provider request outlive the invocation: the request is
   *  aborted with this much time to spare so the failure is recorded rather
   *  than the function being killed mid-flight (which bills without storing). */
  providerAbortMarginMs: num('PROVIDER_ABORT_MARGIN_MS', 10_000),
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

/**
 * Machine secrets only. There is no human sign-in: the browser side of this
 * deployment is open by design (single owner). What still needs a secret is
 * anything a machine calls — the worker endpoint and the GitHub integrations.
 */
export const authConfig = {
  internalSecret: str('INTERNAL_GENERATION_SECRET'),
  githubWebhookSecret: str('GITHUB_WEBHOOK_SECRET'),
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

/**
 * Operational database.
 *
 * A `file:` URL is perfect locally and impossible on a serverless platform,
 * where the bundle directory is read-only. Rather than crash on the first
 * request, an unconfigured deployment falls back to a temporary file so the app
 * boots and can explain itself (see lib/readiness.ts) — that database is wiped
 * on every deployment and is not shared between instances, so production must
 * set DATABASE_URL to a Turso URL.
 */
/**
 * Variable names accepted for the database, in priority order.
 *
 * Hosted integrations name these differently — the Turso Vercel integration
 * applies a configurable prefix, and its own convention is TURSO_*. Accepting
 * the common spellings means a correctly installed integration works whatever
 * prefix was chosen, instead of silently falling back to a temporary database
 * that looks fine until a render spans two serverless instances.
 */
const DATABASE_URL_VARIABLES = [
  'DATABASE_URL',
  'TURSO_DATABASE_URL',
  'TURSO_URL',
  // The Turso Vercel integration prepends the prefix chosen at install time to
  // its own TURSO_ names, so a "DATABASE" prefix yields this rather than the
  // DATABASE_URL it looks like it should.
  'DATABASE_TURSO_DATABASE_URL',
] as const;
const DATABASE_TOKEN_VARIABLES = [
  'DATABASE_AUTH_TOKEN',
  'TURSO_AUTH_TOKEN',
  'TURSO_DATABASE_AUTH_TOKEN',
  'DATABASE_TURSO_AUTH_TOKEN',
] as const;

function firstConfigured(names: readonly string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = str(name);
    if (value) return { name, value };
  }
  return null;
}

const configuredUrl = firstConfigured(DATABASE_URL_VARIABLES);
const configuredToken = firstConfigured(DATABASE_TOKEN_VARIABLES);

export const dbConfig = {
  url:
    configuredUrl?.value ??
    (process.env.VERCEL ? 'file:/tmp/build-os-radio.db' : 'file:./data/build-os-radio.db'),
  authToken: configuredToken?.value ?? '',
  /** Which variable supplied the URL, so diagnostics can say so out loud. */
  urlVariable: configuredUrl?.name ?? null,
  tokenVariable: configuredToken?.name ?? null,
  /** True when the database will not survive a deployment. */
  get ephemeral(): boolean {
    return this.url.startsWith('file:/tmp/');
  },
} as const;

/** Absolute base URL of this deployment, used for job self-continuation. */
export function appBaseUrl(): string {
  const explicit = str('APP_BASE_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = str('VERCEL_PROJECT_PRODUCTION_URL') || str('VERCEL_URL');
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return 'http://localhost:3000';
}
