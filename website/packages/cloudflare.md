# `@pear-agent/cloudflare`

Cloudflare adapter for the durable PEAR Runtime.

```bash
pnpm add @pear-agent/cloudflare@beta
pnpm add -D wrangler @cloudflare/workers-types
```

## Owns

- `createPearWorker()` / `createPearApp()` Hono routes and centralized errors;
- `ExecutionSessionAgent` serialized session mutation and invalidation;
- D1/Drizzle repositories for plans, events, state, compile, continuations, voice leases, and patches;
- R2 source storage;
- compile Workflow runner;
- host-injected authorization, Domain, AI, voice, and replan ports.

D1 is authoritative. Agent WebSockets signal invalidation; clients refetch HTTP Snapshots.

See [Wire Cloudflare](/guide/cloudflare) and the package [README](https://github.com/aomona/pear-agent/tree/dev/packages/cloudflare).
