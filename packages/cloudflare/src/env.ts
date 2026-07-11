/** Cloudflare bindings required by `@pear-agent/cloudflare`. */
export type PearEnv = {
  DB: D1Database;
  RAW_INPUTS: R2Bucket;
  // Typed loosely so hosts can export ExecutionSessionAgent without circular imports.
  ExecutionSessionAgent: DurableObjectNamespace;
};
