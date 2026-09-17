/**
 * Route protection for a private application.
 *
 * Pages require a signed session cookie. API routes are deliberately excluded
 * here and authenticate themselves, because they accept a second, non-cookie
 * identity: the internal secret used by automation and by the job runner.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from './lib/auth';

const PUBLIC_PATHS = ['/login', '/favicon.ico', '/manifest.webmanifest', '/icon.svg'];

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) return NextResponse.next();

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirectTo', pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except API routes (self-authenticating), Next internals and the
  // locally served media directory.
  matcher: ['/((?!api|_next/static|_next/image|media|.*\\.(?:png|jpg|jpeg|svg|webp|ico|mp3)$).*)'],
};
