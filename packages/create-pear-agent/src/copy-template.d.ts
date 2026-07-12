export function defaultTemplateDir(): string;
export function resolvePearAgentRoot(fromFlag?: string): string | null;
export function copyTemplate(templateDir: string, targetDir: string): void;
export function rewritePackageJson(options: {
  targetDir: string;
  projectName: string;
  mode: "workspace" | "file";
  pearAgentRoot: string | null;
}): void;
export function isInsideWorkspace(targetDir: string, pearAgentRoot: string | null): boolean;
