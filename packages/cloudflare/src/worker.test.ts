import { describe, expect, it } from "vitest";

import { sessionIdFromAgentRequest } from "./worker.js";

describe("sessionIdFromAgentRequest", () => {
  it("extracts and decodes the agent instance name", () => {
    const request = new Request(
      "https://worker.example/agents/execution-session-agent/session%2Fabc?pearContext=%7B%7D",
    );
    expect(sessionIdFromAgentRequest(request)).toBe("session/abc");
  });

  it("returns null when path is not an agent route", () => {
    expect(sessionIdFromAgentRequest(new Request("https://worker.example/sessions/s1"))).toBeNull();
  });
});
