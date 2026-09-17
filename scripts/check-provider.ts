#!/usr/bin/env tsx
/**
 * Provider preflight — the smallest real test of the ElevenLabs contract.
 *
 * Sends one tiny two-speaker exchange (about 60 characters, well under a cent)
 * and verifies the whole renderer contract end to end:
 *   - the API key is accepted
 *   - both voice ids exist and are usable
 *   - Text-to-Dialogue returns audio in the format we ask for
 *   - the bytes we get back are decodable MP3 our stitcher can join
 *
 * Run this before spending real money on an episode. If it passes, the only
 * thing left to discover on a full render is pacing and cost, not whether the
 * integration works.
 *
 *   npm run check:provider
 */
import './_env';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PROBE = [
  { speaker: 'host', text: 'Quick check: can you hear me?' },
  { speaker: 'guest', text: 'Loud and clear.' },
];

async function main(): Promise<void> {
  const { elevenLabsConfig } = await import('../lib/config');
  const { ElevenLabsClient, resolveVoices, missingVoices } = await import('../lib/elevenlabs');
  type ProviderErrorShape = {
    kind?: string;
    status?: number | null;
    requestId?: string | null;
    message: string;
  };
  const { parseMp3 } = await import('../lib/audio/mp3');
  const { costForCharacters, formatUsd } = await import('../lib/cost');

  const problems: string[] = [];
  if (!elevenLabsConfig.apiKey) problems.push('ELEVENLABS_API_KEY is not set');

  const voices = resolveVoices({
    host: { name: 'Host', voice_id: '' },
    guest: { name: 'Guest', voice_id: '' },
  });
  for (const key of missingVoices(voices)) {
    problems.push(`No voice id for "${key}" (set ELEVENLABS_${key.toUpperCase()}_VOICE_ID)`);
  }

  if (problems.length > 0) {
    console.error('\nCannot run the preflight:');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error('\nAdd them to .env.local and try again.\n');
    process.exit(1);
  }

  const characters = PROBE.reduce((sum, line) => sum + line.text.length, 0);
  console.log('\nPROVIDER PREFLIGHT');
  console.log(`Endpoint      ${elevenLabsConfig.baseUrl}/v1/text-to-dialogue`);
  console.log(`Model         ${elevenLabsConfig.model}`);
  console.log(`Output        ${elevenLabsConfig.outputFormat}`);
  console.log(`Host voice    ${voices.host}`);
  console.log(`Guest voice   ${voices.guest}`);
  console.log(`Characters    ${characters} (about ${formatUsd(costForCharacters(characters))})\n`);

  const client = new ElevenLabsClient({ apiKey: elevenLabsConfig.apiKey });

  let generated;
  try {
    generated = await client.generateDialogue(
      PROBE.map((line) => ({ speaker: line.speaker, voiceId: voices[line.speaker], text: line.text })),
    );
  } catch (error) {
    const providerError = error as ProviderErrorShape;
    console.error('✗ The provider rejected the request.\n');
    console.error(`  kind     ${providerError.kind ?? 'unknown'}`);
    if (providerError.status) console.error(`  status   ${providerError.status}`);
    if (providerError.requestId) console.error(`  request  ${providerError.requestId}`);
    console.error(`  message  ${providerError.message}\n`);

    // The two failures worth naming, because their fixes are different.
    if (providerError.kind === 'auth') {
      console.error('  The key is wrong, revoked, or lacks text-to-speech permission.\n');
    } else if (providerError.kind === 'invalid_request') {
      console.error(
        '  Usually a voice id that does not exist on this account, or a model that\n' +
          '  does not support Text-to-Dialogue. Check both, then re-run.\n',
      );
    }
    process.exit(1);
  }

  console.log('✓ Provider accepted the request');
  console.log(`  bytes         ${generated.audio.byteLength.toLocaleString()}`);
  console.log(`  latency       ${generated.latencyMs} ms`);
  console.log(`  request id    ${generated.requestId ?? '(not exposed)'}`);
  console.log(
    `  usage header  ${generated.providerCharacterCost ?? '(not exposed — estimates will use our own count)'}`,
  );

  let parsed;
  try {
    parsed = parseMp3(generated.audio);
  } catch (error) {
    console.error(`\n✗ The audio came back but is not MP3 our stitcher can join: ${(error as Error).message}`);
    console.error('  Check ELEVENLABS_OUTPUT_FORMAT is an mp3_* format.\n');
    process.exit(1);
  }

  console.log('\n✓ Audio is decodable and joinable');
  console.log(`  duration      ${parsed.durationSeconds.toFixed(2)}s`);
  console.log(`  sample rate   ${parsed.sampleRate} Hz`);
  console.log(`  channels      ${parsed.channels}`);
  console.log(`  frames        ${parsed.frames.length}`);
  console.log(`  chars/second  ${(characters / parsed.durationSeconds).toFixed(2)}`);

  const outputDirectory = path.join(process.cwd(), 'out');
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'preflight.mp3');
  await writeFile(outputPath, generated.audio);

  console.log(`\nSaved ${outputPath} — listen to confirm the two voices are distinct.`);
  console.log('If that sounds right, the integration works. Next:');
  console.log('  npm run generate:local -- pipeline-that-pays-for-itself\n');
}

main().catch((error) => {
  console.error(`\n${error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
  process.exit(1);
});
