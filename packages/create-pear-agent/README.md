# create-pear-agent

Scaffold an editable PEAR Runtime app with Cloudflare Worker, D1, R2, Agents, and React.

## Usage

From the monorepo (packages are not published yet):

```bash
pnpm create-pear-agent examples/my-agent
```

After `create-pear-agent` is published:

```bash
pnpm create pear-agent my-agent
```

The default Minimal Starter has four editable pages: plan list, input, plan review, and execution. Start your changes in `src/app/pages/`, `src/domain/`, and `src/pear.config.ts`.

To copy the full Outing reference application instead:

```bash
pnpm create-pear-agent examples/my-outing --example outing
```

## Options

| Flag                | Meaning                                           |
| ------------------- | ------------------------------------------------- |
| `--example outing`  | Generate the full Outing reference application    |
| `--from <path>`     | pear-agent monorepo root for `file:` package deps |
| `--template <path>` | Override the template directory                   |

## Notes

- Minimal Starter source of truth: `packages/create-pear-agent/templates/minimal`
- Outing source of truth: `examples/outing-agent`; it is never the implicit default
- Inside the monorepo, dependencies stay `workspace:*`
- Outside, use `--from` / `PEAR_AGENT_ROOT` so `@pear-agent/*` resolve via `file:`
