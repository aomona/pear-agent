import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, afterEach } from "vitest";

// Runtime implementation is ESM JS (Node bin); tests import the same module.
import { copyTemplate, defaultTemplateDir, rewritePackageJson } from "./copy-template.mjs";

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

    copyTemplate(defaultTemplateDir(), projectDir);
    rewritePackageJson({
      targetDir: projectDir,
      projectName: "my-agent",
      mode: "workspace",
      pearAgentRoot: path.resolve(fileURLToPath(import.meta.url), "../../../../"),
    });

    expect(existsSync(path.join(projectDir, "wrangler.jsonc"))).toBe(true);
    expect(existsSync(path.join(projectDir, "worker/src/index.ts"))).toBe(true);
    expect(existsSync(path.join(projectDir, "web/src/App.tsx"))).toBe(true);
    expect(existsSync(path.join(projectDir, "migrations/0001_init.sql"))).toBe(true);
    expect(existsSync(path.join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(path.join(projectDir, "web/src/components/ui/button.tsx"))).toBe(true);

    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("my-agent");
    expect(pkg.dependencies["@pear-agent/core"]).toBe("workspace:*");
  });
});
