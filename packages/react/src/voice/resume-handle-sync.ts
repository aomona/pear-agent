/**
 * Debounced Gemini Live session-resumption handle sync.
 * Keeps latest handle in memory; PUTs after quiet period; flush on disconnect/suspend.
 */

export type ResumeHandleSyncOptions = {
  debounceMs: number;
  /** Persist handle to the host (e.g. PUT /voice/resume-handle). */
  put: (
    handle: string | null,
    options: { expectedHandles: readonly (string | null)[] },
  ) => Promise<string | null>;
  /** Persist during page lifecycle teardown using an unload-safe transport. */
  putKeepalive?: (
    handle: string | null,
    options: { expectedHandles: readonly (string | null)[] },
  ) => Promise<string | null>;
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
  const lifecycleWrites = new Map<string | null, Promise<void>>();
  let lifecycleRetry: string | null | undefined = undefined;
  const scheduledWrites = new Set<string | null>();
  let writeGeneration = 0;

  const isCurrent = () => options.isCurrent?.() ?? true;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const persist = (handle: string | null) => {
    const generation = writeGeneration;
    scheduledWrites.add(handle);
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        try {
          // A lifecycle keepalive write supersedes normal writes that had not started.
          if (generation !== writeGeneration || lastPersisted === handle) return;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            lastPersisted = await options.put(handle, {
              expectedHandles: [lastPersisted ?? null],
            });
            if (
              lastPersisted === handle ||
              generation !== writeGeneration ||
              latestRequested !== handle
            ) {
              return;
            }
          }
          if (latestRequested === handle && pending === undefined) {
            pending = handle;
          }
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
        } finally {
          scheduledWrites.delete(handle);
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

      // Disconnect/suspend must not release the lease while a lifecycle write
      // still depends on it. New lifecycle writes can join while awaiting.
      while (lifecycleWrites.size > 0) {
        await Promise.all(lifecycleWrites.values());
      }

      // A failed lifecycle write is retried normally before release.
      clearTimer();
      const retryHandle = lifecycleRetry;
      lifecycleRetry = undefined;
      if (retryHandle !== undefined && retryHandle === latestRequested) {
        await persist(retryHandle);
      }
      await chain;
    },

    async flushForLifecycle() {
      clearTimer();
      const toWrite = pending ?? lifecycleRetry ?? latestRequested;
      pending = undefined;
      if (lifecycleRetry === toWrite) lifecycleRetry = undefined;
      if (toWrite === undefined || lastPersisted === toWrite) return;
      const duplicateWrite = lifecycleWrites.get(toWrite);
      if (duplicateWrite !== undefined) {
        await duplicateWrite;
        return;
      }

      writeGeneration += 1;
      const expectedHandles = [
        ...new Set([lastPersisted ?? null, ...scheduledWrites, ...lifecycleWrites.keys()]),
      ];
      const write = (options.putKeepalive ?? options.put)(toWrite, { expectedHandles })
        .then((persistedHandle) => {
          lastPersisted = persistedHandle;
          if (persistedHandle === toWrite && lifecycleRetry === toWrite) {
            lifecycleRetry = undefined;
          }
        })
        .catch(() => {
          if (latestRequested === toWrite) lifecycleRetry = toWrite;
        })
        .finally(() => {
          if (lifecycleWrites.get(toWrite) === write) lifecycleWrites.delete(toWrite);
        });
      lifecycleWrites.set(toWrite, write);
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
      lifecycleRetry = undefined;
    },
  };
}
