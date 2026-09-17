/**
 * Minimal MPEG audio (MP3) frame toolkit — pure TypeScript, no native binaries.
 *
 * Why not FFmpeg: Vercel's Node runtime has no FFmpeg binary, and shipping one
 * inflates the bundle past the function size limit. MP3 is a self-delimiting
 * frame format, so chunks returned by ElevenLabs can be joined losslessly by
 * concatenating their audio frames — no re-encode, no quality loss, no binary.
 *
 * What this module does that a naive `Buffer.concat` does not:
 *   - strips ID3v2/ID3v1 tags from every chunk (otherwise players read tag
 *     bytes as audio and glitch, or stop early)
 *   - drops each chunk's Xing/Info/VBRI header frame (a silent metadata frame
 *     that would otherwise appear mid-episode and skew duration)
 *   - computes exact duration from frame headers instead of guessing
 *   - writes a single Xing header with a real seek TOC at the front of the
 *     finished file, which is what makes scrubbing accurate in mobile Safari
 */

const MPEG_VERSIONS = ['2.5', 'reserved', '2', '1'] as const;
type MpegVersion = (typeof MPEG_VERSIONS)[number];

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
const SAMPLE_RATES: Record<Exclude<MpegVersion, 'reserved'>, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

export type Mp3Frame = {
  offset: number;
  length: number;
  version: Exclude<MpegVersion, 'reserved'>;
  bitrateKbps: number;
  sampleRate: number;
  samplesPerFrame: number;
  channels: 1 | 2;
  /** True when this frame carries Xing/Info/VBRI metadata instead of audio. */
  isMetadataFrame: boolean;
};

export class Mp3ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp3ParseError';
  }
}

function syncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

/** Byte length of a leading ID3v2 tag, or 0 when absent. */
export function id3v2Length(data: Uint8Array): number {
  if (data.length < 10) return 0;
  if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0; // "ID3"
  const hasFooter = (data[5] & 0x10) !== 0;
  return 10 + syncsafe(data, 6) + (hasFooter ? 10 : 0);
}

/** Byte length of a trailing ID3v1 tag, or 0 when absent. */
export function id3v1Length(data: Uint8Array): number {
  if (data.length < 128) return 0;
  const start = data.length - 128;
  const isTag = data[start] === 0x54 && data[start + 1] === 0x41 && data[start + 2] === 0x47; // "TAG"
  return isTag ? 128 : 0;
}

function sideInfoSize(version: Exclude<MpegVersion, 'reserved'>, channels: 1 | 2): number {
  if (version === '1') return channels === 1 ? 17 : 32;
  return channels === 1 ? 9 : 17;
}

function matchesAscii(data: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > data.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Parse a single frame header at `offset`, or null when it is not a frame. */
export function readFrameHeader(data: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > data.length) return null;
  if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (data[offset + 1] >> 3) & 0x03;
  const version = MPEG_VERSIONS[versionBits];
  if (version === 'reserved') return null;

  const layerBits = (data[offset + 1] >> 1) & 0x03;
  if (layerBits !== 0x01) return null; // Layer III only

  const bitrateIndex = (data[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
  if (sampleRateIndex === 0x03) return null;

  const table = version === '1' ? BITRATES_V1_L3 : BITRATES_V2_L3;
  const bitrateKbps = table[bitrateIndex];
  if (bitrateKbps <= 0) return null; // free-form or invalid

  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const padding = (data[offset + 2] >> 1) & 0x01;
  const channelMode = (data[offset + 3] >> 6) & 0x03;
  const channels: 1 | 2 = channelMode === 0x03 ? 1 : 2;
  const samplesPerFrame = version === '1' ? 1152 : 576;
  const length = Math.floor((samplesPerFrame / 8) * (bitrateKbps * 1000) / sampleRate) + padding;
  if (length <= 4 || offset + length > data.length) return null;

  const tagOffset = offset + 4 + sideInfoSize(version, channels);
  const isMetadataFrame =
    matchesAscii(data, tagOffset, 'Xing') ||
    matchesAscii(data, tagOffset, 'Info') ||
    matchesAscii(data, offset + 36, 'VBRI');

  return { offset, length, version, bitrateKbps, sampleRate, samplesPerFrame, channels, isMetadataFrame };
}

export type ParsedMp3 = {
  frames: Mp3Frame[];
  /** Offset of the first audio frame (metadata frame excluded). */
  audioStart: number;
  /** Offset just past the last audio frame. */
  audioEnd: number;
  durationSeconds: number;
  sampleRate: number;
  channels: 1 | 2;
  /** True when every audio frame shares one bitrate. */
  constantBitrate: boolean;
};

/**
 * Parse an MP3 payload into its audio frames.
 *
 * The scanner resynchronises byte-by-byte after a bad header so a stray tag or
 * a truncated response degrades to "fewer frames", never to a hard failure.
 */
export function parseMp3(data: Uint8Array): ParsedMp3 {
  const end = data.length - id3v1Length(data);
  let cursor = id3v2Length(data);
  const frames: Mp3Frame[] = [];

  while (cursor < end) {
    const frame = readFrameHeader(data, cursor);
    if (!frame) {
      cursor += 1;
      continue;
    }
    // Require a plausible successor (or EOF) to reject false sync words.
    const nextOffset = frame.offset + frame.length;
    const hasSuccessor = nextOffset >= end || readFrameHeader(data, nextOffset) !== null;
    if (!hasSuccessor && frames.length === 0) {
      cursor += 1;
      continue;
    }
    frames.push(frame);
    cursor = nextOffset;
  }

  const audioFrames = frames.filter((frame) => !frame.isMetadataFrame);
  if (audioFrames.length === 0) {
    throw new Mp3ParseError('No MPEG Layer III audio frames found in payload');
  }

  const durationSeconds = audioFrames.reduce((sum, f) => sum + f.samplesPerFrame / f.sampleRate, 0);
  const first = audioFrames[0];
  const bitrates = new Set(audioFrames.map((f) => f.bitrateKbps));

  return {
    frames: audioFrames,
    audioStart: first.offset,
    audioEnd: audioFrames[audioFrames.length - 1].offset + audioFrames[audioFrames.length - 1].length,
    durationSeconds,
    sampleRate: first.sampleRate,
    channels: first.channels,
    constantBitrate: bitrates.size === 1,
  };
}

/** Bytes of the audio frames only: tags and metadata frames removed. */
export function extractAudioFrames(data: Uint8Array): { bytes: Uint8Array; parsed: ParsedMp3 } {
  const parsed = parseMp3(data);
  const total = parsed.frames.reduce((sum, f) => sum + f.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const frame of parsed.frames) {
    bytes.set(data.subarray(frame.offset, frame.offset + frame.length), offset);
    offset += frame.length;
  }
  return { bytes, parsed };
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/**
 * Build a Xing/Info header frame describing the concatenated stream.
 *
 * Without this, a player seeking in a joined file extrapolates from the first
 * frame's bitrate and lands in the wrong place. With a real TOC, scrubbing is
 * accurate even when chunk bitrates differ.
 */
export function buildXingFrame(frames: Mp3Frame[], audioByteLength: number): Uint8Array {
  const template = frames[0];
  const bitrateTable = template.version === '1' ? BITRATES_V1_L3 : BITRATES_V2_L3;
  // 128 kbps gives a frame comfortably larger than the Xing payload.
  let bitrateIndex = bitrateTable.indexOf(128);
  if (bitrateIndex < 1) bitrateIndex = bitrateTable.findIndex((rate) => rate >= 64);
  const bitrateKbps = bitrateTable[bitrateIndex];

  const sampleRateIndex = SAMPLE_RATES[template.version].indexOf(template.sampleRate);
  const versionBits = MPEG_VERSIONS.indexOf(template.version);
  const frameLength =
    Math.floor((template.samplesPerFrame / 8) * (bitrateKbps * 1000) / template.sampleRate);

  const frame = new Uint8Array(frameLength);
  frame[0] = 0xff;
  frame[1] = 0xe0 | (versionBits << 3) | (0x01 << 1) | 0x01; // Layer III, no CRC
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2);
  frame[3] = (template.channels === 1 ? 0x03 : 0x01) << 6; // mono | joint stereo

  const tagOffset = 4 + sideInfoSize(template.version, template.channels);
  const constantBitrate = new Set(frames.map((f) => f.bitrateKbps)).size === 1;
  const tag = constantBitrate ? 'Info' : 'Xing';
  for (let i = 0; i < 4; i += 1) frame[tagOffset + i] = tag.charCodeAt(i);

  writeUint32BE(frame, tagOffset + 4, 0x0f); // frames | bytes | TOC | quality
  writeUint32BE(frame, tagOffset + 8, frames.length);
  writeUint32BE(frame, tagOffset + 12, audioByteLength + frameLength);

  // Seek table: byte position (as 0-255) at each 1% of total duration.
  const tocOffset = tagOffset + 16;
  const totalDuration = frames.reduce((sum, f) => sum + f.samplesPerFrame / f.sampleRate, 0);
  let frameIndex = 0;
  let elapsed = 0;
  let bytePosition = 0;
  for (let percent = 0; percent < 100; percent += 1) {
    const target = (percent / 100) * totalDuration;
    while (frameIndex < frames.length && elapsed < target) {
      elapsed += frames[frameIndex].samplesPerFrame / frames[frameIndex].sampleRate;
      bytePosition += frames[frameIndex].length;
      frameIndex += 1;
    }
    const fraction = audioByteLength > 0 ? bytePosition / audioByteLength : 0;
    frame[tocOffset + percent] = Math.min(255, Math.max(0, Math.round(fraction * 255)));
  }
  writeUint32BE(frame, tocOffset + 100, 100); // quality

  return frame;
}

export type ConcatResult = {
  data: Uint8Array;
  durationSeconds: number;
  frameCount: number;
  sampleRate: number;
  channels: 1 | 2;
  /** Per-input duration, in input order — used to derive chapter timestamps. */
  partDurations: number[];
};

/**
 * Losslessly join MP3 payloads in the order given.
 *
 * Order is the caller's contract: this function never reorders, and a mismatch
 * in sample rate between parts is an error rather than a silent artefact.
 */
export function concatMp3(parts: Uint8Array[]): ConcatResult {
  if (parts.length === 0) throw new Mp3ParseError('Cannot concatenate zero audio parts');

  const extracted = parts.map((part, index) => {
    try {
      return extractAudioFrames(part);
    } catch (error) {
      throw new Mp3ParseError(`Audio part ${index + 1} of ${parts.length} is not decodable MP3: ${(error as Error).message}`);
    }
  });

  const sampleRate = extracted[0].parsed.sampleRate;
  const mismatch = extracted.findIndex((item) => item.parsed.sampleRate !== sampleRate);
  if (mismatch > 0) {
    throw new Mp3ParseError(
      `Audio part ${mismatch + 1} has sample rate ${extracted[mismatch].parsed.sampleRate}Hz, expected ${sampleRate}Hz. ` +
        'All chunks must be generated with the same output format.',
    );
  }

  const allFrames = extracted.flatMap((item) => item.parsed.frames);
  const audioByteLength = extracted.reduce((sum, item) => sum + item.bytes.length, 0);
  const xing = buildXingFrame(allFrames, audioByteLength);

  const data = new Uint8Array(xing.length + audioByteLength);
  data.set(xing, 0);
  let offset = xing.length;
  for (const item of extracted) {
    data.set(item.bytes, offset);
    offset += item.bytes.length;
  }

  return {
    data,
    durationSeconds: extracted.reduce((sum, item) => sum + item.parsed.durationSeconds, 0),
    frameCount: allFrames.length,
    sampleRate,
    channels: extracted[0].parsed.channels,
    partDurations: extracted.map((item) => item.parsed.durationSeconds),
  };
}
