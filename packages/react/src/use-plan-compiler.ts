import { useCallback, useEffect, useRef, useState } from "react";

import { PearClientError } from "./errors.js";
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
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setStatus("idle");
    setResult(null);
    setInspector(null);
    setError(null);
    abortRef.current?.abort();
    abortRef.current = null;
    let cancelled = false;
    void client.getPlanInspector(planId).then(
      (next) => {
        if (!cancelled) setInspector(next);
      },
      () => {
        /* inspector load is best-effort on mount */
      },
    );
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [client, planId]);

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

  const refreshInspectorQuiet = useCallback(async () => {
    try {
      const next = await client.getPlanInspector(planId);
      setInspector(next);
    } catch {
      /* keep last inspector if refresh fails after a successful mutation */
    }
  }, [client, planId]);

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
      await refreshInspectorQuiet();
    },
    addUrlSource: async (input) => {
      await run(() => client.addPlanUrlSource(planId, input));
      await refreshInspectorQuiet();
    },
    addFileSource: async (file, label) => {
      await run(() => client.addPlanFileSource(planId, file, label));
      await refreshInspectorQuiet();
    },
    compile: async (compileInput = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const next = await run(() =>
        client.compilePlan(planId, { compileInput, signal: controller.signal }),
      );
      setResult(next);
      await refreshInspectorQuiet();
      return next;
    },
    answerAndCompile: async (clarificationId, answers, compileInput = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // Server answers + re-queues the same job and continues compile in one request.
      const next = await run(async () => {
        const outcome = await client.answerPlanClarification(planId, clarificationId, answers, {
          compileInput,
          resumeCompile: true,
          signal: controller.signal,
        });
        if (!("job" in outcome)) {
          throw new PearClientError("Clarification answered without compile resume", 500, outcome);
        }
        return outcome;
      });
      setResult(next);
      await refreshInspectorQuiet();
      return next;
    },
    refreshInspector,
  };
}
