import type { ExecutionPlan, TimerDefinition } from "@pear-agent/core";

/** First charge-related plan timer (outing default: charge-wait). */
export function findChargeTimer(plan: ExecutionPlan | undefined): TimerDefinition | undefined {
  const charge = plan?.steps.find((s) => s.id === "charge");
  if (!charge) return undefined;
  return charge.timers.find((t) => t.id === "charge-wait") ?? charge.timers[0];
}

export function formatTimerDurationLabel(durationSeconds: number): string {
  const mins = Math.round(durationSeconds / 60);
  if (mins >= 1) return `${mins}分`;
  return `${durationSeconds}秒`;
}
