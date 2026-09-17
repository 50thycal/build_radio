/**
 * libSQL connection.
 *
 * One driver covers both environments: a local `file:` database needs no setup
 * at all, and the same code talks to Turso over HTTP in production. The entry
 * point is chosen at runtime so the native bindings are never loaded in a
 * serverless function.
 */
import type { Client } from '@libsql/client';
import { dbConfig } from '../config';
import { schemaStatements } from './schema';

let clientPromise: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const url = dbConfig.url;
  const isRemote = /^(libsql|wss?|https):/.test(url);

  if (!isRemote) {
    // Local file database: make sure the directory exists first, otherwise
    // libSQL fails with an opaque SQLITE_CANTOPEN.
    const filePath = url.replace(/^file:/, '').split('?')[0];
    if (filePath && filePath !== ':memory:') {
      const { mkdir } = await import('node:fs/promises');
      const path = await import('node:path');
      await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    }
  }

  const { createClient } = isRemote
    ? await import('@libsql/client/web')
    : await import('@libsql/client');

  const client = createClient(
    isRemote ? { url, authToken: dbConfig.authToken || undefined } : { url },
  );

  for (const statement of schemaStatements()) {
    await client.execute(statement);
  }
  return client;
}

/** Shared connection. Cold start applies the schema exactly once. */
export function getDb(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

/** Used by tests to point the store at an isolated database. */
export function setDbForTesting(client: Client | null): void {
  clientPromise = client ? Promise.resolve(client) : null;
}
