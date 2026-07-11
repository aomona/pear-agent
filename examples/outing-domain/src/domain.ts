import { defineDomain } from "@pear-agent/core";
import { z } from "zod";

const belongingInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chargePercent: z.number().min(0).max(100).optional(),
});

const belongingSchema = belongingInputSchema.extend({
  chargePercent: z.number().min(0).max(100).nullable(),
});

export const outingDomain = defineDomain({
  id: "outing",
  version: 1,
  schemas: {
    input: z.object({
      departureAt: z.iso.datetime(),
      belongings: z.array(belongingInputSchema),
    }),
    normalizedInput: z.object({
      departureAt: z.iso.datetime(),
      belongings: z.array(belongingSchema),
    }),
    stepData: z.object({
      belongingIds: z.array(z.string().min(1)),
    }),
    worldState: z.object({
      packedBelongingIds: z.array(z.string().min(1)),
      chargeByBelongingId: z.record(z.string(), z.number().min(0).max(100).nullable()),
    }),
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("delay"), minutes: z.number().positive() }),
    ]),
  },
  normalizeInput: async ({ departureAt, belongings }) => ({
    departureAt,
    belongings: belongings.map((belonging) => ({
      ...belonging,
      chargePercent: belonging.chargePercent ?? null,
    })),
  }),
  planning: {
    instructions: "出発時刻までに必要な持ち物と充電状態を整える",
    objectives: ["必要な持ち物を揃える", "必要な機器を充電する"],
  },
  replanning: {
    instructions: "遅延の影響を受ける準備だけを更新する",
    defaultMode: "automatic",
  },
  capabilities: [],
  completionPolicy: "automatic",
});
