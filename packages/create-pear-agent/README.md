# create-pear-agent

Scaffold an editable PEAR Runtime app with Cloudflare Worker, D1, R2, Agents, and React.

## Usage

From npm:

```bash
pnpm dlx create-pear-agent@beta my-agent
```

From this monorepo:

```bash
pnpm create-pear-agent examples/my-agent
```

The default Minimal Starter has four editable pages: plan list, input, plan review, and execution. Start your changes in `src/app/pages/`, `src/domain/`, and `src/pear.config.ts`.

The Outing reference application is monorepo-only during the beta:

```bash
pnpm dlx create-pear-agent@beta my-outing --example outing --from ../pear-agent
```

## Options

| Flag                | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `--example outing`  | Monorepo example; requires `--from` or `PEAR_AGENT_ROOT` on npm   |
| `--from <path>`     | pear-agent monorepo root for `workspace:` or `file:` package deps |
| `--template <path>` | Override the template directory                                   |

## Notes

- Minimal Starter source of truth: `packages/create-pear-agent/templates/minimal`
- Registry mode preserves exact `0.1.0-beta.1` PEAR dependencies and adds no overrides
- The generated project owns `migrations/0001_init.sql` and points Wrangler at `migrations`
- Outing source of truth: `examples/outing-agent`; it is not bundled in the npm package
- Inside the monorepo, dependencies use `workspace:*`; an explicit external root uses `file:`
