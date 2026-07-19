import { describe, expect, it } from "vitest";

import {
  assertPlanMatchesGoal,
  buildPlanPresentation,
  createStaticPlanGenerator,
  createStaticPlanImprover,
  createWorldStateFromDomainFacts,
  defineDomain,
  diffPlans,
  evaluateGoalCompletion,
  parseDomainEvent,
  parseDomainWorldStateFacts,
  schedulePlan,
  transitionStep,
  validatePlanGraph,
} from "@pear-agent/core";

describe("@pear-agent/core public API", () => {
  it.each([
    ["defineDomain", defineDomain],
    ["evaluateGoalCompletion", evaluateGoalCompletion],
    ["transitionStep", transitionStep],
    ["validatePlanGraph", validatePlanGraph],
    ["createWorldStateFromDomainFacts", createWorldStateFromDomainFacts],
    ["parseDomainWorldStateFacts", parseDomainWorldStateFacts],
    ["parseDomainEvent", parseDomainEvent],
    ["buildPlanPresentation", buildPlanPresentation],
    ["createStaticPlanGenerator", createStaticPlanGenerator],
    ["schedulePlan", schedulePlan],
    ["diffPlans", diffPlans],
    ["assertPlanMatchesGoal", assertPlanMatchesGoal],
    ["createStaticPlanImprover", createStaticPlanImprover],
  ])("exports %s as a function", (_name, exportedValue) => {
    expect(exportedValue).toBeTypeOf("function");
  });
});
