/**
 * Speaker-aware chunking.
 *
 * A 20 minute episode is ~17,000 characters. Sending that as one request is
 * unreliable and unrecoverable, so the script is split into small requests that
 * ElevenLabs Text-to-Dialogue can render well.
 *
 * Boundary preference, strongest first:
 *   1. speaker-turn boundaries  (never merge two halves of different turns)
 *   2. paragraph boundaries     (blank line inside one turn)
 *   3. sentence boundaries      (terminal punctuation)
 *   4. word boundaries          (only when a single sentence exceeds the limit)
 *
 * Invariants guaranteed by this module and asserted in tests:
 *   - concatenating every segment's text in order reproduces the dialogue
 *   - every segment carries the speaker key of the line it came from
 *   - no chunk exceeds the configured limit unless one indivisible word does
 */
import { chunkConfig } from './config';
import type { DialogueLine, EpisodeSpec } from './episode/schema';

export type SegmentBoundary = 'turn' | 'paragraph' | 'sentence' | 'word';

export type DialogueSegment = {
  /** Index into `episode.dialogue`. */
  lineIndex: number;
  /** 0-based index of this piece within its dialogue line. */
  partIndex: number;
  partCount: number;
  speaker: string;
  /** Exactly the text that will be sent to the provider, cues included. */
  text: string;
  characters: number;
  /** Which boundary produced the end of this segment. */
  boundary: SegmentBoundary;
};

export type DialogueChunk = {
  /** Stable, human-readable id: chunk-001. Stable across re-chunking of the
   *  same content version, which is what makes chunk-level retries safe. */
  chunkId: string;
  sequence: number;
  characters: number;
  segments: DialogueSegment[];
  /** Distinct speaker keys used in this chunk, in first-appearance order. */
  speakers: string[];
  /** Inclusive range of dialogue line indices covered. */
  lineRange: [number, number];
};

export type ChunkingOptions = {
  maxCharactersPerChunk?: number;
  minCharactersPerChunk?: number;
  maxCharactersPerLine?: number;
};

/** Applies an optional delivery cue so that character counts include it. */
export function renderLineText(line: DialogueLine): string {
  const text = line.text.trim();
  if (!line.delivery) return text;
  const cue = line.delivery.trim().replace(/^\[|\]$/g, '');
  if (!cue) return text;
  // Do not double-apply when the author already inlined a cue.
  if (text.startsWith('[')) return text;
  return `[${cue}] ${text}`;
}

const SENTENCE_END = /([.!?…]+["'”’)\]]*)(\s+)/g;
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'approx', 'fig', 'no',
]);

/** Split a paragraph into sentences, keeping terminal punctuation attached. */
export function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let cursor = 0;
  SENTENCE_END.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(paragraph)) !== null) {
    const end = match.index + match[1].length;
    const candidate = paragraph.slice(cursor, end);
    const lastWord = candidate.trim().split(/\s+/).pop() ?? '';
    const stem = lastWord.replace(/[.!?…"'”’)\]]+$/, '').toLowerCase();
    // Do not break after a known abbreviation or a single initial ("J.").
    if (ABBREVIATIONS.has(stem) || /^[a-z]$/.test(stem)) continue;
    sentences.push(candidate.trim());
    cursor = end + match[2].length;
  }
  const tail = paragraph.slice(cursor).trim();
  if (tail) sentences.push(tail);
  return sentences.length > 0 ? sentences : [paragraph.trim()].filter(Boolean);
}

/** Last-resort split that keeps whole words together. */
function splitByWords(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > limit) {
      // A single indivisible token longer than the limit: slice it.
      if (current) {
        pieces.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += limit) pieces.push(word.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > limit) {
      pieces.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Greedily accumulate units into pieces no larger than `limit`. */
function packUnits(units: string[], limit: number, joiner: string): string[] {
  const packed: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}${joiner}${unit}` : unit;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) packed.push(current);
    current = unit;
  }
  if (current) packed.push(current);
  return packed;
}

/**
 * Split one dialogue line into provider-sized segments, preferring paragraph
 * boundaries, then sentence boundaries, then words.
 */
export function splitLine(text: string, limit: number): { text: string; boundary: SegmentBoundary }[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return [{ text: trimmed, boundary: 'turn' }];

  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: { text: string; boundary: SegmentBoundary }[] = [];

  // Pack whole paragraphs first; a group of paragraphs that fits stays together.
  for (const group of packUnits(paragraphs, limit, '\n\n')) {
    if (group.length <= limit) {
      out.push({ text: group, boundary: paragraphs.length > 1 ? 'paragraph' : 'turn' });
      continue;
    }
    // The paragraph alone is too long: fall back to sentences.
    const sentences = splitSentences(group);
    for (const sentenceGroup of packUnits(sentences, limit, ' ')) {
      if (sentenceGroup.length <= limit) {
        out.push({ text: sentenceGroup, boundary: 'sentence' });
        continue;
      }
      // A single sentence exceeds the limit: cut on word boundaries.
      for (const piece of splitByWords(sentenceGroup, limit)) {
        out.push({ text: piece, boundary: 'word' });
      }
    }
  }

  // The final piece closes the speaker turn.
  if (out.length > 0) out[out.length - 1] = { ...out[out.length - 1], boundary: 'turn' };
  return out;
}

/** Flatten an episode's dialogue into ordered, provider-sized segments. */
export function toSegments(episode: EpisodeSpec, options: ChunkingOptions = {}): DialogueSegment[] {
  const lineLimit = options.maxCharactersPerLine ?? chunkConfig.maxCharactersPerLine;
  const segments: DialogueSegment[] = [];

  episode.dialogue.forEach((line, lineIndex) => {
    const rendered = renderLineText(line);
    const parts = splitLine(rendered, lineLimit);
    parts.forEach((part, partIndex) => {
      segments.push({
        lineIndex,
        partIndex,
        partCount: parts.length,
        speaker: line.speaker,
        text: part.text,
        characters: part.text.length,
        boundary: part.boundary,
      });
    });
  });

  return segments;
}

/**
 * Group segments into generation chunks.
 *
 * Consecutive turns are packed together — Text-to-Dialogue renders a two-sided
 * exchange more naturally than isolated lines — up to the character ceiling.
 */
export function chunkEpisode(episode: EpisodeSpec, options: ChunkingOptions = {}): DialogueChunk[] {
  const maxChars = options.maxCharactersPerChunk ?? chunkConfig.maxCharactersPerChunk;
  const minChars = Math.min(options.minCharactersPerChunk ?? chunkConfig.minCharactersPerChunk, maxChars);
  const segments = toSegments(episode, { ...options, maxCharactersPerLine: options.maxCharactersPerLine ?? maxChars });

  const groups: DialogueSegment[][] = [];
  let current: DialogueSegment[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const wouldBe = currentChars + segment.characters;
    if (current.length > 0 && wouldBe > maxChars) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += segment.characters;
  }
  if (current.length > 0) groups.push(current);

  // Fold a runt tail back into its predecessor when it still fits.
  if (groups.length >= 2) {
    const last = groups[groups.length - 1];
    const lastChars = last.reduce((sum, s) => sum + s.characters, 0);
    const prev = groups[groups.length - 2];
    const prevChars = prev.reduce((sum, s) => sum + s.characters, 0);
    if (lastChars < minChars && lastChars + prevChars <= maxChars) {
      groups.splice(groups.length - 2, 2, [...prev, ...last]);
    }
  }

  return groups.map((group, index) => {
    const speakers: string[] = [];
    for (const segment of group) if (!speakers.includes(segment.speaker)) speakers.push(segment.speaker);
    return {
      chunkId: `chunk-${String(index + 1).padStart(3, '0')}`,
      sequence: index,
      characters: group.reduce((sum, s) => sum + s.characters, 0),
      segments: group,
      speakers,
      lineRange: [group[0].lineIndex, group[group.length - 1].lineIndex] as [number, number],
    };
  });
}

/** Total characters that will actually be billed for a chunk plan. */
export function chunkPlanCharacters(chunks: DialogueChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.characters, 0);
}
