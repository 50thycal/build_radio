/**
 * Small HTTP helpers shared by the route handlers.
 */
export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(init.headers ?? {}) },
  });
}

export function unauthorized(message = 'Unauthorized'): Response {
  return json({ error: message }, { status: 401 });
}

export function badRequest(message: string, detail?: unknown): Response {
  return json({ error: message, detail }, { status: 400 });
}

export function serverError(message: string): Response {
  return json({ error: message }, { status: 500 });
}
