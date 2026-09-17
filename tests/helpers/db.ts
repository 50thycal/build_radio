/**
 * Isolated in-memory database per test.
 *
 * The store is exercised for real — same SQL, same constraints — so the
 * idempotency and state-transition tests prove the production behaviour rather
 * than a mock of it.
 */
import { createClient, type Client } from '@libsql/client';
import { setDbForTesting } from '../../lib/db/client';
import { schemaStatements } from '../../lib/db/schema';

export async function useTestDb(): Promise<Client> {
  const client = createClient({ url: ':memory:' });
  for (const statement of schemaStatements()) await client.execute(statement);
  setDbForTesting(client);
  return client;
}

export function resetTestDb(): void {
  setDbForTesting(null);
}
