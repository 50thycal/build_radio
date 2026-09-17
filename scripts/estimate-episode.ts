#!/usr/bin/env tsx
/**
 * Price a spec without touching anything.
 *
 *   npm run episodes:estimate -- <slug>
 *   npm run episodes:estimate -- <slug> --chunks   # per-chunk breakdown
 */
import './_env';

async function main(): Promise<void> {
  const [, , slug, ...flags] = process.argv;
  if (!slug) {
    console.error('Usage: npm run episodes:estimate -- <slug> [--chunks]');
    process.exit(1);
  }

  const { formatDuration, formatUsd } = await import('../lib/cost');
  const { buildRenderPlan } = await import('../lib/episode/service');
  const { FilesystemEpisodeSource, loadEpisodeBySlug } = await import('../lib/episode/source');

  const loaded = await loadEpisodeBySlug(slug, new FilesystemEpisodeSource());
  if (!loaded) {
    console.error(`No spec found for "${slug}".`);
    process.exit(1);
  }
  if (!loaded.ok) {
    for (const issue of loaded.issues) console.error(`  ${issue.path || '(root)'}: ${issue.message}`);
    process.exit(1);
  }

  const plan = buildRenderPlan(loaded.episode);
  console.log(`\n${loaded.episode.title}`);
  console.log(`Estimated runtime      ${formatDuration(plan.estimate.estimatedRuntimeSeconds)}`);
  console.log(`Words                  ${plan.estimate.words.toLocaleString()}`);
  console.log(`Characters             ${plan.estimate.characters.toLocaleString()}`);
  console.log(`Dialogue chunks        ${plan.estimate.chunkCount}`);
  console.log(`Estimated cost         ${formatUsd(plan.estimate.estimatedCostUsd)}`);
  console.log(`Rate                   $${plan.estimate.rates.usdPer1kCharacters.toFixed(3)} / 1k characters`);
  console.log(plan.limits.ok ? 'Within configured limits.' : `OVER LIMIT: ${plan.limits.reason}`);

  if (flags.includes('--chunks')) {
    console.log('');
    for (const chunk of plan.chunks) {
      console.log(
        `  ${chunk.chunkId}  ${String(chunk.characters).padStart(5)} chars  ` +
          `${formatUsd(plan.estimate.chunks[chunk.sequence].estimatedCostUsd)}  [${chunk.speakers.join(', ')}]`,
      );
    }
  }
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
