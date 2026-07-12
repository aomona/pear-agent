/**
 * Short alarm beeps via Web Audio (no asset files).
 * "ピピピピ" — four short tones; hosts may call repeatedly until the timer is completed.
 */

let sharedCtx: AudioContext | null = null;

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
  // Soft attack / release to avoid click
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.22, when + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + durationSec + 0.02);
}

/**
 * Play four short beeps (ピピピピ). Safe to call from user-gesture-started sessions;
 * resumes suspended AudioContext when possible.
 */
export async function playTimerAlarmBeeps(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  } catch {
    return;
  }

  const t0 = ctx.currentTime + 0.02;
  const gap = 0.18;
  const tone = 0.09;
  // Slight pitch lift on last beep for "done" feel
  const freqs = [880, 880, 880, 1174.66];
  for (let i = 0; i < freqs.length; i++) {
    beepOnce(ctx, t0 + i * gap, freqs[i]!, tone);
  }
}
