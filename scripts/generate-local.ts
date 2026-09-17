#!/usr/bin/env tsx
/**
 * Milestone one, on your machine: spec -> chunks -> ElevenLabs -> stitched MP3.
 *
 * This is the script to run first, before deploying anything. It uses the same
 * chunker, the same client and the same stitcher as production, but writes to
 * ./out instead of Blob storage and keeps no database state — so a failure here
 * is a failure in the pipeline, not in the plumbing around it.
 *
 *   npm run generate:local -- <slug>            # render
 *   npm run generate:local -- <slug> --dry-run  # plan and price only
 *
 * Requires ELEVENLABS_API_KEY and voice ids in .env.local.
 */
import './_env';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function main(): Promise<void> {
  const [, , slugArg, ...flags] = process.argv;
  const dryRun = flags.includes('--dry-run');
  if (!slugArg) {
    console.error('Usage: npm run generate:local -- <slug> [--dry-run]');
    process.exit(1);
  }

  // Imported after .env is loaded, because config snapshots the environment.
  const { formatDuration, formatUsd } = await import('../lib/cost');
  const { buildRenderPlan } = await import('../lib/episode/service');
  const { FilesystemEpisodeSource, loadEpisodeBySlug } = await import('../lib/episode/source');
  const { ElevenLabsClient, withRetries } = await import('../lib/elevenlabs');
  const { Mp3Stitcher } = await import('../lib/audio/stitcher');
  const { elevenLabsConfig, safetyConfig } = await import('../lib/config');

  const loaded = await loadEpisodeBySlug(slugArg, new FilesystemEpisodeSource());
  if (!loaded) {
    console.error(`No spec found at episodes/drafts/${slugArg}.json or episodes/published/${slugArg}.json`);
    process.exit(1);
  }
  if (!loaded.ok) {
    console.error(`Invalid spec ${loaded.path}:`);
    for (const issue of loaded.issues) console.error(`  ${issue.path || '(root)'}: ${issue.message}`);
    process.exit(1);
  }

  const plan = buildRenderPlan(loaded.episode);

  console.log('\nREADY TO GENERATE');
  console.log(loaded.episode.title);
  console.log(`Estimated runtime      ${formatDuration(plan.estimate.estimatedRuntimeSeconds)}`);
  console.log(`Words                  ${plan.estimate.words.toLocaleString()}`);
  console.log(`Characters             ${plan.estimate.characters.toLocaleString()}`);
  console.log(`Dialogue chunks        ${plan.estimate.chunkCount}`);
  console.log(`Estimated cost         ${formatUsd(plan.estimate.estimatedCostUsd)}`);
  console.log(`Content version        ${plan.contentVersion.slice(0, 16)}\n`);

  if (!plan.limits.ok) {
    console.error(`Refusing to generate: ${plan.limits.reason}`);
    process.exit(1);
  }
  if (dryRun) {
    plan.chunks.forEach((chunk) => {
      console.log(
        `  ${chunk.chunkId}  ${String(chunk.characters).padStart(5)} chars  ` +
          `lines ${chunk.lineRange[0]}-${chunk.lineRange[1]}  [${chunk.speakers.join(', ')}]`,
      );
    });
    console.log('\nDry run: nothing was sent to the provider.');
    return;
  }
  if (plan.missingVoices.length > 0) {
    console.error(`No voice id for: ${plan.missingVoices.join(', ')}.`);
    console.error('Set ELEVENLABS_HOST_VOICE_ID / ELEVENLABS_GUEST_VOICE_ID in .env.local.');
    process.exit(1);
  }
  if (!elevenLabsConfig.apiKey) {
    console.error('ELEVENLABS_API_KEY is not set. Add it to .env.local.');
    process.exit(1);
  }

  const client = new ElevenLabsClient({ apiKey: elevenLabsConfig.apiKey });
  const parts: { chunkId: string; sequence: number; data: Uint8Array }[] = [];
  let characters = 0;
  const startedAt = Date.now();

  for (const chunk of plan.chunks) {
    process.stdout.write(`  ${chunk.chunkId} (${chunk.characters} chars) … `);
    const generated = await withRetries(
      () =>
        client.generateDialogue(
          chunk.segments.map((segment) => ({
            speaker: segment.speaker,
            voiceId: plan.voices[segment.speaker],
            text: segment.text,
          })),
        ),
      { maxAttempts: safetyConfig.maxAttemptsPerChunk, baseDelayMs: 1000, maxDelayMs: 15_000 },
    );
    characters += generated.characters;
    parts.push({ chunkId: chunk.chunkId, sequence: chunk.sequence, data: generated.audio });
    console.log(`${(generated.audio.byteLength / 1024).toFixed(0)} KB in ${generated.latencyMs} ms`);
  }

  const stitched = await new Mp3Stitcher().stitch(parts);
  const outputDirectory = path.join(process.cwd(), 'out');
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${loaded.episode.slug}.mp3`);
  await writeFile(outputPath, stitched.data);

  const { costForCharacters } = await import('../lib/cost');
  console.log('\nGENERATED');
  console.log(`File                   ${outputPath}`);
  console.log(`Actual characters      ${characters.toLocaleString()}`);
  console.log(`Chunks                 ${parts.length}`);
  console.log(`Final duration         ${formatDuration(stitched.durationSeconds)}`);
  console.log(`Estimated runtime was  ${formatDuration(plan.estimate.estimatedRuntimeSeconds)}`);
  console.log(`Estimated cost         ${formatUsd(plan.estimate.estimatedCostUsd)}`);
  console.log(`Cost at actual chars   ${formatUsd(costForCharacters(characters))}`);
  console.log(`Wall clock             ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`Chars per second       ${(characters / stitched.durationSeconds).toFixed(2)} (tune RUNTIME_CHARS_PER_SECOND)\n`);
}

main().catch((error) => {
  console.error(`\n${error?.name ?? 'Error'}: ${error?.message ?? error}`);
  process.exit(1);
});
