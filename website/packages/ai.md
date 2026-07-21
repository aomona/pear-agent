# `@pear-agent/ai`

Provider-neutral structured generation for the PEAR compile and replan lifecycles.

```bash
pnpm add @pear-agent/ai@beta ai zod
```

Add the AI SDK provider package chosen by the host. Gemini is verified:

```bash
pnpm add @ai-sdk/google
```

## Public factories

- `createAiSourceInterpreter()` — Sources to normalized Domain input or clarification;
- `createAiPlanGenerator()` — normalized input and goal to a typed Plan DAG;
- `createAiPlanCompiler()` — bounded interpretation + planning composition;
- `createAiPlanImprover()` — reviewable edits;
- replan generators — affected-subgraph patch proposals;
- `generateStructured()` — shared schema/retry/usage boundary.

Provider models and credentials are created by Worker/host code. Core never imports this package.

See [Compile with AI](/guide/ai-compilation).
