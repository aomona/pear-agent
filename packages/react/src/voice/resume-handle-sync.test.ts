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
    const sync = createResumeHandleSync({
      debounceMs: 60_000,
      put: async (handle) => {
        writes.push(handle);
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
    expect(writes).toEqual(["hidden-handle"]);

    visibilityTarget.dispatchEvent(new Event("visibilitychange"));
    await sync.flush();
    expect(writes).toEqual(["hidden-handle"]);

    sync.schedule("pagehide-handle");
    pageTarget.dispatchEvent(new Event("pagehide"));
    await vi.runAllTicks();
    await sync.flush();
    expect(writes).toEqual(["hidden-handle", "pagehide-handle"]);

    detach();
    vi.useRealTimers();
  });
});
