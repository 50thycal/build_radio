/**
 * Local media delivery (development only).
 *
 * In production, finished audio is served straight from Blob storage and this
 * route is never hit. Locally it reads data/media, which is where the local
 * media store writes, and honours HTTP range requests — without them, mobile
 * Safari cannot seek within an episode.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReadableOptions } from 'node:stream';
import { hasValidSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toWebStream(filePath: string, options: ReadableOptions & { start?: number; end?: number }) {
  const nodeStream = createReadStream(filePath, options);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }): Promise<Response> {
  // Same privacy posture as the rest of the app: a signed session is required.
  // The audio element sends cookies on same-origin requests, so this is
  // transparent to the player.
  if (!(await hasValidSession(request))) return new Response('Unauthorized', { status: 401 });

  const { key } = await context.params;
  const relative = key.join('/');
  // Reject traversal before touching the filesystem.
  if (relative.includes('..') || path.isAbsolute(relative)) {
    return new Response('Not found', { status: 404 });
  }

  const root = path.join(process.cwd(), 'data', 'media');
  const filePath = path.join(root, relative);
  if (!filePath.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });

  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const contentType = filePath.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
  const range = request.headers.get('range');
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'content-range': `bytes */${size}` },
      });
    }
    return new Response(toWebStream(filePath, { start, end }), {
      status: 206,
      headers: {
        'content-type': contentType,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(toWebStream(filePath, {}), {
    headers: {
      'content-type': contentType,
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    },
  });
}
