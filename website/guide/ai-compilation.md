# Compile with AI

`@pear-agent/ai` composes structured interpretation, planning, editing, and replanning through the Vercel AI SDK. Gemini is the verified provider, but the package boundary is provider-neutral.

## Create the model on the Worker

```ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  DEFAULT_GEMINI_TEXT_MODEL,
  createAiPlanCompiler,
  createAiPlanGenerator,
  createAiSourceInterpreter,
} from "@pear-agent/ai";

const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
const model = google(DEFAULT_GEMINI_TEXT_MODEL);

const interpreter = createAiSourceInterpreter({
  model,
  normalizedInputSchema: taskDomain.schemas.normalizedInput,
});

const planner = createAiPlanGenerator({
  model,
  stepDataSchema: taskDomain.schemas.stepData,
});

const compiler = createAiPlanCompiler({
  domainVersion: taskDomain.version,
  interpretationInstructions: taskDomain.interpretation.instructions,
  planningInstructions: taskDomain.planning.instructions,
  planningObjectives: taskDomain.planning.objectives,
  interpreter,
  planner,
  validateCompileInput: (input) => taskDomain.schemas.compileInput.parse(input),
  validateNormalizedInput: (input) => taskDomain.schemas.normalizedInput.parse(input),
  async validatePlan({ plan }) {
    const result = await taskDomain.planning.validatePlan?.(plan);
    if (result && !result.valid) throw new Error(result.issues.join("; "));
  },
});
```

Check the current factory signatures in the package types when integrating: provider options remain explicit and may gain validated capabilities during beta.

## Durable compile phases

A compile job records phases rather than hiding one long model call:

1. read durable source metadata and bytes;
2. interpret sources into normalized input;
3. stop for clarification when ambiguity materially changes execution;
4. synthesize a Plan DAG;
5. run Zod, graph, goal, capability, and Domain validation;
6. write a new immutable Plan Artifact version.

The UI can poll job status, cancel work, answer clarifications, and retry eligible failures.

## Budgets and cancellation

Pass the compile job's `AbortSignal` into AI work. Keep phase attempts, total model calls, and total token use bounded. Provider failure must remain failure: do not silently substitute a deterministic plan and label the compile successful.

Deterministic fallback plans are useful only as an explicit local/demo mode that the host can identify.

## Source provenance

Interpretation should emit references into the original source set. Planning carries those references onto steps. Preserve them through editing and replanning so reviewers can answer “why is this step here?” without inspecting provider traces.

## Test without network calls

Inject fake structured generators and fixed usage metadata. Tests should cover clarification, malformed structured output, validation rejection, cancellation, bounded retry, and budget exhaustion without calling Gemini or the network.
