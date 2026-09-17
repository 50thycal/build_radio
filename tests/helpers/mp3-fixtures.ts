/**
 * Real MP3 fixtures for the audio tests.
 *
 * The stitcher is tested against genuine LAME-encoded frames rather than
 * hand-written bytes, so frame-length maths, tag handling and duration
 * accounting are exercised the way provider output exercises them.
 */
import lame from '@breezystack/lamejs';

export function encodeTone(
  seconds: number,
  frequency = 440,
  options: { channels?: 1 | 2; sampleRate?: number; bitrateKbps?: number } = {},
): Uint8Array {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 44100;
  const bitrate = options.bitrateKbps ?? 128;
  const encoder = new lame.Mp3Encoder(channels, sampleRate, bitrate);
  const sampleCount = Math.round(sampleRate * seconds);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
  }
  const parts: Uint8Array[] = [];
  const first = channels === 1 ? encoder.encodeBuffer(samples) : encoder.encodeBuffer(samples, samples);
  if (first.length) parts.push(first);
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Prepend a synthetic ID3v2 tag, as most real encoders and CDNs do. */
export function withId3v2(data: Uint8Array, payloadSize = 64): Uint8Array {
  const header = new Uint8Array(10 + payloadSize);
  header[0] = 0x49; // I
  header[1] = 0x44; // D
  header[2] = 0x33; // 3
  header[3] = 0x04;
  header[6] = (payloadSize >> 21) & 0x7f;
  header[7] = (payloadSize >> 14) & 0x7f;
  header[8] = (payloadSize >> 7) & 0x7f;
  header[9] = payloadSize & 0x7f;
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

/** Append a synthetic ID3v1 tag (128 bytes beginning "TAG"). */
export function withId3v1(data: Uint8Array): Uint8Array {
  const tag = new Uint8Array(128);
  tag[0] = 0x54; // T
  tag[1] = 0x41; // A
  tag[2] = 0x47; // G
  const out = new Uint8Array(data.length + tag.length);
  out.set(data, 0);
  out.set(tag, data.length);
  return out;
}
