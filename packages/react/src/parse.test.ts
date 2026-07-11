import { describe, expect, it } from "vitest";

import { parseSyncState } from "./parse.js";
import { sampleSnapshot } from "./test-fixtures.js";

describe("parseSyncState", () => {
  it("parses agent broadcast payload with nested snapshot", () => {
    const parsed = parseSyncState({
      revision: 3,
      snapshot: sampleSnapshot,
      continuation: null,
    });

    expect(parsed.revision).toBe(3);
    expect(parsed.snapshot?.session.id).toBe("s1");
    expect(parsed.continuation).toBeNull();
  });

  it("accepts empty snapshot mirror", () => {
    const parsed = parseSyncState({
      revision: 0,
      snapshot: null,
      continuation: null,
    });
    expect(parsed.snapshot).toBeNull();
  });
});
