import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(pkg.dependencies["@pear-agent/outing-domain-example"]).toBeUndefined();

    const worker = readFileSync(path.join(projectDir, "src/worker/index.ts"), "utf8");
    expect(worker).toContain('env.PEAR_INSECURE_ALLOW_ALL === "true"');
    expect(worker).toContain("denyAllAuthorize");
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
  });

  it("rejects unknown examples and ambiguous template selection", () => {
    expect(() => resolveTemplateDir({ example: "unknown" })).toThrow("Unknown example");
    expect(() => resolveTemplateDir({ example: "outing", template: "/tmp/custom" })).toThrow(
      "either --template or --example",
    );
  });
});
