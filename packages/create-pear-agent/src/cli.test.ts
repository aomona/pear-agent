import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { describe, expect, it, afterEach } from "vitest";

// Runtime implementation is ESM JS (Node bin); tests import the same module.
import {
  copyCloudflareMigrations,
  copyTemplate,
  defaultTemplateDir,
  resolveTemplateDir,
  rewritePackageJson,
  rewriteWranglerMigrationsDir,
} from "./copy-template.mjs";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
  temps.length = 0;
});

describe("create-pear-agent scaffold", () => {
  it("copies required template files", () => {
    const target = mkdtempSync(path.join(tmpdir(), "create-pear-"));
    temps.push(target);
    const projectDir = path.join(target, "my-agent");

    const pearRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../");
    copyTemplate(defaultTemplateDir(), projectDir);
    copyCloudflareMigrations(pearRoot, projectDir);
    rewriteWranglerMigrationsDir(projectDir);
    rewritePackageJson({
      targetDir: projectDir,
      projectName: "my-agent",
      mode: "workspace",
      pearAgentRoot: pearRoot,
    });

    expect(existsSync(path.join(projectDir, "wrangler.jsonc"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/worker/index.ts"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/app/App.tsx"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/app/pages/PlansPage.tsx"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/app/pages/InputPage.tsx"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/app/pages/PlanPage.tsx"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/app/pages/ExecutePage.tsx"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/domain/domain.ts"))).toBe(true);
    expect(existsSync(path.join(projectDir, "src/pear.config.ts"))).toBe(true);
    // Scaffold copies migrations from packages/cloudflare (single source of truth).
    expect(existsSync(path.join(projectDir, "migrations/0001_init.sql"))).toBe(true);
    expect(existsSync(path.join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(path.join(projectDir, "tests/domain.test.ts"))).toBe(true);

    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("my-agent");
    expect(pkg.dependencies["@pear-agent/core"]).toBe("workspace:*");
    expect(pkg.dependencies["@pear-agent/ai"]).toBe("workspace:*");
    expect(pkg.dependencies["@pear-agent/outing-domain-example"]).toBeUndefined();

    const worker = readFileSync(path.join(projectDir, "src/worker/index.ts"), "utf8");
    expect(worker).toContain('env.PEAR_INSECURE_ALLOW_ALL === "true"');
    expect(worker).toContain("denyAllAuthorize");
  });

  it("keeps exact beta dependencies and bundled migrations in registry mode", () => {
    const target = mkdtempSync(path.join(tmpdir(), "create-pear-registry-"));
    temps.push(target);
    const projectDir = path.join(target, "my-agent");
    const pearRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../");

    copyTemplate(defaultTemplateDir(), projectDir);
    rewriteWranglerMigrationsDir(projectDir);
    rewritePackageJson({
      targetDir: projectDir,
      projectName: "my-agent",
      mode: "registry",
      pearAgentRoot: null,
    });

    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };
    for (const name of [
      "@pear-agent/ai",
      "@pear-agent/cloudflare",
      "@pear-agent/core",
      "@pear-agent/react",
    ]) {
      expect(pkg.dependencies[name]).toBe("0.1.0-beta.1");
    }
    expect(pkg.pnpm?.overrides).toBeUndefined();
    expect(readFileSync(path.join(projectDir, "migrations/0001_init.sql"))).toEqual(
      readFileSync(path.join(pearRoot, "packages/cloudflare/migrations/0001_init.sql")),
    );
    expect(readFileSync(path.join(projectDir, "wrangler.jsonc"), "utf8")).toContain(
      '"migrations_dir": "migrations"',
    );
  });

  it("keeps outing behind an explicit example selection", () => {
    const pearRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../");
    const outing = resolveTemplateDir({ example: "outing", pearAgentRoot: pearRoot });

    expect(outing).toBe(path.join(pearRoot, "examples/outing-agent"));
    expect(readFileSync(path.join(outing, "package.json"), "utf8")).toContain(
      "@pear-agent/outing-domain-example",
    );
  });

  it("pins transitive PEAR workspace dependencies in file mode", () => {
    const target = mkdtempSync(path.join(tmpdir(), "create-pear-file-"));
    temps.push(target);
    const projectDir = path.join(target, "my-agent");
    const pearRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../");
    copyTemplate(defaultTemplateDir(), projectDir);
    rewritePackageJson({
      targetDir: projectDir,
      projectName: "my-agent",
      mode: "file",
      pearAgentRoot: pearRoot,
    });

    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
      pnpm: { overrides: Record<string, string> };
    };
    expect(pkg.pnpm.overrides["@pear-agent/core"]).toBe(
      `file:${path.join(pearRoot, "packages/core")}`,
    );
    expect(pkg.pnpm.overrides["@pear-agent/ai"]).toBe(`file:${path.join(pearRoot, "packages/ai")}`);
  });

  it("rejects unknown examples and ambiguous template selection", () => {
    expect(() => resolveTemplateDir({ example: "unknown" })).toThrow("Unknown example");
    expect(() => resolveTemplateDir({ example: "outing", template: "/tmp/custom" })).toThrow(
      "either --template or --example",
    );
  });
  it("runs the packed CLI without a monorepo and rejects unpackaged outing", () => {
    const driver = mkdtempSync(path.join(tmpdir(), "create-pear-packed-"));
    const target = mkdtempSync(path.join(tmpdir(), "create-pear-packed-target-"));
    temps.push(driver, target);
    const packageDir = path.resolve(fileURLToPath(import.meta.url), "../..");

    execFileSync("pnpm", ["pack", "--pack-destination", driver], {
      cwd: packageDir,
      stdio: "pipe",
    });
    const tarball = path.join(driver, readdirSync(driver).find((name) => name.endsWith(".tgz"))!);
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: driver,
      stdio: "pipe",
    });

    const cli = path.join(driver, "node_modules/.bin/create-pear-agent");
    const projectDir = path.join(target, "my-agent");
    const env = { ...process.env };
    delete env["PEAR_AGENT_ROOT"];
    const generated = spawnSync(cli, [projectDir], { encoding: "utf8", env });
    expect(generated.status, generated.stderr).toBe(0);

    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(
      Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@pear-agent/")),
    ).toEqual([
      ["@pear-agent/ai", "0.1.0-beta.1"],
      ["@pear-agent/cloudflare", "0.1.0-beta.1"],
      ["@pear-agent/core", "0.1.0-beta.1"],
      ["@pear-agent/react", "0.1.0-beta.1"],
    ]);
    expect(pkg.pnpm?.overrides).toBeUndefined();
    expect(existsSync(path.join(projectDir, "migrations/0001_init.sql"))).toBe(true);
    expect(existsSync(path.join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(path.join(projectDir, ".dev.vars.example"))).toBe(true);

    const outing = spawnSync(cli, [path.join(target, "outing"), "--example", "outing"], {
      encoding: "utf8",
      env,
    });
    expect(outing.status).not.toBe(0);
    expect(outing.stderr.trim()).toBe(
      "The outing example is not included in the npm package; pass --from <pear-agent-root> or use the default minimal starter.",
    );
  });
});
