import { describe, expect, it } from "vitest";

import {
  buildPlanPresentation,
  createStaticPlanGenerator,
  createWorldStateFromDomainFacts,
  defineDomain,
  evaluateGoalCompletion,
  parseDomainEvent,
  parseDomainWorldStateFacts,
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
  ])("exports %s as a function", (_name, exportedValue) => {
    expect(exportedValue).toBeTypeOf("function");
  });
});
