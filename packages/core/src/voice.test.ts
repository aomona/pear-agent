import { describe, expect, it, vi } from "vitest";

import {
  createVoiceLease,
  expireVoiceLease,
  FakeVoiceProvider,
  isVoiceLeaseActive,
  releaseVoiceLease,
  voiceLeaseSchema,
  voiceSessionStatusSchema,
} from "./voice.js";

describe("voiceLeaseSchema", () => {
  it("parses a lease with ISO dates", () => {
    const lease = voiceLeaseSchema.parse({
      id: "lease-1",
      sessionId: "s1",
      actorId: "user-1",
      status: "active",
      acquiredAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-07-11T00:30:00.000Z",
      providerResumeHandle: null,
    });
    expect(lease.acquiredAt).toBeInstanceOf(Date);
    expect(lease.expiresAt.toISOString()).toBe("2026-07-11T00:30:00.000Z");
  });
});

describe("createVoiceLease / release / expire", () => {
  it("creates an active lease with default TTL", () => {
    const acquiredAt = new Date("2026-07-11T00:00:00.000Z");
    const lease = createVoiceLease({
      id: "l1",
      sessionId: "s1",
      actorId: "a1",
      acquiredAt,
    });
    expect(lease.status).toBe("active");
    expect(lease.expiresAt.getTime() - acquiredAt.getTime()).toBe(30 * 60 * 1000);
    expect(isVoiceLeaseActive(lease, acquiredAt)).toBe(true);
  });

  it("releases without mutating session state (lease only)", () => {
    const lease = createVoiceLease({ id: "l1", sessionId: "s1", actorId: "a1" });
    const released = releaseVoiceLease(lease);
    expect(released.status).toBe("released");
    expect(isVoiceLeaseActive(released)).toBe(false);
  });

  it("expires when past expiresAt", () => {
    const lease = createVoiceLease({
      id: "l1",
      sessionId: "s1",
      actorId: "a1",
      acquiredAt: new Date("2026-07-11T00:00:00.000Z"),
      expiresAt: new Date("2026-07-11T00:10:00.000Z"),
    });
    const expired = expireVoiceLease(lease, new Date("2026-07-11T00:11:00.000Z"));
    expect(expired.status).toBe("expired");
  });
});

describe("FakeVoiceProvider", () => {
  it("connects, accepts audio, and disconnects without network", async () => {
    const provider = new FakeVoiceProvider();
    const statuses: string[] = [];
    const connection = await provider.connect({
      credentials: { token: "test-token", model: "fake" },
    });
    connection.on("status", (s) => statuses.push(s));
    expect(connection.status).toBe("connected");

    connection.sendAudio(new Uint8Array([1, 2, 3]));
    connection.mute();
    expect(connection.status).toBe("muted");
    connection.unmute();
    expect(connection.status).toBe("connected");

    await connection.disconnect();
    expect(connection.status).toBe("disconnected");
    expect(voiceSessionStatusSchema.parse("disconnected")).toBe("disconnected");
  });

  it("emits tool calls and records tool responses", async () => {
    const provider = new FakeVoiceProvider();
    const connection = await provider.connect({ credentials: { token: "t" } });
    const onTools = vi.fn();
    connection.on("toolCall", onTools);

    (connection as import("./voice.js").FakeVoiceConnection).emitToolCalls([
      { id: "c1", name: "complete_step", args: { stepId: "pack" } },
    ]);

    expect(onTools).toHaveBeenCalledWith([
      { id: "c1", name: "complete_step", args: { stepId: "pack" } },
    ]);

    connection.sendToolResponse([{ id: "c1", name: "complete_step", response: { ok: true } }]);
    expect((connection as import("./voice.js").FakeVoiceConnection).toolResponses).toHaveLength(1);
  });

  it("emits resume handles", async () => {
    const provider = new FakeVoiceProvider();
    const connection = await provider.connect({ credentials: { token: "t" } });
    const onHandle = vi.fn();
    connection.on("resumeHandle", onHandle);
    (connection as import("./voice.js").FakeVoiceConnection).emitResumeHandle("handle-abc");
    expect(onHandle).toHaveBeenCalledWith("handle-abc");
  });
});
