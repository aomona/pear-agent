/**
 * Debounced Gemini Live session-resumption handle sync.
 * Keeps latest handle in memory; PUTs after quiet period; flush on disconnect/suspend.
 */

export type ResumeHandleSyncOptions = {
  debounceMs: number;
  /** Persist handle to the host (e.g. PUT /voice/resume-handle). */
  put: (handle: string | null) => Promise<void>;
  /** Local UI update before network (optional). */
  onOptimistic?: (handle: string) => void;
  /** When false, skip applying put results (stale generation). */
  isCurrent?: () => boolean;
};

export type ResumeHandleSync = {
  /** Seed from lease acquire / refetch (already on server). */
  noteKnown: (handle: string | null) => void;
  /** Live sessionResumptionUpdate — optimistic + debounced put. */
  schedule: (handle: string) => void;
  /** Write pending immediately (disconnect / suspend). */
  flush: () => Promise<void>;
  /** Immediate put of null and clear pending (stale handle recovery). */
  clearRemote: () => Promise<void>;
  dispose: () => void;
};

export function createResumeHandleSync(options: ResumeHandleSyncOptions): ResumeHandleSync {
  let lastPersisted: string | null | undefined = undefined;
  let pending: string | null | undefined = undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const isCurrent = () => options.isCurrent?.() ?? true;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const persist = (handle: string | null) => {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        if (lastPersisted === handle) return;
        if (!isCurrent()) return;
        try {
          await options.put(handle);
          if (!isCurrent()) return;
          lastPersisted = handle;
        } catch {
          // best-effort; next flush may retry
        }
      });
    return chain;
  };

  return {
    noteKnown(handle) {
      lastPersisted = handle;
      if (pending === handle) {
        pending = undefined;
        clearTimer();
      }
    },

    schedule(handle) {
      if (!isCurrent()) return;
      options.onOptimistic?.(handle);

      if (lastPersisted === handle) {
        if (pending === handle) {
          pending = undefined;
          clearTimer();
        }
        return;
      }

      pending = handle;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        const toWrite = pending;
        if (toWrite === undefined) return;
        pending = undefined;
        void persist(toWrite);
      }, options.debounceMs);
    },

    async flush() {
      clearTimer();
      const toWrite = pending;
      if (toWrite === undefined) return;
      pending = undefined;
      await persist(toWrite);
    },

    async clearRemote() {
      clearTimer();
      pending = undefined;
      await persist(null);
    },

    dispose() {
      clearTimer();
      pending = undefined;
      lastPersisted = undefined;
    },
  };
}
