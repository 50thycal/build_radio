#!/usr/bin/env tsx
/**
 * Flip a draft to ready_for_audio — the one edit that authorises spending.
 *
 *   npm run episodes:publish -- <slug>            # mark ready for audio
 *   npm run episodes:publish -- <slug> --draft    # put it back to draft
 *
 * The file is rewritten in place and left for you to commit: GitHub stays the
 * ledger, and the commit is the audit trail of who authorised the render.
 */
import './_env';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FOLDERS = ['drafts', 'published'] as const;

async function findSpec(slug: string): Promise<string | null> {
  for (const folder of FOLDERS) {
    const candidate = path.join(process.cwd(), 'episodes', folder, `${slug}.json`);
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const [, , slug, ...flags] = process.argv;
  if (!slug) {
    console.error('Usage: npm run episodes:publish -- <slug> [--draft]');
    process.exit(1);
  }
  const target = flags.includes('--draft') ? 'draft' : 'ready_for_audio';

  const specPath = await findSpec(slug);
  if (!specPath) {
    console.error(`No spec found for "${slug}" under episodes/drafts or episodes/published.`);
    process.exit(1);
  }

  const raw = await readFile(specPath, 'utf8');
  const { validateEpisode } = await import('../lib/episode/schema');
  const { buildRenderPlan } = await import('../lib/episode/service');
  const { formatDuration, formatUsd } = await import('../lib/cost');

  const parsed = validateEpisode(JSON.parse(raw));
  if (!parsed.ok) {
    console.error(`Refusing to publish an invalid spec (${specPath}):`);
    for (const issue of parsed.issues) console.error(`  ${issue.path || '(root)'}: ${issue.message}`);
    process.exit(1);
  }

  const plan = buildRenderPlan(parsed.episode);
  if (target === 'ready_for_audio' && !plan.limits.ok) {
    console.error(`Refusing to publish: ${plan.limits.reason}`);
    process.exit(1);
  }

  // Rewrite only the status field, preserving the author's formatting elsewhere.
  const updated = JSON.stringify({ ...parsed.episode, status: target }, null, 2);
  await writeFile(specPath, `${updated}\n`);

  console.log(`${specPath}`);
  console.log(`  status           ${parsed.episode.status} -> ${target}`);
  console.log(`  characters       ${plan.estimate.characters.toLocaleString()}`);
  console.log(`  chunks           ${plan.estimate.chunkCount}`);
  console.log(`  est. runtime     ${formatDuration(plan.estimate.estimatedRuntimeSeconds)}`);
  console.log(`  est. cost        ${formatUsd(plan.estimate.estimatedCostUsd)}`);
  if (target === 'ready_for_audio') {
    console.log('\nCommit and push to trigger generation:');
    console.log(`  git add ${path.relative(process.cwd(), specPath)} && git commit -m "Publish ${slug}" && git push`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
