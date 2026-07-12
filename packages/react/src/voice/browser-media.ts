import type { VoiceConnection } from "@pear-agent/core";

import {
  downsampleMono,
  floatToPcm16Bytes,
  GEMINI_LIVE_INPUT_SAMPLE_RATE,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
  nextPlaybackStartTime,
  pcm16BytesToFloat32,
} from "./pcm.js";

export {
  downsampleMono,
  floatToPcm16Bytes,
  GEMINI_LIVE_INPUT_SAMPLE_RATE,
  GEMINI_LIVE_OUTPUT_SAMPLE_RATE,
  nextPlaybackStartTime,
  PLAYBACK_LOOKAHEAD_SEC,
} from "./pcm.js";

/**
 * Target mic chunk duration before send (Google Live: ~20–40 ms).
 */
export const TARGET_INPUT_CHUNK_MS = 40;

export type BrowserVoiceMediaHandle = {
  stop: () => void;
};

export type AttachBrowserVoiceMediaOptions = {
  onError?: (error: Error) => void;
  inputSampleRate?: number;
  outputSampleRate?: number;
};

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
 * Playback is strictly sequential (gapless). Interrupt/stop clears active sources.
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
  let nextPlayTime = 0;
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
    nextPlayTime = playCtx?.currentTime ?? 0;
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
