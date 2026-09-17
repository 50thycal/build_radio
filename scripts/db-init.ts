#!/usr/bin/env tsx
/**
 * Create (or verify) the operational database and print what is in it.
 *
 *   npm run db:init
 *
 * Safe to run repeatedly: every statement is CREATE ... IF NOT EXISTS. Works
 * against a local file database and against Turso, whichever DATABASE_URL says.
 */
import './_env';

async function main(): Promise<void> {
  const { dbConfig } = await import('../lib/config');
  const { getDb } = await import('../lib/db/client');

  console.log(`Connecting to ${dbConfig.url.replace(/authToken=[^&]+/, 'authToken=***')}`);
  const db = await getDb();

  const tables = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  console.log('\nTables:');
  for (const row of tables.rows) {
    const name = String(row.name);
    const count = await db.execute(`SELECT COUNT(*) AS n FROM ${name}`);
    console.log(`  ${name.padEnd(22)} ${String(count.rows[0].n).padStart(5)} row(s)`);
  }
  console.log('\nSchema is up to date.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
