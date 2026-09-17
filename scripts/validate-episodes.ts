#!/usr/bin/env tsx
/**
 * Validate every episode spec in the repository and print its cost plan.
 *
 * Run it before committing a spec, and in CI: a spec that fails here would
 * fail in the pipeline, only later and less legibly.
 *
 *   npm run episodes:validate
 */
import { formatDuration, formatUsd } from '../lib/cost';
import { buildRenderPlan } from '../lib/episode/service';
import { FilesystemEpisodeSource, loadAllEpisodes } from '../lib/episode/source';

async function main(): Promise<void> {
  const loaded = await loadAllEpisodes(new FilesystemEpisodeSource());
  if (loaded.length === 0) {
    console.log('No episode specs found under episodes/.');
    return;
  }

  let failures = 0;
  for (const item of loaded) {
    if (!item.ok) {
      failures += 1;
      console.error(`\n✗ ${item.path}`);
      for (const issue of item.issues) console.error(`    ${issue.path || '(root)'}: ${issue.message}`);
      continue;
    }

    const plan = buildRenderPlan(item.episode);
    console.log(`\n✓ ${item.path}`);
    console.log(`    ${item.episode.title}`);
    console.log(`    status           ${item.episode.status}`);
    console.log(`    words            ${plan.estimate.words.toLocaleString()}`);
    console.log(`    characters       ${plan.estimate.characters.toLocaleString()}`);
    console.log(`    chunks           ${plan.estimate.chunkCount}`);
    console.log(`    est. runtime     ${formatDuration(plan.estimate.estimatedRuntimeSeconds)}`);
    console.log(`    est. cost        ${formatUsd(plan.estimate.estimatedCostUsd)}`);
    console.log(`    content version  ${plan.contentVersion.slice(0, 16)}`);
    if (!plan.limits.ok) {
      failures += 1;
      console.error(`    ✗ over budget: ${plan.limits.reason}`);
    }
    if (plan.missingVoices.length > 0) {
      console.warn(`    ! no voice id for: ${plan.missingVoices.join(', ')} (set before generating)`);
    }
    for (const warning of item.warnings) {
      console.warn(`    ! ${warning.path}: ${warning.message}`);
    }
  }

  console.log(`\n${loaded.length - failures}/${loaded.length} spec(s) valid.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
