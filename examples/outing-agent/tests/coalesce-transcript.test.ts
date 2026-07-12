import { describe, expect, it } from "vitest";

import { coalesceTranscript } from "../web/src/lib/coalesce-transcript.js";

describe("coalesceTranscript", () => {
  it("merges cumulative assistant partials into one readable turn", () => {
    const turns = coalesceTranscript([
      { role: "assistant", text: "し" },
      { role: "assistant", text: "したい" },
      { role: "assistant", text: "したい時は、" },
      { role: "assistant", text: "したい時は、いつでも" },
      { role: "assistant", text: "したい時は、いつでもお声" },
      { role: "assistant", text: "したい時は、いつでもお声がけ" },
      { role: "assistant", text: "したい時は、いつでもお声がけくださ" },
      { role: "assistant", text: "したい時は、いつでもお声がけください。" },
    ]);
    expect(turns).toEqual([{ role: "assistant", text: "したい時は、いつでもお声がけください。" }]);
  });

  it("appends delta fragments when not cumulative", () => {
    const turns = coalesceTranscript([
      { role: "assistant", text: "こんにちは" },
      { role: "assistant", text: "。準備" },
      { role: "assistant", text: "しましょう" },
    ]);
    expect(turns).toEqual([{ role: "assistant", text: "こんにちは。準備しましょう" }]);
  });

  it("splits turns when speaker changes", () => {
    const turns = coalesceTranscript([
      { role: "user", text: "荷物は？" },
      { role: "assistant", text: "鍵と" },
      { role: "assistant", text: "鍵と携帯です" },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "荷物は？" },
      { role: "assistant", text: "鍵と携帯です" },
    ]);
  });
});
