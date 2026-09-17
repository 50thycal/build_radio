import { describe, expect, it } from 'vitest';
import { Mp3ParseError, concatMp3, id3v1Length, id3v2Length, parseMp3 } from '../lib/audio/mp3';
import { Mp3Stitcher, StitchError } from '../lib/audio/stitcher';
import { encodeTone, withId3v1, withId3v2 } from './helpers/mp3-fixtures';

describe('mp3 parsing', () => {
  it('reads frames and duration from real encoder output', () => {
    const parsed = parseMp3(encodeTone(1));
    expect(parsed.frames.length).toBeGreaterThan(30);
    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.channels).toBe(1);
    expect(parsed.constantBitrate).toBe(true);
    expect(parsed.durationSeconds).toBeGreaterThan(0.95);
    expect(parsed.durationSeconds).toBeLessThan(1.15);
  });

  it('ignores ID3v2 and ID3v1 tags', () => {
    const plain = parseMp3(encodeTone(1));
    const tagged = withId3v1(withId3v2(encodeTone(1)));
    expect(id3v2Length(tagged)).toBe(74);
    expect(id3v1Length(tagged)).toBe(128);
    const parsed = parseMp3(tagged);
    expect(parsed.frames.length).toBe(plain.frames.length);
    expect(parsed.durationSeconds).toBeCloseTo(plain.durationSeconds, 6);
  });

  it('rejects a payload with no audio frames', () => {
    expect(() => parseMp3(new Uint8Array([0, 1, 2, 3, 4, 5]))).toThrow(Mp3ParseError);
  });
});

describe('mp3 concatenation', () => {
  it('sums duration across parts', () => {
    const a = encodeTone(1, 440);
    const b = encodeTone(0.5, 660);
    const joined = concatMp3([a, b]);
    const expected = parseMp3(a).durationSeconds + parseMp3(b).durationSeconds;
    expect(joined.durationSeconds).toBeCloseTo(expected, 6);
    expect(joined.partDurations).toHaveLength(2);
  });

  it('produces a file that re-parses to the same duration', () => {
    const joined = concatMp3([encodeTone(0.5), encodeTone(0.5), encodeTone(0.5)]);
    expect(parseMp3(joined.data).durationSeconds).toBeCloseTo(joined.durationSeconds, 6);
  });

  it('writes a seek header so scrubbing is accurate', () => {
    const joined = concatMp3([encodeTone(0.5), encodeTone(0.5)]);
    // Mono MPEG1 side info is 17 bytes, so the tag sits at 4 + 17.
    const tag = Buffer.from(joined.data.subarray(21, 25)).toString('ascii');
    expect(['Xing', 'Info']).toContain(tag);
    // The header frame is metadata, so it must not be counted as audio.
    expect(parseMp3(joined.data).frames.length).toBe(joined.frameCount);
  });

  it('refuses to mix sample rates rather than produce a corrupt file', () => {
    expect(() => concatMp3([encodeTone(0.3), encodeTone(0.3, 440, { sampleRate: 22050 })])).toThrow(
      /sample rate/,
    );
  });

  it('refuses an empty part list', () => {
    expect(() => concatMp3([])).toThrow(Mp3ParseError);
  });
});

describe('stitcher', () => {
  const stitcher = new Mp3Stitcher();

  it('orders parts by sequence regardless of array order', async () => {
    const first = encodeTone(1.0, 440);
    const second = encodeTone(0.4, 880);
    const outOfOrder = await stitcher.stitch([
      { chunkId: 'chunk-002', sequence: 1, data: second },
      { chunkId: 'chunk-001', sequence: 0, data: first },
    ]);
    expect(outOfOrder.partOffsets.map((part) => part.chunkId)).toEqual(['chunk-001', 'chunk-002']);
    expect(outOfOrder.partOffsets[0].startSeconds).toBe(0);
    expect(outOfOrder.partOffsets[1].startSeconds).toBeCloseTo(parseMp3(first).durationSeconds, 6);
  });

  it('refuses to stitch when a chunk is missing from the sequence', async () => {
    await expect(
      stitcher.stitch([
        { chunkId: 'chunk-001', sequence: 0, data: encodeTone(0.3) },
        { chunkId: 'chunk-003', sequence: 2, data: encodeTone(0.3) },
      ]),
    ).rejects.toThrow(StitchError);
  });

  it('refuses duplicate sequences', async () => {
    await expect(
      stitcher.stitch([
        { chunkId: 'chunk-001', sequence: 0, data: encodeTone(0.3) },
        { chunkId: 'chunk-001-again', sequence: 0, data: encodeTone(0.3) },
      ]),
    ).rejects.toThrow(/Duplicate chunk sequence/);
  });

  it('reports a decodable content type and timeline', async () => {
    const result = await stitcher.stitch([
      { chunkId: 'chunk-001', sequence: 0, data: encodeTone(0.5) },
      { chunkId: 'chunk-002', sequence: 1, data: encodeTone(0.5) },
    ]);
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.durationSeconds).toBeCloseTo(
      result.partOffsets.reduce((sum, part) => sum + part.durationSeconds, 0),
      6,
    );
  });
});
