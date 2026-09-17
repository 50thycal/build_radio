/**
 * Structured logging with secret redaction.
 *
 * Generation failures are debugged from logs, so they must carry request ids,
 * chunk ids and error kinds — and never an API key. Redaction works on the
 * live values of the known secret variables, so a secret cannot leak by being
 * embedded in a provider error message either.
 */
import { appendEvent } from './db/store';

export type LogLevel = 'info' | 'warn' | 'error';

const SECRET_ENV_KEYS = [
  'ELEVENLABS_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'DATABASE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'INTERNAL_GENERATION_SECRET',
  'SESSION_SECRET',
  'ADMIN_PASSWORD',
];

/** Replace any occurrence of a live secret value with a marker. */
export function redact(value: string): string {
  let output = value;
  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret && secret.length >= 8) {
      output = output.split(secret).join(`[redacted:${key}]`);
    }
  }
  // Belt and braces for provider keys echoed in error bodies.
  return output.replace(/\b(sk|xi)-[A-Za-z0-9_-]{16,}\b/g, '[redacted:key]');
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_ENV_KEYS.includes(key.toUpperCase()) ? '[redacted]' : redactDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogContext = {
  jobId?: string | null;
  slug?: string | null;
  persist?: boolean;
};

/**
 * Log a line to stdout and, when a job or episode is in scope, to the job
 * event table so the admin UI can show what happened without a log drain.
 */
export async function log(
  level: LogLevel,
  message: string,
  data: Record<string, unknown> = {},
  context: LogContext = {},
): Promise<void> {
  const safeMessage = redact(message);
  const safeData = redactDeep(data) as Record<string, unknown>;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message: safeMessage,
    jobId: context.jobId ?? undefined,
    slug: context.slug ?? undefined,
    ...safeData,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (context.persist !== false && (context.jobId || context.slug)) {
    try {
      await appendEvent({
        jobId: context.jobId ?? null,
        slug: context.slug ?? null,
        level,
        message: safeMessage,
        data: safeData,
      });
    } catch (error) {
      // Logging must never break the pipeline it is observing.
      console.error(
        JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'failed to persist log event', detail: redact(String(error)) }),
      );
    }
  }
}

export const logger = {
  info: (message: string, data?: Record<string, unknown>, context?: LogContext) => log('info', message, data, context),
  warn: (message: string, data?: Record<string, unknown>, context?: LogContext) => log('warn', message, data, context),
  error: (message: string, data?: Record<string, unknown>, context?: LogContext) => log('error', message, data, context),
};
