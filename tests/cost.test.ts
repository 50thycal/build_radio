import { describe, expect, it } from 'vitest';
import {
  checkSpendLimits,
  costForCharacters,
  estimateEpisode,
  formatDuration,
  formatUsd,
} from '../lib/cost';
import { makeDialogue, makeEpisode } from './helpers/episodes';

const rates = { usdPer1kCharacters: 0.1, charactersPerSecond: 14.2, wordsPerMinute: 136 };

describe('cost model', () => {
  it('matches the documented planning budget at known character counts', () => {
    expect(costForCharacters(15_000, rates)).toBe(1.5);
    expect(costForCharacters(17_000, rates)).toBe(1.7);
    expect(costForCharacters(18_000, rates)).toBe(1.8);
    expect(costForCharacters(20_000, rates)).toBe(2.0);
  });

  it('treats the rate as configurable rather than hardcoded', () => {
    expect(costForCharacters(17_000, { ...rates, usdPer1kCharacters: 0.05 })).toBe(0.85);
    expect(costForCharacters(17_000, { ...rates, usdPer1kCharacters: 0.22 })).toBe(3.74);
  });

  it('costs nothing for an empty script', () => {
    expect(costForCharacters(0, rates)).toBe(0);
  });

  it('estimates a 20 minute episode inside the engineering budget', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(40, 425) });
    const estimate = estimateEpisode(episode, { rates });
    expect(estimate.characters).toBeGreaterThan(16_000);
    expect(estimate.characters).toBeLessThan(18_000);
    expect(estimate.estimatedCostUsd).toBeLessThan(2);
    expect(estimate.estimatedRuntimeSeconds).toBeGreaterThan(15 * 60);
    expect(estimate.estimatedRuntimeSeconds).toBeLessThan(26 * 60);
  });

  it('estimates from the real chunk plan, so the displayed count is the billed count', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(40, 425) });
    const estimate = estimateEpisode(episode, { rates });
    const summed = estimate.chunks.reduce((sum, chunk) => sum + chunk.characters, 0);
    expect(summed).toBe(estimate.characters);
    expect(estimate.chunks).toHaveLength(estimate.chunkCount);
  });

  it('counts delivery cues as billable characters', () => {
    const plain = estimateEpisode(makeEpisode({ dialogue: [{ speaker: 'host', text: 'Really.' }] }), { rates });
    const cued = estimateEpisode(
      makeEpisode({ dialogue: [{ speaker: 'host', text: 'Really.', delivery: 'curious' }] }),
      { rates },
    );
    expect(cued.characters).toBe(plain.characters + '[curious] '.length);
  });
});

describe('spend limits', () => {
  const estimate = (characters: number, cost: number) => ({
    words: 0,
    characters,
    chunkCount: 1,
    estimatedRuntimeSeconds: 0,
    estimatedCostUsd: cost,
    chunks: [],
    rates,
  });

  it('allows a standard episode', () => {
    expect(checkSpendLimits(estimate(17_000, 1.7), { maxEpisodeCharacters: 30_000, maxEstimatedCostUsd: 3 })).toEqual({
      ok: true,
    });
  });

  it('blocks an episode over the character ceiling', () => {
    const result = checkSpendLimits(estimate(40_000, 4), { maxEpisodeCharacters: 30_000, maxEstimatedCostUsd: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('MAX_EPISODE_CHARACTERS');
  });

  it('blocks an episode over the cost ceiling', () => {
    const result = checkSpendLimits(estimate(1000, 5), { maxEpisodeCharacters: 30_000, maxEstimatedCostUsd: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('MAX_ESTIMATED_COST_USD');
  });
});

describe('formatting', () => {
  it('formats durations for the player', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(1248)).toBe('20:48');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('--:--');
  });

  it('formats costs to cents', () => {
    expect(formatUsd(1.7)).toBe('$1.70');
    expect(formatUsd(null)).toBe('—');
  });
});
