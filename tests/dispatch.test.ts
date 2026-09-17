import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDb, useTestDb } from './helpers/db';

/**
 * A job that is queued but never poked is the worst failure this system has:
 * the studio reports "queued", nothing is spent, nothing happens, and there is
 * no error anywhere to explain it. That is precisely what a fire-and-forget
 * dispatch produces on a platform that freezes an instance the moment its
 * handler returns.
 *
 * These tests pin the two properties that prevent it: the dispatcher waits for
 * an acknowledgement, and it reports the truth about what happened.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadDispatch(env: Record<string, string> = {}) {
  process.env = { ...ORIGINAL_ENV, INTERNAL_GENERATION_SECRET: 'test-secret', APP_BASE_URL: 'https://radio.test', ...env };
  vi.resetModules();
  return import('../lib/jobs/dispatch');
}

describe('job dispatch', () => {
  beforeEach(async () => {
    await useTestDb();
  });

  afterEach(() => {
    resetTestDb();
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('waits for the worker to acknowledge before returning', async () => {
    let settled = false;
    vi.stubGlobal('fetch', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled = true;
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
    });

    const { triggerJobRun } = await loadDispatch();
    const result = await triggerJobRun('job-1');

    // The whole point: the call did not return before the request completed.
    expect(settled).toBe(true);
    expect(result.dispatched).toBe(true);
  });

  it('sends the job id and the internal secret to the worker', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 202 });
    });

    const { triggerJobRun } = await loadDispatch();
    await triggerJobRun('job-42');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://radio.test/api/jobs/run');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer test-secret');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ jobId: 'job-42' });
  });

  it('reports a rejected poke as undispatched rather than silently succeeding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }));

    const { triggerJobRun } = await loadDispatch();
    const result = await triggerJobRun('job-2');

    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('401');
  });

  it('reports a transport failure as undispatched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });

    const { triggerJobRun } = await loadDispatch();
    const result = await triggerJobRun('job-3');

    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('gives up on a worker that never answers, instead of hanging the caller', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    );

    const { triggerJobRun } = await loadDispatch({ DISPATCH_ACK_TIMEOUT_MS: '50' });
    const result = await triggerJobRun('job-4');

    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('did not acknowledge');
  });

  it('refuses to claim dispatch when there is no internal secret', async () => {
    const { triggerJobRun } = await loadDispatch({ INTERNAL_GENERATION_SECRET: '' });
    const result = await triggerJobRun('job-5');

    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('INTERNAL_GENERATION_SECRET');
  });
});
