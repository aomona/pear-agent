import { describe, expect, it } from "vitest";

import { parseSyncState } from "./parse.js";

describe("parseSyncState", () => {
  it("parses agent invalidation pulse", () => {
    const parsed = parseSyncState({
      revision: 3,
      lastEventId: "evt-9",
      continuation: null,
    });

    expect(parsed.revision).toBe(3);
    expect(parsed.lastEventId).toBe("evt-9");
    expect(parsed.continuation).toBeNull();
  });

  it("defaults lastEventId and continuation when omitted", () => {
    const parsed = parseSyncState({
      revision: 0,
    });
    expect(parsed.lastEventId).toBeNull();
    expect(parsed.continuation).toBeNull();
  });
});
