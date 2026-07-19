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

  // Sequential by design (beep → gap → beep). Not independent work for Promise.all.
  const tick = () => {
    if (ac.signal.aborted) return;
    void playTimerAlarmBeeps().then(() => {
      if (ac.signal.aborted) return;
      if (first) {
        first = false;
        options.onFirstBurst?.();
      }
      void abortableSleep(options.gapAfterBurstMs, ac.signal)
        .then(tick)
        .catch(() => undefined);
    });
  };
  tick();

  return {
    stop: () => {
      ac.abort();
    },
  };
}
