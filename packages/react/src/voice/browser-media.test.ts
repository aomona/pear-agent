import { describe, expect, it } from "vitest";

import { downsampleMono, floatToPcm16Bytes, nextPlaybackStartTime } from "./browser-media.js";

describe("browser voice media helpers", () => {
  it("downsamples mono float audio", () => {
    const input = new Float32Array(8);
    for (let i = 0; i < input.length; i++) input[i] = i / 10;
    const out = downsampleMono(input, 32_000, 16_000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it("encodes float samples as little-endian PCM16", () => {
    const pcm = floatToPcm16Bytes(new Float32Array([0, 0.5, -1]));
    expect(pcm.byteLength).toBe(6);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBeGreaterThan(0);
    expect(view.getInt16(4, true)).toBe(-0x8000);
  });

  it("schedules chunks gaplessly without overlapping when queue is long", () => {
    // Simulate a burst of chunks (model streams faster than real-time).
    let nextPlayTime = 10;
    const now = 10;
    const starts: number[] = [];
    for (let i = 0; i < 20; i++) {
      const scheduled = nextPlaybackStartTime({
        now,
        nextPlayTime,
        durationSec: 0.04,
        lookaheadSec: 0.02,
      });
      starts.push(scheduled.startAt);
      nextPlayTime = scheduled.nextPlayTime;
    }
    // First starts after lookahead.
    expect(starts[0]).toBeCloseTo(10.02, 5);
    // Each subsequent chunk starts exactly after the previous ends (no overlap).
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeCloseTo(0.04, 5);
    }
    // Never collapses back to "now" mid-stream.
    expect(starts[starts.length - 1]!).toBeGreaterThan(10.7);
  });

  it("starts near now when the queue is empty or behind", () => {
    const scheduled = nextPlaybackStartTime({
      now: 50,
      nextPlayTime: 0,
      durationSec: 0.1,
      lookaheadSec: 0.02,
    });
    expect(scheduled.startAt).toBeCloseTo(50.02, 5);
    expect(scheduled.nextPlayTime).toBeCloseTo(50.12, 5);
  });
});
