import { useExecutionSession, useRuntimeSnapshot } from "@pear-agent/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";

type ActiveTimersHudProps = {
  sessionId: string | null;
};

function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function labelForTimer(
  timerId: string,
  plan:
    | { steps: Array<{ timers: Array<{ id: string; label?: string | undefined }> }> }
    | null
    | undefined,
): string {
  for (const step of plan?.steps ?? []) {
    const def = step.timers.find((t) => t.id === timerId);
    if (def?.label) return def.label;
  }
  if (timerId === "charge-wait") return "充電タイマー";
  return timerId;
}

/**
 * Floating countdown for running execution timers (bottom-right, above voice dock).
 */
export function ActiveTimersHud({ sessionId }: ActiveTimersHudProps) {
  const { snapshot, refetch } = useRuntimeSnapshot(sessionId);
  const session = useExecutionSession(sessionId);
  const [now, setNow] = useState(() => Date.now());

  const running = snapshot?.activeTimers ?? [];

  useEffect(() => {
    if (running.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running.length]);

  const cards = useMemo(() => {
    return running.map((timer) => {
      const endsAtMs = timer.endsAt ? new Date(timer.endsAt).getTime() : NaN;
      const remaining =
        Number.isFinite(endsAtMs) && !Number.isNaN(endsAtMs)
          ? Math.max(0, (endsAtMs - now) / 1000)
          : timer.remainingSeconds;
      const duration = timer.durationSeconds > 0 ? timer.durationSeconds : remaining;
      const progress = duration > 0 ? 1 - remaining / duration : 0;
      return {
        id: timer.id,
        remaining,
        progress: Math.min(1, Math.max(0, progress)),
        label: labelForTimer(timer.id, snapshot?.plan),
        done: remaining <= 0,
      };
    });
  }, [running, now, snapshot?.plan]);

  if (!sessionId || cards.length === 0) return null;

  async function completeTimer(timerId: string) {
    try {
      await session.completeTimer({ timerId });
      toast.success("タイマー完了");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      className="pointer-events-none fixed bottom-[7.5rem] right-3 z-30 flex w-[min(100vw-1.5rem,16rem)] flex-col gap-2 sm:bottom-28"
      aria-label="実行中のタイマー"
    >
      {cards.map((card) => (
        <div
          key={card.id}
          className={cn(
            "pointer-events-auto overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur",
            card.done ? "border-emerald-300" : "border-primary/30",
          )}
        >
          <div className="px-3 pt-2.5 pb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-muted-foreground">
                  {card.label}
                </p>
                <p
                  className={cn(
                    "font-mono text-2xl font-semibold tabular-nums tracking-tight",
                    card.done ? "text-emerald-700" : "text-foreground",
                  )}
                >
                  {card.done ? "00:00" : formatMmSs(card.remaining)}
                </p>
              </div>
              {card.done ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => void completeTimer(card.id)}
                >
                  完了
                </Button>
              ) : (
                <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
              )}
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-200",
                  card.done ? "bg-emerald-500" : "bg-primary",
                )}
                style={{ width: `${Math.round(card.progress * 100)}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
