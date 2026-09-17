/**
 * Sign in. Single admin account; the password lives only in the environment.
 */
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, checkAdminPassword, createSessionToken } from '@/lib/auth';
import { authConfig } from '@/lib/config';
import { badRequest, json } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (!authConfig.adminPassword || !authConfig.sessionSecret) {
    return json(
      { error: 'Authentication is not configured. Set ADMIN_PASSWORD and SESSION_SECRET.' },
      { status: 503 },
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  let password = '';
  let redirectTo = '/';
  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as { password?: string; redirectTo?: string };
    password = body.password ?? '';
    redirectTo = body.redirectTo ?? '/';
  } else {
    const form = await request.formData();
    password = String(form.get('password') ?? '');
    redirectTo = String(form.get('redirectTo') ?? '/');
  }

  if (!password) return badRequest('Password is required');
  if (!checkAdminPassword(password)) {
    const url = new URL('/login', request.url);
    url.searchParams.set('error', '1');
    return NextResponse.redirect(url, { status: 303 });
  }

  // Only allow same-origin redirects.
  const safeRedirect = redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : '/';
  const response = NextResponse.redirect(new URL(safeRedirect, request.url), { status: 303 });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: authConfig.sessionTtlSeconds,
  });
  return response;
}
