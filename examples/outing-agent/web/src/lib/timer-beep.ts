/**
 * Short alarm beeps via Web Audio (no asset files).
 * One burst = four short "ピ" tones in sequence (not stacked).
 */

let sharedCtx: AudioContext | null = null;
/** Serialize bursts so overlapping calls never stack oscillators. */
let playChain: Promise<void> = Promise.resolve();

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AC();
  }
  return sharedCtx;
}

function beepOnce(ctx: AudioContext, when: number, frequencyHz: number, durationSec: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequencyHz, when);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.2, when + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + durationSec + 0.02);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Play one ピピピピ burst and resolve after it fully finishes.
 * Concurrent calls are queued (never mixed into the same moment).
 */
export function playTimerAlarmBeeps(): Promise<void> {
  const job = playChain.then(async () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
    } catch {
      return;
    }

    // Clear spacing between pips so they are not heard as one blob.
    const t0 = ctx.currentTime + 0.03;
    const pip = 0.08;
    const silence = 0.22; // gap after each pip
    const step = pip + silence;
    const freqs = [880, 880, 880, 1174.66];
    for (let i = 0; i < freqs.length; i++) {
      beepOnce(ctx, t0 + i * step, freqs[i]!, pip);
    }
    const totalMs = Math.ceil((freqs.length * step + 0.05) * 1000);
    await sleep(totalMs);
  });

  playChain = job.catch(() => undefined);
  return job;
}
