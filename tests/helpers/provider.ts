/**
 * A scripted ElevenLabs endpoint.
 *
 * The real `ElevenLabsClient` is used — only `fetch` is replaced — so request
 * shaping, error classification and retry behaviour are exercised for real.
 */
import { ElevenLabsClient, type FetchLike } from '../../lib/elevenlabs';
import { encodeTone } from './mp3-fixtures';

export type ProviderScript = {
  /** Responses to serve in order; the last one repeats. */
  responses?: ('ok' | number)[];
  /** Seconds of audio returned per call; the last value repeats. */
  durations?: number[];
  /** Advances the fake clock on every call, to test time budgeting. */
  onCall?: (call: { index: number; texts: string[]; voiceIds: string[] }) => void;
};

export type ProviderProbe = {
  client: ElevenLabsClient;
  calls: { texts: string[]; voiceIds: string[] }[];
};

export function createProviderProbe(script: ProviderScript = {}): ProviderProbe {
  const calls: { texts: string[]; voiceIds: string[] }[] = [];
  const responses = script.responses ?? ['ok'];
  const durations = script.durations ?? [0.3];

  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      inputs: { text: string; voice_id: string }[];
    };
    const index = calls.length;
    const call = {
      texts: body.inputs.map((input) => input.text),
      voiceIds: body.inputs.map((input) => input.voice_id),
    };
    calls.push(call);
    script.onCall?.({ index, ...call });

    const outcome = responses[Math.min(index, responses.length - 1)];
    if (outcome !== 'ok') {
      return new Response(JSON.stringify({ detail: `scripted failure ${outcome}` }), {
        status: outcome,
        headers: { 'request-id': `req-${index}`, 'content-type': 'application/json' },
      });
    }

    const seconds = durations[Math.min(index, durations.length - 1)];
    const audio = encodeTone(seconds, 440 + index * 20);
    return new Response(audio.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'request-id': `req-${index}` },
    });
  };

  return {
    client: new ElevenLabsClient({ apiKey: 'test-key-0123456789abcdef', fetchImpl }),
    calls,
  };
}
