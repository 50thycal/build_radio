/**
 * Provider preflight, runnable from the phone.
 *
 * Same check as `npm run check:provider`, exposed as an endpoint so the studio
 * can run it with a tap. It sends one two-speaker exchange of about sixty
 * characters — a fraction of a cent — and reports whether the whole renderer
 * contract holds: key accepted, both voices usable, Text-to-Dialogue reachable,
 * and the returned bytes decodable by the stitcher.
 *
 * It is the cheapest way to answer "will a real episode work?", so it should be
 * the first thing run after the credentials are set.
 */
import { parseMp3 } from '@/lib/audio/mp3';
import { elevenLabsConfig } from '@/lib/config';
import { costForCharacters } from '@/lib/cost';
import { ElevenLabsClient, ProviderError, missingVoices, resolveVoices } from '@/lib/elevenlabs';
import { json } from '@/lib/http';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROBE = [
  { speaker: 'host', text: 'Quick check: can you hear me?' },
  { speaker: 'guest', text: 'Loud and clear.' },
];

/** A tiny cooldown so a stuck finger cannot loop paid requests. */
const COOLDOWN_MS = 15_000;
let lastRunAt = 0;

export async function POST(): Promise<Response> {
  const now = Date.now();
  if (now - lastRunAt < COOLDOWN_MS) {
    return json(
      {
        ok: false,
        stage: 'cooldown',
        message: `Just ran. Wait ${Math.ceil((COOLDOWN_MS - (now - lastRunAt)) / 1000)}s and try again.`,
      },
      { status: 429 },
    );
  }
  lastRunAt = now;

  const voices = resolveVoices({
    host: { name: 'Host', voice_id: '' },
    guest: { name: 'Guest', voice_id: '' },
  });

  const problems: string[] = [];
  if (!elevenLabsConfig.apiKey) problems.push('ELEVENLABS_API_KEY is not set');
  for (const key of missingVoices(voices)) {
    problems.push(`No voice id for "${key}" (set ELEVENLABS_${key.toUpperCase()}_VOICE_ID)`);
  }
  if (problems.length > 0) {
    return json({
      ok: false,
      stage: 'configuration',
      message: problems.join('; '),
      hint: 'Add these in Vercel under Settings → Environment Variables, then redeploy.',
    });
  }

  const characters = PROBE.reduce((sum, line) => sum + line.text.length, 0);
  const client = new ElevenLabsClient({ apiKey: elevenLabsConfig.apiKey });

  let generated;
  try {
    generated = await client.generateDialogue(
      PROBE.map((line) => ({ speaker: line.speaker, voiceId: voices[line.speaker], text: line.text })),
    );
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError((error as Error).message, { kind: 'unknown', retryable: false });

    // The two failures worth naming, because their fixes are different.
    const hint =
      providerError.kind === 'auth'
        ? 'The key is wrong, revoked, or lacks text-to-speech permission.'
        : providerError.kind === 'invalid_request'
          ? 'Usually a voice id that does not exist on this account, or a model that does not support Text-to-Dialogue.'
          : 'Transient provider or network problem — try again in a moment.';

    await logger.warn('preflight.failed', {
      kind: providerError.kind,
      status: providerError.status,
      requestId: providerError.requestId,
    });

    return json({
      ok: false,
      stage: 'provider',
      kind: providerError.kind,
      status: providerError.status,
      requestId: providerError.requestId,
      message: providerError.message,
      hint,
    });
  }

  let parsed;
  try {
    parsed = parseMp3(generated.audio);
  } catch (error) {
    return json({
      ok: false,
      stage: 'audio',
      message: `Audio came back but is not MP3 the stitcher can join: ${(error as Error).message}`,
      hint: 'Check ELEVENLABS_OUTPUT_FORMAT is an mp3_* format.',
    });
  }

  await logger.info('preflight.ok', {
    characters,
    bytes: generated.audio.byteLength,
    latencyMs: generated.latencyMs,
    durationSeconds: Number(parsed.durationSeconds.toFixed(2)),
  });

  return json({
    ok: true,
    stage: 'complete',
    message: 'ElevenLabs is wired up correctly.',
    model: elevenLabsConfig.model,
    outputFormat: elevenLabsConfig.outputFormat,
    characters,
    costUsd: costForCharacters(characters),
    bytes: generated.audio.byteLength,
    latencyMs: generated.latencyMs,
    requestId: generated.requestId,
    providerCharacterCost: generated.providerCharacterCost,
    durationSeconds: Number(parsed.durationSeconds.toFixed(2)),
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    // Feeds RUNTIME_CHARS_PER_SECOND once there is a real sample to learn from.
    charactersPerSecond: Number((characters / parsed.durationSeconds).toFixed(2)),
  });
}
