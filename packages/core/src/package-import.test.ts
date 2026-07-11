import { describe, expect, it } from "vitest";

import {
  defineDomain,
  evaluateGoalCompletion,
  transitionStep,
  validatePlanGraph,
} from "@pear-agent/core";

describe("@pear-agent/core public API", () => {
  it.each([
    ["defineDomain", defineDomain],
    ["evaluateGoalCompletion", evaluateGoalCompletion],
    ["transitionStep", transitionStep],
    ["validatePlanGraph", validatePlanGraph],
  ])("exports %s as a function", (_name, exportedValue) => {
    expect(exportedValue).toBeTypeOf("function");
  });
});
