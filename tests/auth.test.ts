import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature, verifyInternalSecret } from '../lib/auth';

/**
 * There is no human sign-in to test: the browser side is open by design.
 * What remains are the two machine paths, and both still gate work that
 * spends money or acts on the repository.
 */

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

  it('rejects a token of the same length but different content', () => {
    expect(verifyInternalSecret(make({ authorization: 'Bearer test-internal-secreT' }), 'test-internal-secret')).toBe(
      false,
    );
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
