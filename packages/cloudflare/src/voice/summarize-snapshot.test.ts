import type { RuntimeSnapshot } from "@pear-agent/core";
import { describe, expect, it } from "vitest";

import { summarizeSnapshotForVoice } from "./snapshot-summary.js";

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
  it("exposes steps with timers and focusStepId without redundant mirrors", () => {
    const summary = summarizeSnapshotForVoice(minimalSnapshot());
    expect(summary.focusStepId).toBe("charge");
    expect(summary.steps).toEqual([
      {
        id: "charge",
        label: "Charge devices",
        status: "active",
        estimatedDurationSeconds: 300,
        instructions: "Plug in phone",
        timers: [
          {
            id: "charge-wait",
            label: "Charge wait",
            durationSeconds: 300,
            autoStart: false,
          },
        ],
      },
    ]);
    // Redundant fields must stay gone (keeps Live token small).
    expect(summary).not.toHaveProperty("stepStates");
    expect(summary).not.toHaveProperty("planTimers");
    expect(summary).not.toHaveProperty("focusStep");
  });
});
