/**
 * Authentication for a private, single-owner application.
 *
 * Three independent trust paths, deliberately kept separate:
 *   1. a human session   — signed cookie, used by the player and admin UI
 *   2. an internal caller — bearer token, used by the GitHub Action and by the
 *                           job runner calling itself to continue a long render
 *   3. GitHub webhooks    — HMAC signature over the raw body
 *
 * Implemented entirely with Web Crypto so the same code runs in middleware
 * (edge) and in route handlers (node) without a second implementation.
 */
import { authConfig } from './config';

export const SESSION_COOKIE = 'bor_session';

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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

/* -------------------------------------------------------------- sessions */

export type SessionPayload = { exp: number };

export async function createSessionToken(
  ttlSeconds: number = authConfig.sessionTtlSeconds,
  secret: string = authConfig.sessionSecret,
): Promise<string> {
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const payload: SessionPayload = { exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, body));
  return `${body}.${signature}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  secret: string = authConfig.sessionSecret,
): Promise<boolean> {
  if (!token || !secret) return false;
  const [body, signature] = token.split('.');
  if (!body || !signature) return false;
  const expected = base64UrlEncode(await hmac(secret, body));
  if (!timingSafeEqual(signature, expected)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as SessionPayload;
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Password check for the single admin account. */
export function checkAdminPassword(candidate: string): boolean {
  const expected = authConfig.adminPassword;
  if (!expected) return false;
  return timingSafeEqual(candidate, expected);
}

export async function hasValidSession(request: Request): Promise<boolean> {
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySessionToken(match?.[1]);
}

/* ------------------------------------------------------- internal callers */

/**
 * Machine-to-machine auth for endpoints that can spend money.
 *
 * Accepts `Authorization: Bearer <secret>` or `x-internal-secret`.
 */
export function verifyInternalSecret(request: Request, secret: string = authConfig.internalSecret): boolean {
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const alternative = request.headers.get('x-internal-secret')?.trim() ?? '';
  return (bearer !== '' && timingSafeEqual(bearer, secret)) || (alternative !== '' && timingSafeEqual(alternative, secret));
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
