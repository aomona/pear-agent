import { useCallback, useState } from "react";

import { usePearContext } from "./provider.js";
import type { PlanArtifactInspector, PlanCompileResult } from "./types.js";

export type UsePlanCompilerResult = {
  status: "idle" | "loading" | "success" | "error";
  result: PlanCompileResult | null;
  inspector: PlanArtifactInspector | null;
  error: Error | null;
  addTextSource(input: {
    label: string;
    content: string;
    mediaType?: "text/plain" | "text/markdown" | "application/json";
  }): Promise<void>;
  addUrlSource(input: { url: string; label?: string }): Promise<void>;
  addFileSource(file: File, label?: string): Promise<void>;
  compile(compileInput?: unknown): Promise<PlanCompileResult>;
  answerAndCompile(
    clarificationId: string,
    answers: Readonly<Record<string, string>>,
    compileInput?: unknown,
  ): Promise<PlanCompileResult>;
  refreshInspector(): Promise<void>;
};

/** Hooks-only Sources → Compile → Review surface for generic and domain UIs. */
export function usePlanCompiler(planId: string): UsePlanCompilerResult {
  const { client } = usePearContext();
  const [status, setStatus] = useState<UsePlanCompilerResult["status"]>("idle");
  const [result, setResult] = useState<PlanCompileResult | null>(null);
  const [inspector, setInspector] = useState<PlanArtifactInspector | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
    setStatus("loading");
    setError(null);
    try {
      const value = await operation();
      setStatus("success");
      return value;
    } catch (cause) {
      const next = cause instanceof Error ? cause : new Error(String(cause));
      setError(next);
      setStatus("error");
      throw next;
    }
  }, []);

  const refreshInspector = useCallback(async () => {
    const next = await run(() => client.getPlanInspector(planId));
    setInspector(next);
  }, [client, planId, run]);

  return {
    status,
    result,
    inspector,
    error,
    addTextSource: async (input) => {
      await run(() => client.addPlanTextSource(planId, input));
      await refreshInspector();
    },
    addUrlSource: async (input) => {
      await run(() => client.addPlanUrlSource(planId, input));
      await refreshInspector();
    },
    addFileSource: async (file, label) => {
      await run(() => client.addPlanFileSource(planId, file, label));
      await refreshInspector();
    },
    compile: async (compileInput = {}) => {
      const next = await run(() => client.compilePlan(planId, { compileInput }));
      setResult(next);
      await refreshInspector();
      return next;
    },
    answerAndCompile: async (clarificationId, answers, compileInput = {}) => {
      await run(() => client.answerPlanClarification(planId, clarificationId, answers));
      const next = await run(() =>
        client.compilePlan(planId, { compileInput, clarificationAnswers: answers }),
      );
      setResult(next);
      await refreshInspector();
      return next;
    },
    refreshInspector,
  };
}
