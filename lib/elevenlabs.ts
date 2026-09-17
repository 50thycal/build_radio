/**
 * ElevenLabs renderer.
 *
 * ElevenLabs is a *renderer*, not the data model: everything here takes plain
 * speaker/text pairs and returns bytes. Nothing upstream of this file knows
 * about ElevenLabs, which is what keeps the episode spec portable.
 *
 * `fetchImpl` is injectable so the whole generation pipeline can be tested
 * without a network or an API key.
 */
import { elevenLabsConfig } from './config';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DialogueInput = {
  /** Speaker key from the episode spec, carried through for observability. */
  speaker: string;
  voiceId: string;
  text: string;
};

export type GeneratedAudio = {
  audio: Uint8Array;
  /** Characters we sent — the number we bill our estimate against. */
  characters: number;
  /** Provider request id when exposed, for support tickets and debugging. */
  requestId: string | null;
  /** Provider-reported character cost when exposed. Best effort. */
  providerCharacterCost: number | null;
  latencyMs: number;
  httpStatus: number;
};

export type ProviderErrorKind =
  | 'auth'
  | 'invalid_request'
  | 'rate_limit'
  | 'timeout'
  | 'server'
  | 'network'
  | 'empty_response'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;
  /** Seconds the provider asked us to wait, when it said so. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      kind: ProviderErrorKind;
      retryable: boolean;
      status?: number | null;
      requestId?: string | null;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function classify(status: number): { kind: ProviderErrorKind; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 422 || status === 400) return { kind: 'invalid_request', retryable: false };
  if (status === 429) return { kind: 'rate_limit', retryable: true };
  if (status >= 500) return { kind: 'server', retryable: true };
  return { kind: 'unknown', retryable: false };
}

/** Header names ElevenLabs has used for usage reporting, checked in order. */
const COST_HEADERS = ['character-cost', 'x-character-cost', 'x-characters-used'];
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id'];

function headerNumber(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function headerString(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw) return raw;
  }
  return null;
}

export type ElevenLabsOptions = {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
  outputFormat?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  readonly modelId: string;
  readonly outputFormat: string;
  readonly timeoutMs: number;

  constructor(options: ElevenLabsOptions) {
    if (!options.apiKey) {
      throw new ProviderError('ELEVENLABS_API_KEY is not configured', {
        kind: 'auth',
        retryable: false,
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? elevenLabsConfig.baseUrl).replace(/\/$/, '');
    this.modelId = options.modelId ?? elevenLabsConfig.model;
    this.outputFormat = options.outputFormat ?? elevenLabsConfig.outputFormat;
    this.timeoutMs = options.timeoutMs ?? elevenLabsConfig.requestTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Render one chunk of dialogue.
   *
   * Multi-speaker chunks use Text-to-Dialogue, which is what produces natural
   * turn-taking. A chunk that happens to contain a single speaker still goes
   * through the same endpoint so the two paths cannot drift apart.
   */
  async generateDialogue(inputs: DialogueInput[]): Promise<GeneratedAudio> {
    if (inputs.length === 0) {
      throw new ProviderError('Cannot generate audio for an empty chunk', {
        kind: 'invalid_request',
        retryable: false,
      });
    }
    const missingVoice = inputs.find((input) => !input.voiceId);
    if (missingVoice) {
      throw new ProviderError(
        `No voice id configured for speaker "${missingVoice.speaker}". Set it in the episode spec or in ELEVENLABS_*_VOICE_ID.`,
        { kind: 'invalid_request', retryable: false },
      );
    }

    const url = `${this.baseUrl}/v1/text-to-dialogue?output_format=${encodeURIComponent(this.outputFormat)}`;
    const body = {
      inputs: inputs.map((input) => ({ text: input.text, voice_id: input.voiceId })),
      model_id: this.modelId,
    };
    const characters = inputs.reduce((sum, input) => sum + input.text.length, 0);
    return this.request(url, body, characters);
  }

  private async request(url: string, body: unknown, characters: number): Promise<GeneratedAudio> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      throw new ProviderError(
        aborted
          ? `ElevenLabs request timed out after ${this.timeoutMs}ms`
          : `Network failure calling ElevenLabs: ${(error as Error).message}`,
        { kind: aborted ? 'timeout' : 'network', retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const requestId = headerString(response.headers, REQUEST_ID_HEADERS);

    if (!response.ok) {
      const { kind, retryable } = classify(response.status);
      const detail = await response.text().catch(() => '');
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ProviderError(
        `ElevenLabs returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
        {
          kind,
          retryable,
          status: response.status,
          requestId,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
        },
      );
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) {
      throw new ProviderError('ElevenLabs returned an empty audio body', {
        kind: 'empty_response',
        retryable: true,
        status: response.status,
        requestId,
      });
    }

    return {
      audio,
      characters,
      requestId,
      providerCharacterCost: headerNumber(response.headers, COST_HEADERS),
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
    };
  }
}

export type RetryPolicy = {
  /** Total attempts including the first. Always finite — never a retry loop. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry with exponential backoff and jitter.
 *
 * Only errors the provider marked retryable are retried, and the attempt count
 * is hard-capped: a failing provider can never consume unlimited credits.
 */
export async function withRetries<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const sleep = policy.sleep ?? defaultSleep;
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError((error as Error).message, { kind: 'unknown', retryable: false });
      lastError = providerError;
      if (!providerError.retryable || attempt === policy.maxAttempts) throw providerError;

      const backoff = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      const jitter = Math.random() * policy.baseDelayMs;
      const delayMs = providerError.retryAfterSeconds
        ? Math.min(providerError.retryAfterSeconds * 1000, policy.maxDelayMs)
        : backoff + jitter;
      policy.onRetry?.({ attempt, delayMs, error: providerError });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new ProviderError('Retry loop exhausted', { kind: 'unknown', retryable: false });
}

/** Resolve speaker key -> voice id from the spec first, environment second. */
export function resolveVoices(
  speakers: Record<string, { name: string; voice_id: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, speaker] of Object.entries(speakers)) {
    const envKey = `ELEVENLABS_VOICE_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const fallback =
      key === 'host'
        ? env.ELEVENLABS_HOST_VOICE_ID
        : key === 'guest'
          ? env.ELEVENLABS_GUEST_VOICE_ID
          : undefined;
    resolved[key] = (speaker.voice_id || env[envKey] || fallback || '').trim();
  }
  return resolved;
}

/** Speakers with no voice id anywhere. Checked before a job is queued. */
export function missingVoices(voices: Record<string, string>): string[] {
  return Object.entries(voices)
    .filter(([, voiceId]) => !voiceId)
    .map(([key]) => key);
}
