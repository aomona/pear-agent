# AI-native Plan Compiler / Runtime v0.1

## Decision

PEAR Runtime v0.1 is an AI-native execution-plan compiler and durable runtime for
TypeScript application developers.

```text
Sources -> Interpret -> Clarify -> Plan -> Review -> Execute -> Assess -> Replan
```

The default path uses an LLM. Deterministic interpreters, planners, and replanners
remain explicit adapters for tests, offline applications, and constrained domains.
AI output is always a proposal: PEAR assigns identity, validates schemas and domain
invariants, records provenance, and owns every durable state transition.

## Product contract

- A Plan Artifact is compiled from text, public URLs, and supported files.
- Source interpretation and plan synthesis are observable phases of one durable job.
- Material ambiguity produces a clarification request; minor assumptions are recorded.
- The initial plan and every natural-language edit are reviewed before becoming ready.
- Execution Sessions fork a ready Plan Artifact version and then evolve independently.
- Runtime replanning proposes the smallest valid patch and defaults to confirmation.
- Gemini is the v0.1 verified provider. Vercel AI SDK keeps text generation provider-neutral.
- Gemini Live is the v0.1 verified realtime provider. Voice Sessions remain ephemeral.

## Package boundaries

- `@pear-agent/core`: environment-free schemas, ports, validation, reducers, and diff models.
- `@pear-agent/ai`: Vercel AI SDK implementations of interpretation, planning, editing, and replanning.
- `@pear-agent/cloudflare`: Workflows, Agents/DO, D1, R2, authorization, and HTTP adapters.
- `@pear-agent/react`: typed clients and hooks only; applications own UI.
- `create-pear-agent`: AI-first Minimal Starter (default). Outing remains an optional compatibility example.

Core never imports Cloudflare, React, Gemini, or AI SDK. Provider keys, authentication,
authorization, and user data stay in the host application's Cloudflare account.

## Identity and provenance

Runtime-generated identifiers are authoritative for artifacts, jobs, patches, and steps.
Every generated step references its source artifacts. Every change references one or more
typed causes: source, user instruction, clarification answer, or runtime event.
Generation records retain provider/model, prompt and schema versions, usage, validation,
and warnings, but not raw prompts or raw provider responses by default.

## Safety defaults

- Initial plan: draft until explicitly marked ready.
- Draft edit: diff confirmation required.
- Runtime replan: confirmation required.
- Completed or skipped steps: immutable.
- Active step changes: pause and human confirmation required.
- AI failure: bounded retry, then an inspectable error; no implicit deterministic fallback.
- Realtime: only high-confidence, low-risk observations may be recorded automatically.

## Reference applications (v0.1 scope)

v0.1 ships **Runtime packages + AI-first Minimal Starter**. The starter exercises
Sources → Compile → Review → Execute with a generic Domain. Outing remains a compatibility
sample under `examples/`.

Cook (multi-recipe schedule + delay replan) and Presentation (PDF timing slice) are
**out of v0.1** and will be built later as separate Domain / app deliverables—not as
Runtime packages.

## Delivery

All implementation branches target `feat/ai-native-runtime`. The integration branch targets
`dev` only after the full local gate and Minimal Starter compile/execute smoke pass.
The v0.1 development database is reset to a new migration baseline; pre-v0.1 persisted
data is not migrated.
