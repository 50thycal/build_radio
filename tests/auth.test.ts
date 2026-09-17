import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  checkAdminPassword,
  createSessionToken,
  hasValidSession,
  verifyGitHubSignature,
  verifyInternalSecret,
  verifySessionToken,
} from '../lib/auth';

const SECRET = 'test-session-secret-value';

describe('sessions', () => {
  it('round-trips a signed session', async () => {
    const token = await createSessionToken(60, SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe(true);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await createSessionToken(60, 'a-different-secret');
    expect(await verifySessionToken(token, SECRET)).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const token = await createSessionToken(60, SECRET);
    const [body, signature] = token.split('.');
    expect(await verifySessionToken(`${body}x.${signature}`, SECRET)).toBe(false);
  });

  it('rejects an expired session', async () => {
    const token = await createSessionToken(-10, SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe(false);
  });

  it('rejects missing or malformed tokens', async () => {
    expect(await verifySessionToken(undefined, SECRET)).toBe(false);
    expect(await verifySessionToken('', SECRET)).toBe(false);
    expect(await verifySessionToken('no-dot-here', SECRET)).toBe(false);
  });

  it('reads the session from a cookie header', async () => {
    const token = await createSessionToken(60, SECRET);
    const request = new Request('https://example.test/', {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${token}; another=2` },
    });
    expect(await hasValidSession(request)).toBe(true);
    expect(await hasValidSession(new Request('https://example.test/'))).toBe(false);
  });

  it('checks the admin password without leaking length by early exit', () => {
    expect(checkAdminPassword('test-admin-password')).toBe(true);
    expect(checkAdminPassword('wrong')).toBe(false);
    expect(checkAdminPassword('')).toBe(false);
  });
});

describe('internal secret', () => {
  const make = (headers: Record<string, string>) => new Request('https://example.test/', { headers });

  it('accepts a correct bearer token', () => {
    expect(verifyInternalSecret(make({ authorization: 'Bearer test-internal-secret' }), 'test-internal-secret')).toBe(
      true,
    );
  });

  it('accepts the header alternative', () => {
    expect(verifyInternalSecret(make({ 'x-internal-secret': 'test-internal-secret' }), 'test-internal-secret')).toBe(
      true,
    );
  });

  it('rejects a wrong or absent token', () => {
    expect(verifyInternalSecret(make({ authorization: 'Bearer nope' }), 'test-internal-secret')).toBe(false);
    expect(verifyInternalSecret(make({}), 'test-internal-secret')).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(verifyInternalSecret(make({ authorization: 'Bearer anything' }), '')).toBe(false);
  });
});

describe('github webhook signatures', () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] });

  async function sign(payload: string, key: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payload)));
    return `sha256=${Array.from(signature)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
  }

  it('accepts a correct signature', async () => {
    expect(await verifyGitHubSignature(body, await sign(body, secret), secret)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', async () => {
    expect(await verifyGitHubSignature(body, await sign(body, 'attacker'), secret)).toBe(false);
  });

  it('rejects a signature for a different body', async () => {
    expect(await verifyGitHubSignature('{"ref":"refs/heads/other"}', await sign(body, secret), secret)).toBe(false);
  });

  it('rejects a missing or malformed signature header', async () => {
    expect(await verifyGitHubSignature(body, null, secret)).toBe(false);
    expect(await verifyGitHubSignature(body, 'sha1=deadbeef', secret)).toBe(false);
    expect(await verifyGitHubSignature(body, 'garbage', secret)).toBe(false);
  });

  it('rejects everything when no secret is configured', async () => {
    expect(await verifyGitHubSignature(body, await sign(body, secret), '')).toBe(false);
  });
});
