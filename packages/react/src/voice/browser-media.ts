import type { VoiceConnection } from "@pear-agent/core";

/** Gemini Live input expects 16 kHz mono PCM. */
export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
/** Gemini Live native-audio output is typically 24 kHz mono PCM. */
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;

/**
 * Target mic chunk duration before send (Google Live: ~20–40 ms).
 * Larger ScriptProcessor buffers (e.g. 4096 @ 48 kHz ≈ 85 ms) add avoidable latency.
 */
export const TARGET_INPUT_CHUNK_MS = 40;
/** Small look-ahead so the first sample is not late for the audio thread. */
export const PLAYBACK_LOOKAHEAD_SEC = 0.02;

export type BrowserVoiceMediaHandle = {
  stop: () => void;
};

export type AttachBrowserVoiceMediaOptions = {
  /** Called when getUserMedia or AudioContext fails. */
  onError?: (error: Error) => void;
  inputSampleRate?: number;
  outputSampleRate?: number;
};

/**
 * Downsample mono float32 audio (linear interpolation).
 * Exported for unit tests.
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

function pcm16BytesToFloat32(pcm: Uint8Array): Float32Array {
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

/**
 * Strict gapless schedule: always append after the previous chunk.
 * Never resets the cursor mid-stream (that stacks every chunk at "now" → overlapping voices).
 * Exported for unit tests.
 */
export function nextPlaybackStartTime(input: {
  now: number;
  nextPlayTime: number;
  durationSec: number;
  lookaheadSec?: number;
}): { startAt: number; nextPlayTime: number } {
  const lookahead = input.lookaheadSec ?? PLAYBACK_LOOKAHEAD_SEC;
  // If the queue is empty / behind the clock, start slightly after now.
  const startAt = Math.max(input.now + lookahead, input.nextPlayTime);
  return { startAt, nextPlayTime: startAt + input.durationSec };
}

const CAPTURE_WORKLET = `
class PearCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.port.postMessage(ch.slice(0));
    }
    return true;
  }
}
registerProcessor("pear-capture", PearCaptureProcessor);
`;

/**
 * Browser mic capture → `connection.sendAudio` (16 kHz PCM16) and
 * `connection` audio events → speaker playback (24 kHz PCM16).
 *
 * Playback is **strictly sequential** (gapless). Overlapping "all voices at once"
 * was caused by resetting the schedule cursor when the queue was "too far ahead".
 * Interrupt / stop still clears active BufferSource nodes.
 */
export async function attachBrowserVoiceMedia(
  connection: VoiceConnection,
  options: AttachBrowserVoiceMediaOptions = {},
): Promise<BrowserVoiceMediaHandle> {
  const inputRate = options.inputSampleRate ?? GEMINI_LIVE_INPUT_SAMPLE_RATE;
  const outputRate = options.outputSampleRate ?? GEMINI_LIVE_OUTPUT_SAMPLE_RATE;

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { stop: () => undefined };
  }

  let stopped = false;
  let stream: MediaStream | null = null;
  let captureCtx: AudioContext | null = null;
  let playCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let silent: GainNode | null = null;
  let unsubAudio: (() => void) | null = null;
  let unsubInterrupted: (() => void) | null = null;
  /** End time (AudioContext time) of the last scheduled chunk. */
  let nextPlayTime = 0;
  /** Active sources so interrupt/stop can silence them immediately. */
  const activeSources = new Set<AudioBufferSourceNode>();
  let pendingCapture: Float32Array[] = [];
  let pendingCaptureSamples = 0;

  const stopActiveSources = () => {
    for (const node of activeSources) {
      try {
        node.onended = null;
        node.stop();
      } catch {
        // already stopped
      }
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    activeSources.clear();
  };

  const flushPlaybackQueue = () => {
    stopActiveSources();
    if (playCtx) {
      nextPlayTime = playCtx.currentTime;
    } else {
      nextPlayTime = 0;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubAudio?.();
    unsubAudio = null;
    unsubInterrupted?.();
    unsubInterrupted = null;
    pendingCapture = [];
    pendingCaptureSamples = 0;
    flushPlaybackQueue();
    try {
      processor?.disconnect();
    } catch {
      // ignore
    }
    try {
      workletNode?.disconnect();
    } catch {
      // ignore
    }
    try {
      source?.disconnect();
    } catch {
      // ignore
    }
    try {
      silent?.disconnect();
    } catch {
      // ignore
    }
    processor = null;
    workletNode = null;
    source = null;
    silent = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void captureCtx?.close();
    void playCtx?.close();
    captureCtx = null;
    playCtx = null;
  };

  const flushCapture = (force: boolean) => {
    if (!captureCtx || stopped) return;
    if (connection.status === "disconnected" || connection.status === "muted") {
      pendingCapture = [];
      pendingCaptureSamples = 0;
      return;
    }
    const targetSamples = Math.floor(captureCtx.sampleRate * (TARGET_INPUT_CHUNK_MS / 1000));
    if (!force && pendingCaptureSamples < targetSamples) return;

    const merged = new Float32Array(pendingCaptureSamples);
    let offset = 0;
    for (const part of pendingCapture) {
      merged.set(part, offset);
      offset += part.length;
    }
    pendingCapture = [];
    pendingCaptureSamples = 0;

    const down = downsampleMono(merged, captureCtx.sampleRate, inputRate);
    connection.sendAudio(floatToPcm16Bytes(down));
  };

  const onCaptureSamples = (samples: Float32Array) => {
    if (stopped || samples.length === 0) return;
    pendingCapture.push(samples);
    pendingCaptureSamples += samples.length;
    flushCapture(false);
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("Web Audio API is not available in this browser");
    }

    captureCtx = new AudioContextCtor();
    if (captureCtx.state === "suspended") {
      await captureCtx.resume();
    }

    source = captureCtx.createMediaStreamSource(stream);
    silent = captureCtx.createGain();
    silent.gain.value = 0;

    let captureAttached = false;
    if (captureCtx.audioWorklet) {
      try {
        const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          await captureCtx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        workletNode = new AudioWorkletNode(captureCtx, "pear-capture");
        workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
          onCaptureSamples(event.data);
        };
        source.connect(workletNode);
        workletNode.connect(silent);
        silent.connect(captureCtx.destination);
        captureAttached = true;
      } catch {
        workletNode = null;
      }
    }

    if (!captureAttached) {
      processor = captureCtx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        onCaptureSamples(input.slice(0));
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(captureCtx.destination);
    }

    playCtx = new AudioContextCtor();
    if (playCtx.state === "suspended") {
      await playCtx.resume();
    }
    nextPlayTime = playCtx.currentTime;

    unsubAudio = connection.on("audio", (chunk) => {
      if (stopped || !playCtx) return;
      try {
        const samples = pcm16BytesToFloat32(chunk);
        if (samples.length === 0) return;

        // Odd-length PCM would produce incomplete last sample; drop trailing byte.
        if (chunk.byteLength % 2 !== 0) {
          // pcm16BytesToFloat32 already floors; keep going.
        }

        const buffer = playCtx.createBuffer(1, samples.length, outputRate);
        buffer.getChannelData(0).set(samples);

        const node = playCtx.createBufferSource();
        node.buffer = buffer;
        node.connect(playCtx.destination);

        const scheduled = nextPlaybackStartTime({
          now: playCtx.currentTime,
          nextPlayTime,
          durationSec: buffer.duration,
        });

        node.onended = () => {
          activeSources.delete(node);
          try {
            node.disconnect();
          } catch {
            // ignore
          }
        };

        activeSources.add(node);
        node.start(scheduled.startAt);
        nextPlayTime = scheduled.nextPlayTime;
      } catch (caught) {
        options.onError?.(caught instanceof Error ? caught : new Error(String(caught)));
      }
    });

    // Barge-in: stop currently playing + queued sources (not just reset the cursor).
    unsubInterrupted = connection.on("interrupted", () => {
      flushPlaybackQueue();
    });

    return {
      stop: () => {
        flushCapture(true);
        stop();
      },
    };
  } catch (caught) {
    stop();
    const error = caught instanceof Error ? caught : new Error(String(caught));
    options.onError?.(error);
    throw error;
  }
}
