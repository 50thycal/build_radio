import { describe, expect, it } from 'vitest';
import { chunkEpisode, renderLineText, splitLine, splitSentences, toSegments } from '../lib/chunking';
import { makeDialogue, makeEpisode } from './helpers/episodes';

const LIMIT = 2000;

describe('sentence splitting', () => {
  it('keeps terminal punctuation with its sentence', () => {
    expect(splitSentences('One thing. Then another! And a third?')).toEqual([
      'One thing.',
      'Then another!',
      'And a third?',
    ]);
  });

  it('does not split after a common abbreviation', () => {
    expect(splitSentences('We asked Dr. Chen about it. She agreed.')).toEqual([
      'We asked Dr. Chen about it.',
      'She agreed.',
    ]);
  });

  it('does not split after a single initial', () => {
    expect(splitSentences('It was J. Smith who noticed. Then we checked.')).toEqual([
      'It was J. Smith who noticed.',
      'Then we checked.',
    ]);
  });
});

describe('line splitting', () => {
  it('returns a short line untouched', () => {
    expect(splitLine('Hello there.', LIMIT)).toEqual([{ text: 'Hello there.', boundary: 'turn' }]);
  });

  it('prefers paragraph boundaries', () => {
    const paragraph = `${'a'.repeat(1200)}.`;
    const parts = splitLine(`${paragraph}\n\n${paragraph}`, LIMIT);
    expect(parts).toHaveLength(2);
    expect(parts[0].boundary).toBe('paragraph');
    expect(parts.every((part) => part.text.length <= LIMIT)).toBe(true);
  });

  it('falls back to sentence boundaries inside one paragraph', () => {
    const sentence = `${'word '.repeat(80).trim()}.`;
    const text = Array.from({ length: 10 }, () => sentence).join(' ');
    const parts = splitLine(text, LIMIT);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(LIMIT);
      // Never cut mid-sentence: every piece ends on terminal punctuation.
      expect(part.text.trim().endsWith('.')).toBe(true);
    }
  });

  it('cuts on word boundaries only when a single sentence is too long', () => {
    const runOn = `${'word '.repeat(600).trim()}.`;
    const parts = splitLine(runOn, LIMIT);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((part) => part.boundary === 'word')).toBe(true);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(LIMIT);
      expect(part.text.startsWith(' ')).toBe(false);
    }
  });

  it('preserves the full text across a split', () => {
    const runOn = `${'alpha beta gamma '.repeat(300).trim()}.`;
    const rejoined = splitLine(runOn, LIMIT)
      .map((part) => part.text)
      .join(' ');
    expect(rejoined.replace(/\s+/g, ' ')).toBe(runOn.replace(/\s+/g, ' '));
  });
});

describe('delivery cues', () => {
  it('prefixes a delivery cue so its characters are billed', () => {
    expect(renderLineText({ speaker: 'host', text: 'Really?', delivery: 'curious' })).toBe('[curious] Really?');
  });

  it('does not double-apply a cue the author already inlined', () => {
    expect(renderLineText({ speaker: 'host', text: '[laughing] No way.', delivery: 'curious' })).toBe(
      '[laughing] No way.',
    );
  });
});

describe('episode chunking', () => {
  it('keeps a short episode in a single chunk', () => {
    const chunks = chunkEpisode(makeEpisode());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkId).toBe('chunk-001');
    expect(chunks[0].speakers).toEqual(['host', 'guest']);
  });

  it('splits a full-length episode into several sub-limit chunks', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(40, 430) });
    const chunks = chunkEpisode(episode);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.characters).toBeLessThanOrEqual(LIMIT);
  });

  it('never exceeds the limit unless one word is indivisible', () => {
    const episode = makeEpisode({
      dialogue: [{ speaker: 'host', text: 'x'.repeat(5000) }],
    });
    const chunks = chunkEpisode(episode);
    for (const chunk of chunks) expect(chunk.characters).toBeLessThanOrEqual(LIMIT);
  });

  it('preserves dialogue order exactly', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(30, 500) });
    const chunks = chunkEpisode(episode);
    const flattened = chunks.flatMap((chunk) => chunk.segments);
    for (let i = 1; i < flattened.length; i += 1) {
      const previous = flattened[i - 1];
      const current = flattened[i];
      const inOrder =
        current.lineIndex > previous.lineIndex ||
        (current.lineIndex === previous.lineIndex && current.partIndex === previous.partIndex + 1);
      expect(inOrder).toBe(true);
    }
    expect(chunks.map((chunk) => chunk.sequence)).toEqual(chunks.map((_, index) => index));
  });

  it('keeps every segment mapped to the speaker who said it', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(20, 900) });
    for (const segment of toSegments(episode)) {
      expect(segment.speaker).toBe(episode.dialogue[segment.lineIndex].speaker);
    }
  });

  it('reproduces the dialogue when segments are rejoined in order', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(12, 1500) });
    const rejoined = new Map<number, string>();
    for (const segment of toSegments(episode)) {
      rejoined.set(segment.lineIndex, `${rejoined.get(segment.lineIndex) ?? ''} ${segment.text}`.trim());
    }
    episode.dialogue.forEach((line, index) => {
      expect(rejoined.get(index)?.replace(/\s+/g, ' ')).toBe(line.text.replace(/\s+/g, ' '));
    });
  });

  it('never splits a speaker turn across two chunks without keeping the speaker', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(8, 1800) });
    for (const chunk of chunkEpisode(episode)) {
      for (const segment of chunk.segments) {
        expect(chunk.speakers).toContain(segment.speaker);
      }
    }
  });

  it('folds a runt tail chunk into its predecessor', () => {
    const episode = makeEpisode({
      dialogue: [
        { speaker: 'host', text: 'a'.repeat(900) },
        { speaker: 'guest', text: 'Short closer.' },
      ],
    });
    const chunks = chunkEpisode(episode);
    expect(chunks).toHaveLength(1);
  });

  it('honours an explicit smaller limit', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(10, 400) });
    const chunks = chunkEpisode(episode, { maxCharactersPerChunk: 500, minCharactersPerChunk: 100 });
    for (const chunk of chunks) expect(chunk.characters).toBeLessThanOrEqual(500);
    expect(chunks.length).toBeGreaterThan(4);
  });

  it('produces roughly nine chunks for a standard 17,000 character episode', () => {
    const episode = makeEpisode({ dialogue: makeDialogue(40, 425) });
    const chunks = chunkEpisode(episode);
    const characters = chunks.reduce((sum, chunk) => sum + chunk.characters, 0);
    expect(characters).toBeGreaterThan(16_000);
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    expect(chunks.length).toBeLessThanOrEqual(11);
  });
});
