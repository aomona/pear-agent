import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IGNORE_NAMES = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  ".dev.vars",
  ".env",
  ".DS_Store",
]);

export function defaultTemplateDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../templates/minimal");
}

export function defaultPearAgentRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

export function resolveTemplateDir(options = {}) {
  if (options.template && options.example) {
    throw new Error("Use either --template or --example, not both");
  }
  if (options.template) return path.resolve(options.template);
  if (!options.example) return defaultTemplateDir();
  if (options.example !== "outing") {
    throw new Error(`Unknown example: ${options.example}. Available examples: outing`);
  }
  const root = options.pearAgentRoot ?? defaultPearAgentRoot();
  const outing = path.join(root, "examples/outing-agent");
  if (!existsSync(outing)) {
    throw new Error(
      "The outing reference app is not available here. Set --from <pear-agent-root>.",
    );
  }
  return outing;
}

export function resolvePearAgentRoot(fromFlag) {
  if (fromFlag) return path.resolve(fromFlag);
  if (process.env["PEAR_AGENT_ROOT"]) return path.resolve(process.env["PEAR_AGENT_ROOT"]);
  return null;
}

function shouldIgnore(name) {
  return IGNORE_NAMES.has(name);
}

export function copyTemplate(templateDir, targetDir) {
  if (!existsSync(templateDir)) {
    throw new Error(`Template not found: ${templateDir}`);
  }
  mkdirSync(targetDir, { recursive: true });

  const entries = readdirSync(templateDir);
  for (const name of entries) {
    if (shouldIgnore(name)) continue;
    const src = path.join(templateDir, name);
    const dest = path.join(targetDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dest, {
        recursive: true,
        filter: (source) => {
          const base = path.basename(source);
          return !shouldIgnore(base);
        },
      });
    } else {
      copyFileSync(src, dest);
    }
  }
}

/**
 * Copy D1 SQL from the monorepo cloudflare package (single source of truth).
 * Generated apps outside the monorepo get a local migrations/ copy.
 */
export function copyCloudflareMigrations(pearAgentRoot, targetDir) {
  const migrationsSrc = path.join(pearAgentRoot, "packages/cloudflare/migrations");
  if (!existsSync(migrationsSrc)) {
    throw new Error(`Cloudflare migrations not found: ${migrationsSrc}`);
  }
  const migrationsDest = path.join(targetDir, "migrations");
  cpSync(migrationsSrc, migrationsDest, { recursive: true });
}

/**
 * Point wrangler migrations_dir at local ./migrations after scaffold copy.
 */
export function rewriteWranglerMigrationsDir(targetDir) {
  const wranglerPath = path.join(targetDir, "wrangler.jsonc");
  if (!existsSync(wranglerPath)) return;
  let text = readFileSync(wranglerPath, "utf8");
  text = text.replace(/"migrations_dir"\s*:\s*"[^"]*"/, '"migrations_dir": "migrations"');
  writeFileSync(wranglerPath, text);
}

export function rewritePackageJson(options) {
  const pkgPath = path.join(options.targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  pkg.name = options.projectName;

  const pearPackages = [
    "@pear-agent/ai",
    "@pear-agent/cloudflare",
    "@pear-agent/core",
    "@pear-agent/react",
    "@pear-agent/outing-domain-example",
  ];

  const rewrite = (deps) => {
    if (!deps) return;
    for (const name of pearPackages) {
      if (!(name in deps)) continue;
      if (options.mode === "workspace") {
        deps[name] = "workspace:*";
      } else if (options.mode === "file") {
        if (!options.pearAgentRoot) {
          throw new Error("file: dependencies require --from <pear-agent-root> or PEAR_AGENT_ROOT");
        }
        const folder =
          name === "@pear-agent/outing-domain-example"
            ? "examples/outing-domain"
            : `packages/${name.replace("@pear-agent/", "")}`;
        deps[name] = `file:${path.join(options.pearAgentRoot, folder)}`;
      }
    }
  };

  rewrite(pkg.dependencies);
  rewrite(pkg.devDependencies);
  if (options.mode === "file" && options.pearAgentRoot) {
    const referencedPearPackages = pearPackages.filter(
      (name) => name in (pkg.dependencies ?? {}) || name in (pkg.devDependencies ?? {}),
    );
    pkg.pnpm ??= {};
    pkg.pnpm.overrides = {
      ...pkg.pnpm.overrides,
      ...Object.fromEntries(
        referencedPearPackages.map((name) => {
          const folder =
            name === "@pear-agent/outing-domain-example"
              ? "examples/outing-domain"
              : `packages/${name.replace("@pear-agent/", "")}`;
          return [name, `file:${path.join(options.pearAgentRoot, folder)}`];
        }),
      ),
    };
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function isInsideWorkspace(targetDir, pearAgentRoot) {
  if (!pearAgentRoot) return false;
  const rel = path.relative(pearAgentRoot, path.resolve(targetDir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
