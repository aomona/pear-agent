# `@pear-agent/react`

Typed clients and hooks for PEAR applications, without a fixed UI kit.

```bash
pnpm add @pear-agent/react@beta @pear-agent/core@beta react agents
```

`agents` powers realtime Agent WebSocket sync. Use `realtime={false}` for HTTP-only tools and tests.

## Public surface

- `PearClient` — typed HTTP operations;
- `PearProvider` — base URL, context, realtime, and client configuration;
- `useExecutionSession()` — create/bind and mutate a session;
- `useRuntimeSnapshot()` — HTTP hydration plus invalidation-driven refetch;
- `useContinuation()` — suspend and resume lifecycle;
- `useVoiceSession()` — lease, token, browser media, and tool bridge;
- plan compiler and plan library hooks for the four-page flow.

See [Connect React](/guide/react) and the package [README](https://github.com/aomona/pear-agent/tree/dev/packages/react).
