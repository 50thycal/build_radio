/**
 * Database schema, embedded as a string so it ships inside the serverless
 * bundle. There is no migration runner: every statement is idempotent
 * (CREATE ... IF NOT EXISTS) and applied once per cold start.
 *
 * Source-of-truth split, enforced by convention and documented in the README:
 *   GitHub  -> authored episode specification (what the episode *is*)
 *   this DB -> processing and runtime state   (what happened when we rendered it)
 *   Blob    -> generated media
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  slug                    TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  project                 TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL,
  content_version         TEXT NOT NULL,
  spec_json               TEXT NOT NULL,
  spec_source             TEXT NOT NULL DEFAULT 'filesystem',
  estimated_characters    INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd      REAL    NOT NULL DEFAULT 0,
  estimated_runtime_sec   INTEGER NOT NULL DEFAULT 0,
  estimated_chunk_count   INTEGER NOT NULL DEFAULT 0,
  actual_characters       INTEGER NOT NULL DEFAULT 0,
  actual_cost_usd         REAL    NOT NULL DEFAULT 0,
  regeneration_cost_usd   REAL    NOT NULL DEFAULT 0,
  audio_key               TEXT,
  audio_url               TEXT,
  audio_duration_seconds  REAL,
  audio_checksum          TEXT,
  chapters_json           TEXT,
  error                   TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  published_at            TEXT
);

CREATE INDEX IF NOT EXISTS episodes_status_idx ON episodes (status);

CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL,
  content_version    TEXT NOT NULL,
  kind               TEXT NOT NULL,
  status             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  trigger_source     TEXT NOT NULL DEFAULT 'manual',
  chunk_count        INTEGER NOT NULL DEFAULT 0,
  chunks_completed   INTEGER NOT NULL DEFAULT 0,
  requests_used      INTEGER NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd    REAL NOT NULL DEFAULT 0,
  characters         INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  error_kind         TEXT,
  lease_expires_at   TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT
);

CREATE INDEX IF NOT EXISTS jobs_slug_idx ON jobs (slug);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

CREATE TABLE IF NOT EXISTS chunks (
  slug                TEXT NOT NULL,
  content_version     TEXT NOT NULL,
  chunk_id            TEXT NOT NULL,
  sequence            INTEGER NOT NULL,
  characters          INTEGER NOT NULL,
  text_hash           TEXT NOT NULL,
  speakers            TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  audio_key           TEXT,
  duration_seconds    REAL,
  estimated_cost_usd  REAL NOT NULL DEFAULT 0,
  actual_cost_usd     REAL NOT NULL DEFAULT 0,
  provider_request_id TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (slug, content_version, chunk_id)
);

CREATE INDEX IF NOT EXISTS chunks_lookup_idx ON chunks (slug, content_version, sequence);

CREATE TABLE IF NOT EXISTS generation_attempts (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL,
  slug                TEXT NOT NULL,
  content_version     TEXT NOT NULL,
  chunk_id            TEXT NOT NULL,
  attempt             INTEGER NOT NULL,
  status              TEXT NOT NULL,
  http_status         INTEGER,
  provider_request_id TEXT,
  error_kind          TEXT,
  error_message       TEXT,
  characters          INTEGER NOT NULL DEFAULT 0,
  billable            INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd  REAL NOT NULL DEFAULT 0,
  provider_character_cost INTEGER,
  latency_ms          INTEGER,
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);

CREATE INDEX IF NOT EXISTS attempts_job_idx ON generation_attempts (job_id);

CREATE TABLE IF NOT EXISTS job_events (
  id         TEXT PRIMARY KEY,
  job_id     TEXT,
  slug       TEXT,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  data_json  TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, created_at);
CREATE INDEX IF NOT EXISTS job_events_slug_idx ON job_events (slug, created_at);

CREATE TABLE IF NOT EXISTS delivery_receipts (
  delivery_id TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  received_at TEXT NOT NULL,
  result      TEXT
);
`;

/**
 * Column notes that matter to the design:
 *  - jobs.idempotency_key is UNIQUE: a replayed webhook or a double-clicked
 *    button reuses the existing job instead of paying for a second render.
 *  - chunks are keyed by (slug, content_version, chunk_id) rather than by job,
 *    so a retry or a later job reuses audio that has already been paid for.
 *  - generation_attempts is the cost ledger: one row per provider request,
 *    successful or not, with billable flagged separately from success.
 *  - delivery_receipts records a webhook delivery id before any work starts,
 *    so a replay is a no-op even while the first delivery is still running.
 */
export function schemaStatements(): string[] {
  return SCHEMA_SQL.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
