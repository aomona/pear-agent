/**
 * Debounced Gemini Live session-resumption handle sync.
 * Keeps latest handle in memory; PUTs after quiet period; flush on disconnect/suspend.
 */

export type ResumeHandleSyncOptions = {
  debounceMs: number;
  /** Persist handle to the host (e.g. PUT /voice/resume-handle). */
  put: (handle: string | null) => Promise<void>;
  /** Persist during page lifecycle teardown using an unload-safe transport. */
  putKeepalive?: (handle: string | null) => Promise<void>;
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
  /** Dispatch the latest unpersisted handle with an unload-safe transport. */
  flushForLifecycle: () => Promise<void>;
  /** Immediate put of null and clear pending (stale handle recovery). */
  clearRemote: () => Promise<void>;
  dispose: () => void;
};

type LifecycleEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type ResumeHandleLifecycleFlushOptions = {
  getSync: () => Pick<ResumeHandleSync, "flushForLifecycle"> | null;
  pageTarget: LifecycleEventTarget;
  visibilityTarget: LifecycleEventTarget & { visibilityState: string };
};

/**
 * Best-effort persistence when a page is hidden or leaves the back/forward lifecycle.
 * The lifecycle flush deduplicates persisted handles and uses the caller's unload-safe transport.
 */
export function attachResumeHandleLifecycleFlush(
  options: ResumeHandleLifecycleFlushOptions,
): () => void {
  const flush = () => {
    void options
      .getSync()
      ?.flushForLifecycle()
      .catch(() => undefined);
  };
  const onVisibilityChange = () => {
    if (options.visibilityTarget.visibilityState === "hidden") flush();
  };
  options.pageTarget.addEventListener("pagehide", flush);
  options.visibilityTarget.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    options.pageTarget.removeEventListener("pagehide", flush);
    options.visibilityTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export function createResumeHandleSync(options: ResumeHandleSyncOptions): ResumeHandleSync {
  let lastPersisted: string | null | undefined = undefined;
  let pending: string | null | undefined = undefined;
  let latestRequested: string | null | undefined = undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let lifecycleInFlight: { handle: string | null; promise: Promise<void> } | null = null;

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
        try {
          await options.put(handle);
          lastPersisted = handle;
        } catch {
          // Keep the latest failed handle available for a cleanup flush or retry.
          if (latestRequested === handle && pending === undefined) {
            pending = handle;
            timer = setTimeout(() => {
              timer = null;
              const toWrite = pending;
              if (toWrite === undefined) return;
              pending = undefined;
              void persist(toWrite);
            }, options.debounceMs);
          }
        }
      });
    return chain;
  };

  return {
    noteKnown(handle) {
      lastPersisted = handle;
      latestRequested = handle;
      if (pending === handle) {
        pending = undefined;
        clearTimer();
      }
    },

    schedule(handle) {
      if (!isCurrent()) return;
      options.onOptimistic?.(handle);
      latestRequested = handle;

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
      pending = undefined;
      if (toWrite !== undefined) await persist(toWrite);
      await chain;
    },

    async flushForLifecycle() {
      clearTimer();
      const toWrite = pending ?? latestRequested;
      pending = undefined;
      if (toWrite === undefined || lastPersisted === toWrite) return;
      if (lifecycleInFlight?.handle === toWrite) {
        await lifecycleInFlight.promise;
        return;
      }

      const write = (options.putKeepalive ?? options.put)(toWrite)
        .then(() => {
          lastPersisted = toWrite;
        })
        .catch(() => {
          if (latestRequested === toWrite && pending === undefined) pending = toWrite;
        })
        .finally(() => {
          if (lifecycleInFlight?.promise === write) lifecycleInFlight = null;
        });
      lifecycleInFlight = { handle: toWrite, promise: write };
      await write;
    },

    async clearRemote() {
      clearTimer();
      pending = undefined;
      latestRequested = null;
      await persist(null);
    },

    dispose() {
      clearTimer();
      pending = undefined;
      lastPersisted = undefined;
    },
  };
}
