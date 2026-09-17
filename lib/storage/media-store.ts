/**
 * Media storage boundary.
 *
 * Finished episodes are binary artefacts, not source. They never go into git.
 * Production uses Vercel Blob; local development writes into public/media so
 * the whole pipeline can be exercised with no cloud account at all.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storageConfig } from '../config';

export type StoredMedia = {
  /** Storage key, stable and derived from slug + content version. */
  key: string;
  /** URL the player can load. */
  url: string;
  size: number;
  contentType: string;
};

export class MediaStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MediaStoreError';
  }
}

export interface MediaStore {
  readonly name: string;
  put(key: string, data: Uint8Array, contentType: string): Promise<StoredMedia>;
  /** Read back a stored object. Chunk audio is read back when a job resumes in
   *  a later invocation, which is what stops us paying twice for good chunks. */
  get(keyOrUrl: string): Promise<Uint8Array>;
  remove(keyOrUrl: string): Promise<void>;
}

/** Vercel Blob. Public access with an unguessable path; see README for the
 *  private-blob alternative. */
export class VercelBlobStore implements MediaStore {
  readonly name = 'vercel-blob';
  constructor(private readonly token: string) {}

  async put(key: string, data: Uint8Array, contentType: string): Promise<StoredMedia> {
    try {
      const { put } = await import('@vercel/blob');
      const result = await put(key, Buffer.from(data), {
        access: 'public',
        token: this.token,
        contentType,
        addRandomSuffix: true,
        cacheControlMaxAge: 60 * 60 * 24 * 365,
      });
      return { key: result.pathname, url: result.url, size: data.byteLength, contentType };
    } catch (error) {
      throw new MediaStoreError(`Vercel Blob upload failed for ${key}: ${(error as Error).message}`, error);
    }
  }

  async get(keyOrUrl: string): Promise<Uint8Array> {
    try {
      const { head } = await import('@vercel/blob');
      const url = /^https?:\/\//.test(keyOrUrl)
        ? keyOrUrl
        : (await head(keyOrUrl, { token: this.token })).url;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new MediaStoreError(`Vercel Blob read failed for ${keyOrUrl}: ${(error as Error).message}`, error);
    }
  }

  async remove(keyOrUrl: string): Promise<void> {
    try {
      const { del } = await import('@vercel/blob');
      await del(keyOrUrl, { token: this.token });
    } catch (error) {
      throw new MediaStoreError(`Vercel Blob delete failed for ${keyOrUrl}: ${(error as Error).message}`, error);
    }
  }
}

/**
 * Filesystem store for local development.
 *
 * Writes to data/media rather than public/, because `next start` serves the
 * public folder from the build snapshot: a file written after the build would
 * 404. The /media route handler reads this directory at request time and
 * supports range requests, which is what mobile Safari needs to seek.
 *
 * The root is a fixed, statically analysable path so the deployment bundler
 * does not have to trace the whole project to satisfy it.
 */
export class LocalMediaStore implements MediaStore {
  readonly name = 'local';
  constructor(private readonly publicPrefix: string = storageConfig.localPublicPrefix) {}

  private resolve(key: string): string {
    const safe = key.replace(/^\/+/, '').replace(/\.\./g, '');
    return path.join(process.cwd(), 'data', 'media', safe);
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<StoredMedia> {
    const target = this.resolve(key);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    } catch (error) {
      throw new MediaStoreError(`Local media write failed for ${key}: ${(error as Error).message}`, error);
    }
    return {
      key,
      url: `${this.publicPrefix}/${key.replace(/^\/+/, '')}`,
      size: data.byteLength,
      contentType,
    };
  }

  async get(keyOrUrl: string): Promise<Uint8Array> {
    const key = keyOrUrl.startsWith(this.publicPrefix) ? keyOrUrl.slice(this.publicPrefix.length) : keyOrUrl;
    try {
      const { readFile } = await import('node:fs/promises');
      return new Uint8Array(await readFile(this.resolve(key)));
    } catch (error) {
      throw new MediaStoreError(`Local media read failed for ${keyOrUrl}: ${(error as Error).message}`, error);
    }
  }

  async remove(keyOrUrl: string): Promise<void> {
    const key = keyOrUrl.startsWith(this.publicPrefix)
      ? keyOrUrl.slice(this.publicPrefix.length)
      : keyOrUrl;
    await rm(this.resolve(key), { force: true });
  }
}

/**
 * Test double: keeps bytes in memory, no side effects.
 *
 * `addRandomSuffix` mirrors Vercel Blob, which stores an object at a pathname
 * derived from the requested key rather than at the key itself. A double that
 * always honours the requested key cannot catch code that assumes it was
 * honoured — which is exactly how a stitch that could not find its own chunks
 * reached production.
 */
export class InMemoryMediaStore implements MediaStore {
  readonly name = 'memory';
  readonly items = new Map<string, { data: Uint8Array; contentType: string }>();
  private counter = 0;

  constructor(private readonly options: { addRandomSuffix?: boolean } = {}) {}

  private storedKey(key: string): string {
    if (!this.options.addRandomSuffix) return key;
    this.counter += 1;
    const suffix = `-${this.counter.toString(36)}x7q`;
    return key.replace(/(\.[^./]+)?$/, (extension) => `${suffix}${extension}`);
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<StoredMedia> {
    const stored = this.storedKey(key);
    this.items.set(stored, { data, contentType });
    return { key: stored, url: `memory://${stored}`, size: data.byteLength, contentType };
  }

  async get(keyOrUrl: string): Promise<Uint8Array> {
    const key = keyOrUrl.replace(/^memory:\/\//, '');
    const item = this.items.get(key);
    if (!item) throw new MediaStoreError(`No object stored at ${key}`);
    return item.data;
  }

  async remove(keyOrUrl: string): Promise<void> {
    this.items.delete(keyOrUrl.replace(/^memory:\/\//, ''));
  }
}

let cached: MediaStore | null = null;

export function createMediaStore(): MediaStore {
  if (cached) return cached;
  if (storageConfig.driver === 'vercel-blob') {
    if (!storageConfig.blobToken) {
      throw new MediaStoreError('MEDIA_STORE_DRIVER=vercel-blob requires BLOB_READ_WRITE_TOKEN');
    }
    cached = new VercelBlobStore(storageConfig.blobToken);
  } else {
    cached = new LocalMediaStore();
  }
  return cached;
}

/** Storage key for a finished episode render. Content-versioned so a
 *  regeneration never silently overwrites the file a listener is streaming. */
export function episodeAudioKey(slug: string, contentVersion: string): string {
  return `episodes/${slug}/${contentVersion}.mp3`;
}

/** Storage key for a single generated chunk, kept so a failed stitch or a
 *  partial regeneration does not require re-paying for good chunks. */
export function chunkAudioKey(slug: string, contentVersion: string, chunkId: string): string {
  return `chunks/${slug}/${contentVersion}/${chunkId}.mp3`;
}
