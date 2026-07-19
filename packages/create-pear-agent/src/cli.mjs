#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  copyCloudflareMigrations,
  copyTemplate,
  defaultPearAgentRoot,
  isInsideWorkspace,
  resolvePearAgentRoot,
  resolveTemplateDir,
  rewritePackageJson,
  rewriteWranglerMigrationsDir,
} from "./copy-template.mjs";

function printHelp() {
  console.log(`Usage: create-pear-agent <project-directory> [options]

Scaffold a minimal PEAR execution app (Cloudflare Worker + React).

Options:
  --example <name>   Generate a reference example (outing: monorepo example; requires --from/PEAR_AGENT_ROOT)
  --from <path>      Path to pear-agent monorepo root
  --template <path>  Override the template directory
  --help             Show this help

Environment:
  PEAR_AGENT_ROOT  Same as --from

Examples:
  create-pear-agent my-agent
  create-pear-agent my-outing --example outing
  create-pear-agent examples/my-agent --from ../pear-agent
`);
}

function parseArgs(argv) {
  const positionals = [];
  let from;
  let template;
  let example;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--from") {
      from = argv[++i];
      if (!from) throw new Error("--from requires a path");
      continue;
    }
    if (arg === "--template") {
      template = argv[++i];
      if (!template) throw new Error("--template requires a path");
      continue;
    }
    if (arg === "--example") {
      example = argv[++i];
      if (!example) throw new Error("--example requires a name");
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (arg) positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  return { help: false, positionals, from, template, example };
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
  const explicitRoot = resolvePearAgentRoot(parsed.from);
  const bundledRoot = defaultPearAgentRoot();
  const hasBundledRepository =
    existsSync(path.join(bundledRoot, "packages/core/package.json")) &&
    existsSync(path.join(bundledRoot, "packages/cloudflare/migrations/0001_init.sql"));
  const implicitRoot = hasBundledRepository ? bundledRoot : null;
  const resolvedRoot = explicitRoot ?? implicitRoot;

  if (parsed.example === "outing" && !resolvedRoot) {
    throw new Error(
      "The outing example is not included in the npm package; pass --from <pear-agent-root> or use the default minimal starter.",
    );
  }

  const templateDir = resolveTemplateDir({
    template: parsed.template,
    example: parsed.example,
    pearAgentRoot: resolvedRoot,
  });

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }

  copyTemplate(templateDir, targetDir);

  const mode = explicitRoot
    ? isInsideWorkspace(targetDir, explicitRoot)
      ? "workspace"
      : "file"
    : implicitRoot && isInsideWorkspace(targetDir, implicitRoot)
      ? "workspace"
      : "registry";

  if (mode !== "registry" && resolvedRoot) {
    copyCloudflareMigrations(resolvedRoot, targetDir);
  }
  rewriteWranglerMigrationsDir(targetDir);

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
  cp .env.example .env
  cp .dev.vars.example .dev.vars  # local allow-all only; never deploy this flag
  pnpm dev

Deploy:
  pnpm deploy

Dependency mode: ${mode}
${
  mode === "file"
    ? "  (packages resolved via file: from the selected pear-agent root)\n"
    : mode === "workspace"
      ? "  (workspace:* — keep the project inside the pear-agent monorepo)\n"
      : "  (exact beta versions from the npm registry)\n"
}
`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
