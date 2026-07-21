# Define a Domain

A Domain gives generic Runtime contracts product meaning. It defines what source material compiles into, what a step carries, which facts describe the world, and what policy makes a plan valid.

## Start from schemas

```ts
import { defineAiDomain, sourceReferenceSchema } from "@pear-agent/core";
import { z } from "zod";

export const taskDomain = defineAiDomain({
  id: "task-ops",
  version: 1,
  schemas: {
    compileInput: z.object({ request: z.string().trim().min(1).max(20_000) }),
    normalizedInput: z.object({
      title: z.string().trim().min(1),
      tasks: z.array(
        z.object({
          title: z.string().trim().min(1),
          sourceRefs: z.array(sourceReferenceSchema).min(1),
        }),
      ),
      constraints: z.array(z.string()).default([]),
    }),
    stepData: z.object({ task: z.string().min(1) }),
    worldState: z.object({ notes: z.array(z.string()) }),
    events: z.discriminatedUnion("type", [
      z.object({ type: z.literal("constraint_changed"), note: z.string().min(1) }),
    ]),
  },
  interpretation: {
    instructions: "Extract a concise task model and preserve source provenance.",
  },
  planning: {
    instructions: "Create an executable DAG and parallelize independent work.",
    objectives: ["Make the next action obvious", "Respect constraints"],
    validatePlan(plan) {
      const issues = plan.steps.flatMap((step) =>
        step.sourceRefs?.length ? [] : [`Step ${step.id} needs a source reference`],
      );
      return { valid: plan.steps.length > 0 && issues.length === 0, issues };
    },
  },
  replanning: {
    instructions: "Preserve completed work and update only affected steps.",
    defaultMode: "confirm",
    reconcileWorldState(_plan, worldState) {
      return worldState;
    },
  },
  capabilities: [],
  completionPolicy: "automatic",
});
```

Infer TypeScript types from schemas where practical. Parse HTTP, persistence, Domain, and AI boundaries instead of casting values into trusted types.

## Schema roles

- `compileInput`: the user's request/configuration for one compile.
- `normalizedInput`: structured interpretation shared with planning and review UI.
- `stepData`: Domain payload carried by each Plan step.
- `worldState`: the schema for Domain facts stored inside `WorldState.facts`.
- `events`: Domain-originated observations accepted by Runtime.

Runtime fields such as resources, observations, constraints, timers, and step state already have Core contracts. Do not recreate them inside Domain facts.

## Planning policy

Instructions tell the model how to plan; deterministic validation decides whether output is acceptable. Validate the properties that matter to your product: provenance, capability policy, required resources, ordering constraints, and Domain step data.

Core also rejects invalid graph structure: duplicate IDs, unknown dependencies, and cycles.

## Replan policy

Choose the safest default mode the Domain needs:

- `automatic`: only changes that remain safe under Runtime and capability policy;
- `confirm`: persist a proposal and require a human decision;
- `suggest`: advisory output without activation.

`reconcileWorldState` is not optional bookkeeping. Use it to validate facts and requirements against the candidate plan and recalculate resource utilization.

## Version changes

Increment `version` when persisted Domain interpretation changes. A session and its plan carry the Domain version so stale plan patches and mismatched data can be rejected rather than guessed into compatibility.
