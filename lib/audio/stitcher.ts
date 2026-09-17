/**
 * Stitching boundary.
 *
 * The rest of the system only knows this interface. Today it is satisfied
 * in-process by the pure-TS MP3 joiner; moving stitching to a dedicated worker
 * (FFmpeg on a container, a queue consumer) later means writing one more
 * implementation of `Stitcher` and changing one line of wiring — no change to
 * the episode model, the job runner or the UI.
 */
import { concatMp3 } from './mp3';

export type AudioPart = {
  chunkId: string;
  sequence: number;
  data: Uint8Array;
};

export type StitchResult = {
  data: Uint8Array;
  durationSeconds: number;
  contentType: string;
  frameCount: number;
  sampleRate: number;
  channels: number;
  /** Cumulative start time of each part, in order. Feeds chapter timestamps. */
  partOffsets: { chunkId: string; startSeconds: number; durationSeconds: number }[];
};

export class StitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StitchError';
  }
}

export interface Stitcher {
  readonly name: string;
  stitch(parts: AudioPart[]): Promise<StitchResult>;
}

/**
 * In-process MP3 stitcher.
 *
 * Parts are sorted by `sequence` defensively: dialogue order is the one thing
 * a stitcher must never get wrong, so it is re-established here rather than
 * trusted from the caller.
 */
export class Mp3Stitcher implements Stitcher {
  readonly name = 'mp3-frame-concat';

  async stitch(parts: AudioPart[]): Promise<StitchResult> {
    if (parts.length === 0) throw new StitchError('No audio parts to stitch');

    const ordered = [...parts].sort((a, b) => a.sequence - b.sequence);
    const sequences = ordered.map((part) => part.sequence);
    const duplicate = sequences.find((value, index) => sequences.indexOf(value) !== index);
    if (duplicate !== undefined) {
      throw new StitchError(`Duplicate chunk sequence ${duplicate} supplied to stitcher`);
    }
    for (let i = 0; i < sequences.length; i += 1) {
      if (sequences[i] !== i) {
        throw new StitchError(
          `Chunk sequence gap: expected ${i}, found ${sequences[i]} (${ordered[i].chunkId}). ` +
            'Refusing to stitch an incomplete episode.',
        );
      }
    }

    let joined;
    try {
      joined = concatMp3(ordered.map((part) => part.data));
    } catch (error) {
      throw new StitchError((error as Error).message);
    }

    const partOffsets: StitchResult['partOffsets'] = [];
    let elapsed = 0;
    ordered.forEach((part, index) => {
      const durationSeconds = joined.partDurations[index] ?? 0;
      partOffsets.push({ chunkId: part.chunkId, startSeconds: elapsed, durationSeconds });
      elapsed += durationSeconds;
    });

    return {
      data: joined.data,
      durationSeconds: joined.durationSeconds,
      contentType: 'audio/mpeg',
      frameCount: joined.frameCount,
      sampleRate: joined.sampleRate,
      channels: joined.channels,
      partOffsets,
    };
  }
}

export function createStitcher(): Stitcher {
  return new Mp3Stitcher();
}
