/**
 * Cost and runtime estimation.
 *
 * These are *planning* numbers, never billing truth. The provider's reported
 * usage, when available, always wins and is stored separately as actual cost.
 *
 * Calibration target for a standard Build OS Radio episode:
 *   ~17,000 characters -> ~20 minutes -> ~$1.70
 */
import { chunkEpisode, chunkPlanCharacters, type DialogueChunk } from './chunking';
import { costConfig, safetyConfig } from './config';
import { episodeWordCount, type EpisodeSpec } from './episode/schema';

export type CostRates = {
  usdPer1kCharacters: number;
  charactersPerSecond: number;
  wordsPerMinute: number;
};

export function defaultRates(): CostRates {
  return {
    usdPer1kCharacters: costConfig.usdPer1kCharacters,
    charactersPerSecond: costConfig.charactersPerSecond,
    wordsPerMinute: costConfig.wordsPerMinute,
  };
}

/** Round to whole cents so displayed and stored costs agree. */
export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function costForCharacters(characters: number, rates: CostRates = defaultRates()): number {
  if (characters <= 0) return 0;
  return roundUsd((characters / 1000) * rates.usdPer1kCharacters);
}

/** Unrounded cost, used when summing many chunks to avoid rounding drift. */
export function rawCostForCharacters(characters: number, rates: CostRates = defaultRates()): number {
  if (characters <= 0) return 0;
  return (characters / 1000) * rates.usdPer1kCharacters;
}

export type ChunkEstimate = {
  chunkId: string;
  sequence: number;
  characters: number;
  estimatedCostUsd: number;
};

export type EpisodeEstimate = {
  words: number;
  characters: number;
  chunkCount: number;
  estimatedRuntimeSeconds: number;
  estimatedCostUsd: number;
  chunks: ChunkEstimate[];
  rates: CostRates;
};

/**
 * Estimate an episode using the real chunk plan, so the chunk count shown to
 * the user is the chunk count that will actually be generated.
 */
export function estimateEpisode(
  episode: EpisodeSpec,
  options: { rates?: CostRates; chunks?: DialogueChunk[] } = {},
): EpisodeEstimate {
  const rates = options.rates ?? defaultRates();
  const chunks = options.chunks ?? chunkEpisode(episode);
  const characters = chunkPlanCharacters(chunks);
  const words = episodeWordCount(episode);

  const bySpeakingRate = characters / Math.max(rates.charactersPerSecond, 0.1);
  const byWordRate = (words / Math.max(rates.wordsPerMinute, 1)) * 60;
  // Average the two independent estimators; they disagree by <10% in practice.
  const estimatedRuntimeSeconds = Math.round(words > 0 ? (bySpeakingRate + byWordRate) / 2 : bySpeakingRate);

  return {
    words,
    characters,
    chunkCount: chunks.length,
    estimatedRuntimeSeconds,
    estimatedCostUsd: roundUsd(rawCostForCharacters(characters, rates)),
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      sequence: chunk.sequence,
      characters: chunk.characters,
      estimatedCostUsd: roundUsd(rawCostForCharacters(chunk.characters, rates)),
    })),
    rates,
  };
}

export type GuardLimits = {
  maxEpisodeCharacters: number;
  maxEstimatedCostUsd: number;
};

export function defaultLimits(): GuardLimits {
  return {
    maxEpisodeCharacters: safetyConfig.maxEpisodeCharacters,
    maxEstimatedCostUsd: safetyConfig.maxEstimatedCostUsd,
  };
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Hard spend protection, evaluated before any paid request is issued. */
export function checkSpendLimits(estimate: EpisodeEstimate, limits: GuardLimits = defaultLimits()): GuardResult {
  if (estimate.characters > limits.maxEpisodeCharacters) {
    return {
      ok: false,
      reason: `Episode is ${estimate.characters.toLocaleString()} characters, above the configured maximum of ${limits.maxEpisodeCharacters.toLocaleString()} (MAX_EPISODE_CHARACTERS)`,
    };
  }
  if (estimate.estimatedCostUsd > limits.maxEstimatedCostUsd) {
    return {
      ok: false,
      reason: `Estimated cost $${estimate.estimatedCostUsd.toFixed(2)} is above the configured maximum of $${limits.maxEstimatedCostUsd.toFixed(2)} (MAX_ESTIMATED_COST_USD)`,
    };
  }
  return { ok: true };
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '--:--';
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(rest).padStart(2, '0')}`
    : `${mm}:${String(rest).padStart(2, '0')}`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}
