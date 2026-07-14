import { describe, expect, it, vi } from "vitest";

import { attachResumeHandleLifecycleFlush, createResumeHandleSync } from "./resume-handle-sync.js";

describe("createResumeHandleSync", () => {
  it("flushes an in-flight write before resolving", async () => {
    let resolvePut!: () => void;
    const put = new Promise<void>((resolve) => {
      resolvePut = resolve;
    });
    const writes: Array<string | null> = [];
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle) => {
        writes.push(handle);
        await put;
        return handle;
      },
    });

    sync.schedule("latest");
    const flush = sync.flush();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["latest"]);

    let settled = false;
    void flush.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePut();
    await flush;
    expect(settled).toBe(true);
  });

  it("allows cleanup flushes after the connection epoch is stale", async () => {
    let current = true;
    const writes: Array<string | null> = [];
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      isCurrent: () => current,
      put: async (handle) => {
        writes.push(handle);
        return handle;
      },
    });

    sync.schedule("cleanup-handle");
    current = false;
    await sync.flush();

    expect(writes).toEqual(["cleanup-handle"]);
  });

  it("keeps failed writes pending so a later flush retries them", async () => {
    let attempts = 0;
    const writes: Array<string | null> = [];
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle) => {
        writes.push(handle);
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
        return handle;
      },
    });

    sync.schedule("retry-me");
    await sync.flush();
    expect(writes).toEqual(["retry-me"]);

    await sync.flush();
    expect(writes).toEqual(["retry-me", "retry-me"]);
  });

  it("flushes pending handles on hidden/pagehide without PUT spam", async () => {
    vi.useFakeTimers();
    const writes: Array<string | null> = [];
    const keepaliveWrites: Array<string | null> = [];
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle) => {
        writes.push(handle);
        return handle;
      },
      putKeepalive: async (handle) => {
        keepaliveWrites.push(handle);
        return handle;
      },
    });
    const pageTarget = new EventTarget();
    const visibilityTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const detach = attachResumeHandleLifecycleFlush({
      getSync: () => sync,
      pageTarget,
      visibilityTarget,
    });

    sync.schedule("hidden-handle");
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.runAllTicks();
    expect(writes).toEqual([]);

    visibilityTarget.visibilityState = "hidden";
    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.runAllTicks();
    await sync.flush();
    expect(writes).toEqual([]);
    expect(keepaliveWrites).toEqual(["hidden-handle"]);

    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    await sync.flushForLifecycle();
    expect(keepaliveWrites).toEqual(["hidden-handle"]);

    sync.schedule("pagehide-handle");
    pageTarget.dispatchEvent(new Event("pagehide"));
    await vi.runAllTicks();
    await sync.flushForLifecycle();
    expect(keepaliveWrites).toEqual(["hidden-handle", "pagehide-handle"]);

    detach();
    vi.useRealTimers();
  });

  it("protects a lifecycle write from an older in-flight write", async () => {
    let resolveOlder!: (persisted: string | null) => void;
    const olderResult = new Promise<string | null>((resolve) => {
      resolveOlder = resolve;
    });
    const keepaliveExpected: Array<readonly (string | null)[]> = [];
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle) => (handle === "older" ? olderResult : handle),
      putKeepalive: async (handle, options) => {
        keepaliveExpected.push(options.expectedHandles);
        return handle;
      },
    });
    sync.noteKnown(null);
    sync.schedule("older");
    const olderFlush = sync.flush();
    await Promise.resolve();
    await Promise.resolve();

    sync.schedule("newer");
    await sync.flushForLifecycle();
    expect(keepaliveExpected).toEqual([[null, "older"]]);

    // The server returns its current newer handle for the stale older write.
    resolveOlder("newer");
    await olderFlush;
    await sync.flushForLifecycle();
    expect(keepaliveExpected).toHaveLength(1);
  });

  it("includes every in-flight lifecycle handle as an allowed predecessor", async () => {
    const resolvers = new Map<string, (persisted: string | null) => void>();
    const expectedByHandle = new Map<string, readonly (string | null)[]>();
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle) => handle,
      putKeepalive: (handle, options) => {
        if (handle === null) return Promise.resolve(null);
        expectedByHandle.set(handle, options.expectedHandles);
        return new Promise<string | null>((resolve) => {
          resolvers.set(handle, resolve);
        });
      },
    });
    sync.noteKnown(null);

    sync.schedule("lifecycle-a");
    const flushA = sync.flushForLifecycle();
    await Promise.resolve();
    sync.schedule("lifecycle-b");
    const flushB = sync.flushForLifecycle();
    await Promise.resolve();
    sync.schedule("lifecycle-c");
    const flushC = sync.flushForLifecycle();
    await Promise.resolve();

    expect(expectedByHandle.get("lifecycle-b")).toEqual([null, "lifecycle-a"]);
    expect(expectedByHandle.get("lifecycle-c")).toEqual([null, "lifecycle-a", "lifecycle-b"]);

    resolvers.get("lifecycle-a")?.("lifecycle-a");
    resolvers.get("lifecycle-b")?.("lifecycle-b");
    resolvers.get("lifecycle-c")?.("lifecycle-c");
    await Promise.all([flushA, flushB, flushC]);
  });

  it("retries the latest normal write after a stale no-op response", async () => {
    let serverHandle: string | null = "server-current";
    const expectedWrites: Array<readonly (string | null)[]> = [];
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle, options) => {
        expectedWrites.push(options.expectedHandles);
        if (options.expectedHandles.includes(serverHandle)) serverHandle = handle;
        return serverHandle;
      },
    });
    sync.noteKnown("client-stale");
    sync.schedule("latest");
    await sync.flush();

    expect(expectedWrites).toEqual([["client-stale"], ["server-current"]]);
    expect(serverHandle).toBe("latest");
  });
});
