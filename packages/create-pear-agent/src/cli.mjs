#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  copyCloudflareMigrations,
  copyTemplate,
  defaultTemplateDir,
  isInsideWorkspace,
  resolvePearAgentRoot,
  rewritePackageJson,
  rewriteWranglerMigrationsDir,
} from "./copy-template.mjs";

function printHelp() {
  console.log(`Usage: create-pear-agent <project-directory> [options]

Scaffold a deployable PEAR outing sample (Worker + React + shadcn/ui).

Options:
  --from <path>   Path to pear-agent monorepo root (for file: deps)
  --template <path>  Override template directory (default: examples/outing-agent)
  --help          Show this help

Environment:
  PEAR_AGENT_ROOT  Same as --from

Examples:
  create-pear-agent my-agent
  create-pear-agent examples/my-agent --from ../pear-agent
`);
}

function parseArgs(argv) {
  const positionals = [];
  let from;
  let template;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--from") {
      from = argv[++i];
      continue;
    }
    if (arg === "--template") {
      template = argv[++i];
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg) positionals.push(arg);
  }

  return { help: false, positionals, from, template };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const dirArg = parsed.positionals[0];
  if (!dirArg) {
    printHelp();
    process.exit(1);
  }

  const targetDir = path.resolve(dirArg);
  const projectName = path.basename(targetDir);
  const templateDir = parsed.template ? path.resolve(parsed.template) : defaultTemplateDir();
  const pearAgentRoot = resolvePearAgentRoot(parsed.from);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }

  copyTemplate(templateDir, targetDir);

  const mode = isInsideWorkspace(targetDir, pearAgentRoot) ? "workspace" : "file";
  const resolvedRoot =
    pearAgentRoot ?? (mode === "workspace" ? path.resolve(templateDir, "../..") : null);

  // Always materialize migrations next to the app so generated projects are self-contained.
  // Monorepo sample uses packages/cloudflare/migrations via wrangler relative path;
  // scaffolds rewrite wrangler to ./migrations after copy.
  if (resolvedRoot) {
    copyCloudflareMigrations(resolvedRoot, targetDir);
    rewriteWranglerMigrationsDir(targetDir);
  }

  rewritePackageJson({
    targetDir,
    projectName,
    mode,
    pearAgentRoot: resolvedRoot,
  });

  console.log(`
Created PEAR agent project at ${targetDir}

Next steps:
  cd ${path.relative(process.cwd(), targetDir) || "."}
  pnpm install
  cp .dev.vars.example .dev.vars   # optional GEMINI_API_KEY
  cp .env.example .env
  pnpm dev

Deploy:
  pnpm deploy

Dependency mode: ${mode}
${
  mode === "file"
    ? "  (packages resolved via file: — set --from or PEAR_AGENT_ROOT if install fails)\n"
    : "  (workspace:* — keep the project inside the pear-agent monorepo)\n"
}
`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
