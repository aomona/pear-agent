/** Cloudflare bindings required by `@pear-agent/cloudflare`. */
import type { PlanCompileWorkflowParams } from "./plans/compile-runner.js";

export type PearEnv = {
  DB: D1Database;
  RAW_INPUTS: R2Bucket;
  // Typed loosely so hosts can export ExecutionSessionAgent without circular imports.
  ExecutionSessionAgent: DurableObjectNamespace;
  /**
   * Server-only Gemini API key for Live ephemeral token minting (Issue #6).
   * Never send to clients. Optional so non-voice tests can omit it.
   */
  GEMINI_API_KEY?: string;
  /** Optional durable compile dispatcher used by the AI-first starter. */
  PLAN_COMPILE_WORKFLOW?: Workflow<PlanCompileWorkflowParams>;
};
