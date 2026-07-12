# create-pear-agent

Scaffold a deployable PEAR Runtime outing sample (Cloudflare Worker + React + shadcn/ui).

## Usage

From the monorepo (packages are not published yet):

```bash
pnpm --filter create-pear-agent exec node --experimental-strip-types src/cli.ts ../../examples/my-agent
# or after install:
pnpm create pear-agent my-agent   # when published as create-pear-agent on npm
```

Local bin:

```bash
node --experimental-strip-types packages/create-pear-agent/src/cli.ts my-agent --from .
```

## Options

| Flag                | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `--from <path>`     | pear-agent monorepo root for `file:` package deps    |
| `--template <path>` | Override template (default: `examples/outing-agent`) |

## Notes

- Template source of truth: `examples/outing-agent`
- Inside the monorepo, dependencies stay `workspace:*`
- Outside, use `--from` / `PEAR_AGENT_ROOT` so `@pear-agent/*` resolve via `file:`
