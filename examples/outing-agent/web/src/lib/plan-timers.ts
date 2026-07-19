import { timerDefinitionSchema, type ExecutionPlan, type TimerDefinition } from "@pear-agent/core";

export function findPlanTimer(
  plan: ExecutionPlan | null | undefined,
  timerId: string,
): TimerDefinition | undefined {
  for (const step of plan?.steps ?? []) {
    for (const timer of step.timers) {
      const parsed = timerDefinitionSchema.safeParse(timer);
      if (parsed.success && parsed.data.id === timerId) return parsed.data;
    }
  }
  return undefined;
}

/** First charge-related plan timer (outing default: charge-wait). */
export function findChargeTimer(plan: ExecutionPlan | undefined): TimerDefinition | undefined {
  const charge = plan?.steps.find((s) => s.id === "charge");
  if (!charge) return undefined;
  const timers = charge.timers.flatMap((timer) => {
    const parsed = timerDefinitionSchema.safeParse(timer);
    return parsed.success ? [parsed.data] : [];
  });
  return timers.find((timer) => timer.id === "charge-wait") ?? timers[0];
}

export function formatTimerDurationLabel(durationSeconds: number): string {
  const mins = Math.round(durationSeconds / 60);
  if (mins >= 1) return `${mins}分`;
  return `${durationSeconds}秒`;
}
