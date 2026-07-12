import type { RuntimeSnapshot } from "@pear-agent/core";
import { describe, expect, it } from "vitest";

import { summarizeSnapshotForVoice } from "./tools.js";

function minimalSnapshot(): RuntimeSnapshot {
  const now = new Date("2026-07-12T00:00:00.000Z");
  return {
    plan: {
      id: "plan-1",
      version: 1,
      title: "Home → Office",
      goal: {
        id: "leave-on-time",
        description: "Leave on time",
        successCriteria: [],
      },
      steps: [
        {
          id: "charge",
          label: "Charge devices",
          summary: "Charge",
          instructions: "Plug in phone",
          executor: { type: "human" },
          after: [],
          requirements: [],
          estimatedDurationSeconds: 300,
          timers: [
            {
              id: "charge-wait",
              label: "Charge wait",
              durationSeconds: 300,
              autoStart: false,
            },
          ],
          domainData: {},
        },
      ],
    },
    session: {
      id: "s1",
      status: "active",
      actorIds: ["u1"],
      createdAt: now,
      updatedAt: now,
    },
    worldState: { facts: {}, revisedAt: now },
    stepStates: {
      charge: { status: "active", updatedAt: now },
    },
    activeTimers: [],
    recentEvents: [],
    readyStepIds: [],
    activeStepIds: ["charge"],
    blockedStepIds: [],
    continuation: null,
    latestPlanChange: null,
    generatedAt: now,
  } as RuntimeSnapshot;
}

describe("summarizeSnapshotForVoice", () => {
  it("exposes plan timer definitions for start_timer", () => {
    const summary = summarizeSnapshotForVoice(minimalSnapshot());
    expect(summary.planTimers).toEqual([
      {
        id: "charge-wait",
        label: "Charge wait",
        durationSeconds: 300,
        autoStart: false,
        stepId: "charge",
        stepLabel: "Charge devices",
      },
    ]);
    expect(summary.focusStep).toMatchObject({
      id: "charge",
      status: "active",
      timers: [{ id: "charge-wait", durationSeconds: 300 }],
    });
  });
});
