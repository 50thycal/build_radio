#!/usr/bin/env tsx
/**
 * Print what is configured and what is not.
 *
 * Same readiness model the deployment serves at /api/health, so the local
 * answer and the deployed answer cannot disagree.
 *
 *   npm run check:setup
 */
import './_env';

const MARK = { ok: '✓', warn: '!', missing: '✗' } as const;

async function main(): Promise<void> {
  const { evaluateReadiness, probeDatabase } = await import('../lib/readiness');
  const readiness = evaluateReadiness();

  console.log('\nBUILD OS RADIO — CONFIGURATION\n');
  for (const check of readiness.checks) {
    console.log(`${MARK[check.status]} ${check.label}`);
    console.log(`    ${check.detail}`);
    if (check.status !== 'ok') console.log(`    ${check.variables.join('  ')}`);
  }

  const database = await probeDatabase();
  console.log(`\n${database.ok ? '✓' : '✗'} Database\n    ${database.detail}`);

  console.log('\nSummary');
  console.log(`    sign in        ${readiness.canSignIn ? 'yes' : 'no'}`);
  console.log(`    generate       ${readiness.canGenerate ? 'yes' : 'no'}`);
  console.log(`    durable media  ${readiness.storageDurable ? 'yes' : 'no'}`);
  console.log(`    spec source    ${readiness.environment.episodeSource}`);
  console.log('');

  if (!readiness.canGenerate) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
