/** Gemini Live input expects 16 kHz mono PCM. */
export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
/** Gemini Live native-audio output is typically 24 kHz mono PCM. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;

/**
 * Downsample mono float32 audio (linear interpolation).
 */
export function downsampleMono(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  if (fromRate < toRate) {
    return input;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

/** Convert float32 [-1, 1] samples to little-endian PCM16 bytes. */
export function floatToPcm16Bytes(input: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function pcm16BytesToFloat32(pcm: Uint8Array): Float32Array {
  const aligned =
    pcm.byteOffset % 2 === 0
      ? pcm
      : (() => {
          const copy = new Uint8Array(pcm.byteLength);
          copy.set(pcm);
          return copy;
        })();
  const view = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength);
  const samples = Math.floor(aligned.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

/** Small look-ahead so the first sample is not late for the audio thread. */
export const PLAYBACK_LOOKAHEAD_SEC = 0.02;

/**
 * Strict gapless schedule: always append after the previous chunk.
 * Never resets the cursor mid-stream (that stacks every chunk at "now" → overlapping voices).
 */
export function nextPlaybackStartTime(input: {
  now: number;
  nextPlayTime: number;
  durationSec: number;
  lookaheadSec?: number;
}): { startAt: number; nextPlayTime: number } {
  const lookahead = input.lookaheadSec ?? PLAYBACK_LOOKAHEAD_SEC;
  const startAt = Math.max(input.now + lookahead, input.nextPlayTime);
  return { startAt, nextPlayTime: startAt + input.durationSec };
}
