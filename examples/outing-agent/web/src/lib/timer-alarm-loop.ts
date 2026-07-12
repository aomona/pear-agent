import { playTimerAlarmBeeps } from "./timer-beep.js";

export type TimerAlarmLoop = {
  stop: () => void;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Play ピピピピ, wait gapAfterBurstMs after the burst ends, repeat until stop().
 * Single controller — safe against React effect restarts when caller disposes first.
 */
export function startTimerAlarmLoop(options: {
  gapAfterBurstMs: number;
  onFirstBurst?: () => void;
}): TimerAlarmLoop {
  const ac = new AbortController();
  let first = true;

  void (async () => {
    while (!ac.signal.aborted) {
      try {
        await playTimerAlarmBeeps();
        if (ac.signal.aborted) break;
        if (first) {
          first = false;
          options.onFirstBurst?.();
        }
        await abortableSleep(options.gapAfterBurstMs, ac.signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") break;
        // Audio failure: stop looping rather than spin.
        break;
      }
    }
  })();

  return {
    stop: () => {
      ac.abort();
    },
  };
}
