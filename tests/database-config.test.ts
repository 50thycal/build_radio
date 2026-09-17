import { describe, expect, it, vi } from 'vitest';

/**
 * The database URL is read once at import time, so each spelling is checked in
 * an isolated module registry with only that variable set. A hosted integration
 * choosing its own prefix must not silently leave us on the temporary database.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const key of ['DATABASE_URL', 'TURSO_DATABASE_URL', 'TURSO_URL', 'DATABASE_AUTH_TOKEN', 'TURSO_AUTH_TOKEN']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  vi.resetModules();
  const module = await import('../lib/config');
  process.env = saved;
  return module.dbConfig;
}

describe('database configuration', () => {
  it('prefers DATABASE_URL', async () => {
    const config = await loadConfig({ DATABASE_URL: 'libsql://primary.turso.io', DATABASE_AUTH_TOKEN: 'a' });
    expect(config.url).toBe('libsql://primary.turso.io');
    expect(config.urlVariable).toBe('DATABASE_URL');
    expect(config.authToken).toBe('a');
    expect(config.ephemeral).toBe(false);
  });

  it('accepts the Turso integration spelling', async () => {
    const config = await loadConfig({ TURSO_DATABASE_URL: 'libsql://integration.turso.io', TURSO_AUTH_TOKEN: 'b' });
    expect(config.url).toBe('libsql://integration.turso.io');
    expect(config.urlVariable).toBe('TURSO_DATABASE_URL');
    expect(config.authToken).toBe('b');
  });

  it('falls back to a temporary database on Vercel when nothing is set', async () => {
    const config = await loadConfig({ VERCEL: '1' });
    expect(config.url).toBe('file:/tmp/build-os-radio.db');
    expect(config.urlVariable).toBeNull();
    expect(config.ephemeral).toBe(true);
  });
});

describe('database variable diagnostics', () => {
  it('lists database-ish variable names without their values', async () => {
    const { databaseVariableNames } = await import('../lib/readiness');
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      STORAGE_URL: 'libsql://secret.turso.io',
      TURSO_AUTH_TOKEN: 'super-secret-token',
      ELEVENLABS_API_KEY: 'should-not-appear',
      VERCEL_STORAGE_THING: 'build metadata noise',
      EMPTY_DATABASE_URL: '',
    };
    const names = databaseVariableNames(env);

    expect(names).toEqual(['STORAGE_URL', 'TURSO_AUTH_TOKEN']);
    // Nothing in the output may resemble a value.
    expect(names.join(' ')).not.toContain('secret.turso.io');
    expect(names.join(' ')).not.toContain('super-secret-token');
  });
});
