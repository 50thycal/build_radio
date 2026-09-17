/**
 * Machine authentication.
 *
 * There is no human sign-in: this is a single-owner application and the browser
 * side is deliberately open. Two machine trust paths remain, and both still
 * matter because both can cause work to happen:
 *
 *   1. internal callers — bearer token, used by the GitHub Action and by the
 *      job runner when it calls itself to continue a long render
 *   2. GitHub webhooks  — HMAC signature over the raw body
 *
 * Implemented with Web Crypto so the same code runs in any runtime.
 */
import { authConfig } from './config';

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Constant-time comparison; length is not treated as secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------- internal callers */

/**
 * Machine-to-machine auth for the worker endpoint.
 *
 * Accepts `Authorization: Bearer <secret>` or `x-internal-secret`.
 */
export function verifyInternalSecret(request: Request, secret: string = authConfig.internalSecret): boolean {
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const alternative = request.headers.get('x-internal-secret')?.trim() ?? '';
  return (
    (bearer !== '' && timingSafeEqual(bearer, secret)) ||
    (alternative !== '' && timingSafeEqual(alternative, secret))
  );
}

/* ------------------------------------------------------------- webhooks */

/**
 * Verify a GitHub webhook signature over the exact raw body.
 *
 * The body must be the unparsed string: re-serialising JSON changes bytes and
 * invalidates the signature.
 */
export async function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string = authConfig.githubWebhookSecret,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected = `sha256=${toHex(await hmac(secret, rawBody))}`;
  return timingSafeEqual(signatureHeader, expected);
}
