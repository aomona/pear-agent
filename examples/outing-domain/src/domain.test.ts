import { describe, expect, it } from "vitest";

import {
  executionPlanSchema,
  parseDomainEvent,
  parseDomainWorldStateFacts,
  worldStateSchema,
} from "@pear-agent/core";

import {
  assessOutingDelayReplan,
  buildOutingDelayPatch,
  buildOutingPlan,
  buildOutingWorldState,
  initialOutingWorldState,
  outingDomain,
  outingGoal,
  outingPlan,
  OUTING_CHARGE_TIMER_ID,
  OUTING_DELAY_CHARGE_EXTENSION_SECONDS,
  reconcileOutingWorldState,
} from "./domain.js";

describe("outingDomain", () => {
  it("normalizes structured departure, belongings, tasks, and places", async () => {
    await expect(
      outingDomain.normalizeInput({
        departureAt: "2026-07-11T03:00:00Z",
        belongings: [
          { id: "phone", name: "Phone", chargePercent: 80 },
          { id: "keys", name: "Keys" },
        ],
        tasks: [{ id: "weather", title: "Check weather" }],
        originLabel: "Home",
        destinationLabel: "Station",
      }),
    ).resolves.toEqual({
      departureAt: "2026-07-11T03:00:00Z",
      belongings: [
        { id: "phone", name: "Phone", chargePercent: 80 },
        { id: "keys", name: "Keys", chargePercent: null },
      ],
      tasks: [
        { id: "weather", title: "Check weather", estimatedDurationSeconds: null, notes: null },
      ],
      originLabel: "Home",
      destinationLabel: "Station",
    });
  });

  it("requires freeTextResolver for free-text fields (no deterministic free-text path)", async () => {
    await expect(
      outingDomain.normalizeInput({
        departureAt: { freeText: "2026-07-11T03:00:00.000Z" },
        belongings: { freeText: "phone:Phone:80" },
      }),
    ).rejects.toThrow(/no freeTextResolver/);
  });

  it("uses freeTextResolver for all free-text fields", async () => {
    await expect(
      outingDomain.normalizeInput(
        {
          departureAt: { freeText: "tomorrow morning" },
          belongings: { freeText: "whatever the model says" },
        },
        {
          freeTextResolver: {
            async resolve({ field }) {
              if (field === "departureAt") return "2026-07-12T00:00:00.000Z";
              if (field === "belongings") {
                return [{ id: "wallet", name: "Wallet", chargePercent: 10 }];
              }
              throw new Error(`unexpected field ${field}`);
            },
          },
        },
      ),
    ).resolves.toEqual({
      departureAt: "2026-07-12T00:00:00.000Z",
      belongings: [{ id: "wallet", name: "Wallet", chargePercent: 10 }],
      tasks: [],
      originLabel: null,
      destinationLabel: null,
    });
  });

  it("accepts a delay event via domain schema and runtime domain_event mapping", () => {
    expect(outingDomain.schemas.events.parse({ type: "delay", minutes: 15 })).toEqual({
      type: "delay",
      minutes: 15,
    });
    expect(
      parseDomainEvent(outingDomain.schemas.events, {
        domainType: "delay",
        payload: { minutes: 15 },
      }),
    ).toEqual({ type: "delay", minutes: 15 });
  });

  it("provides a valid execution goal, parallel plan, and domain facts in WorldState", () => {
    expect(executionPlanSchema(outingDomain.schemas.stepData).parse(outingPlan).goal).toEqual(
      outingGoal,
    );
    expect(outingPlan.steps.map(({ after, id }) => ({ after, id }))).toEqual([
      { id: "pack", after: [] },
      { id: "charge", after: [] },
    ]);
    expect(worldStateSchema.parse(initialOutingWorldState)).toEqual(initialOutingWorldState);
    expect(
      parseDomainWorldStateFacts(outingDomain.schemas.worldState, initialOutingWorldState),
    ).toEqual({
      departureAt: "2026-07-11T03:00:00Z",
      packedBelongingIds: [],
      chargeByBelongingId: { keys: null, phone: 20 },
    });
  });

  it("builds plan and world state from normalized input", () => {
    const normalized = {
      departureAt: "2026-08-20T09:00:00Z",
      belongings: [
        { id: "wallet", name: "Wallet", chargePercent: null },
        { id: "laptop", name: "Laptop", chargePercent: 40 },
      ],
      tasks: [{ id: "lock", title: "Lock the door", estimatedDurationSeconds: 30, notes: null }],
      originLabel: "Home",
      destinationLabel: "Office",
    };
    const plan = buildOutingPlan(normalized);
    expect(plan.steps.map((s) => s.id)).toEqual(["pack", "charge", "task:lock"]);
    expect(plan.steps.find((s) => s.id === "pack")?.domainData.belongingIds).toEqual([
      "wallet",
      "laptop",
    ]);
    expect(plan.steps.find((s) => s.id === "charge")?.domainData.belongingIds).toEqual(["laptop"]);
    expect(plan.steps.find((s) => s.id === "charge")?.timers).toEqual([
      {
        id: OUTING_CHARGE_TIMER_ID,
        label: "Charge wait",
        durationSeconds: 300,
        autoStart: false,
      },
    ]);
    expect(plan.steps.find((s) => s.id === "task:lock")?.label).toBe("Lock the door");
    expect(plan.title).toBe("Home → Office");
    expect(plan.metadata?.originLabel).toBe("Home");

    const world = buildOutingWorldState(normalized, {
      updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(parseDomainWorldStateFacts(outingDomain.schemas.worldState, world)).toEqual({
      departureAt: "2026-08-20T09:00:00Z",
      packedBelongingIds: [],
      chargeByBelongingId: { wallet: null, laptop: 40 },
    });
  });

  it("builds task-only plan without belongings", () => {
    const plan = buildOutingPlan({
      departureAt: "2026-08-20T09:00:00Z",
      belongings: [],
      tasks: [{ id: "shoes", title: "Put on shoes", estimatedDurationSeconds: null, notes: null }],
      originLabel: null,
      destinationLabel: null,
    });
    expect(plan.steps.map((s) => s.id)).toEqual(["task:shoes"]);
    expect(plan.title).toBe("Outing preparation");
  });

  it("assesses delay events and builds a charge-only patch", () => {
    const delayEvent = {
      id: "evt-delay-1",
      type: "domain_event",
      domainType: "delay",
      payload: { minutes: 15 },
    };
    const assessment = assessOutingDelayReplan({ recentEvents: [delayEvent] });
    expect(assessment.needsReplan).toBe(true);
    expect(assessment.directlyAffectedStepIds).toEqual(["charge"]);

    const patch = buildOutingDelayPatch({
      plan: outingPlan,
      assessment,
      affectedStepIds: ["charge"],
      recentEvents: [delayEvent],
      patchId: "patch-1",
    });
    expect(patch.affectedStepIds).toEqual(["charge"]);
    expect(patch.operations).toHaveLength(1);
    const op = patch.operations[0];
    expect(op?.type).toBe("update_step");
    if (op?.type === "update_step") {
      expect(op.step.estimatedDurationSeconds).toBe(
        (outingPlan.steps.find((s) => s.id === "charge")?.estimatedDurationSeconds ?? 0) +
          OUTING_DELAY_CHARGE_EXTENSION_SECONDS,
      );
    }
  });

  it("reconciles world state with plan utilization resource", () => {
    const next = reconcileOutingWorldState(outingPlan, initialOutingWorldState);
    expect(next.resources.some((r) => r.id === "plan-utilization")).toBe(true);
  });
});
