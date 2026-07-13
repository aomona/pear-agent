import { timerDefinitionSchema, type RuntimeSnapshot } from "@pear-agent/core";

/** Compact, typed view of runtime state for Gemini Live system + tools. */
export type VoiceStepSummary = {
  id: string;
  label: string;
  status: string;
  estimatedDurationSeconds: number | null;
  instructions: string | null;
  timers: Array<{
    id: string;
    label: string;
    durationSeconds: number;
    autoStart: boolean;
  }>;
};

export type VoiceRuntimeSummary = {
  sessionId: string;
  sessionStatus: string;
  planId: string;
  planVersion: number;
  planTitle: string | null;
  /** Full step list with human labels, status, and plan-defined timers. */
  steps: VoiceStepSummary[];
  /** Active or next ready step (convenience pointer into steps). */
  focusStepId: string | null;
  activeTimers: Array<{
    id: string;
    status: string;
    remainingSeconds: number;
    durationSeconds: number;
    endsAt: string | null;
  }>;
  recentEventTypes: string[];
  latestPlanChange: {
    status: string;
    effect: "applied" | "rejected" | "proposed";
    mode: string;
    summary: string;
    targetPlanVersion: number | null;
    failureReason: string | null;
  } | null;
  generatedAt: string;
};

/**
 * Minimal snapshot projection for voice. Prefer this over dumping full RuntimeSnapshot.
 * Single source for steps (status + timers); no redundant stepStates / planTimers mirrors.
 */
export function summarizeSnapshotForVoice(snapshot: RuntimeSnapshot): VoiceRuntimeSummary {
  const planChange = snapshot.latestPlanChange;
  const latestPlanChange = planChange
    ? {
        status: planChange.status,
        effect:
          planChange.status === "applied"
            ? ("applied" as const)
            : planChange.status === "failed"
              ? ("rejected" as const)
              : ("proposed" as const),
        mode: planChange.mode,
        summary: planChange.patch.summary,
        targetPlanVersion: planChange.targetPlanVersion ?? null,
        failureReason: planChange.failureReason ?? null,
      }
    : null;

  const steps: VoiceStepSummary[] = snapshot.plan.steps.map((step) => {
    const status = snapshot.stepStates[step.id]?.status ?? "unknown";
    return {
      id: step.id,
      label: step.label ?? step.id,
      status,
      estimatedDurationSeconds: step.estimatedDurationSeconds ?? null,
      instructions: step.instructions ?? step.summary ?? null,
      timers: step.timers.flatMap((rawTimer) => {
        const timer = timerDefinitionSchema.safeParse(rawTimer);
        if (!timer.success) return [];
        return [
          {
            id: timer.data.id,
            label: timer.data.label ?? timer.data.id,
            durationSeconds: timer.data.durationSeconds,
            autoStart: timer.data.autoStart ?? false,
          },
        ];
      }),
    };
  });

  const focus =
    steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "ready") ?? null;

  return {
    sessionId: snapshot.session.id,
    sessionStatus: snapshot.session.status,
    planId: snapshot.plan.id,
    planVersion: snapshot.plan.version,
    planTitle: snapshot.plan.title ?? null,
    steps,
    focusStepId: focus?.id ?? null,
    activeTimers: snapshot.activeTimers.map((t) => ({
      id: t.id,
      status: t.status,
      remainingSeconds: t.remainingSeconds,
      durationSeconds: t.durationSeconds,
      endsAt: t.endsAt ? t.endsAt.toISOString() : null,
    })),
    recentEventTypes: snapshot.recentEvents.slice(-6).map((e) => e.type),
    latestPlanChange,
    generatedAt: snapshot.generatedAt.toISOString(),
  };
}
