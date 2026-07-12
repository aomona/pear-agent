import { buildPlanPresentation, type ExecutionPlan } from "@pear-agent/core";
import { useExecutionSession, usePearContext, useRuntimeSnapshot } from "@pear-agent/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { findChargeTimer, formatTimerDurationLabel } from "../lib/plan-timers";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type ExecuteScreenProps = {
  sessionId: string | null;
};

function stepStatusTone(status: string): string {
  switch (status) {
    case "active":
      return "bg-primary text-primary-foreground border-primary";
    case "completed":
      return "bg-emerald-100 text-emerald-900 border-emerald-200";
    case "ready":
      return "bg-amber-50 text-amber-900 border-amber-200";
    case "failed":
      return "bg-red-100 text-red-900 border-red-200";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

/**
 * Viewport-first execution UI: big “what to do now”, compact progress.
 * Voice lives in {@link VoiceDock}, not here.
 */
export function ExecuteScreen({ sessionId }: ExecuteScreenProps) {
  const { snapshot, status, error, refetch } = useRuntimeSnapshot(sessionId);
  const session = useExecutionSession(sessionId);
  const { client } = usePearContext();
  const [showAll, setShowAll] = useState(false);
  const [delayBusy, setDelayBusy] = useState(false);

  const plan = snapshot?.plan;
  const stepStates = snapshot?.stepStates ?? {};
  const presentation = useMemo(
    () => (plan ? buildPlanPresentation(plan, stepStates) : null),
    [plan, stepStates],
  );

  const next = useMemo(() => {
    if (!presentation || !snapshot) return null;
    const states = snapshot.stepStates;
    const active = presentation.nodes.find((n) => states[n.id]?.status === "active");
    if (active) return { node: active, mode: "active" as const };
    const ready = presentation.nodes.find((n) => states[n.id]?.status === "ready");
    if (ready) return { node: ready, mode: "ready" as const };
    const allDone = presentation.nodes.every((n) => states[n.id]?.status === "completed");
    if (allDone) return { node: null, mode: "done" as const };
    return { node: presentation.nodes[0] ?? null, mode: "other" as const };
  }, [presentation, snapshot]);

  const doneCount = presentation
    ? presentation.nodes.filter((n) => (stepStates[n.id]?.status ?? n.status) === "completed")
        .length
    : 0;
  const totalCount = presentation?.nodes.length ?? 0;

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast.success(label);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function reportShortDelay() {
    if (!sessionId) return;
    setDelayBusy(true);
    try {
      await session.reportDomainEvent({
        domainType: "delay",
        payload: { minutes: 15 },
      });
      const result = await client.requestReplan(sessionId, "automatic");
      toast.success(`遅延を反映 · replan ${result.kind}`);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDelayBusy(false);
    }
  }

  if (!sessionId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground">
        <p className="text-sm">実行セッションがありません</p>
      </div>
    );
  }

  if (!presentation || !next) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">
          {error ? error.message : `読み込み中… (${status})`}
        </p>
      </div>
    );
  }

  const planChange = snapshot?.latestPlanChange;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Progress strip — always visible, fits one row */}
      <div className="shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground">
            {presentation.title ?? "準備"}
          </span>
          <span>
            {doneCount}/{totalCount} · ~{presentation.totalDurationSeconds}s
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {presentation.nodes.map((node) => {
            const st = node.status ?? stepStates[node.id]?.status ?? "unknown";
            const isFocus = next.node?.id === node.id;
            return (
              <span
                key={node.id}
                title={`${node.label} (${st})`}
                className={cn(
                  "max-w-[9rem] truncate rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                  stepStatusTone(st),
                  isFocus && "ring-2 ring-primary/40 ring-offset-1",
                )}
              >
                {node.label}
              </span>
            );
          })}
        </div>
        {planChange ? (
          <p className="text-[11px] text-muted-foreground">計画更新: {planChange.patch.summary}</p>
        ) : null}
      </div>

      {/* Hero — takes remaining space, still fits viewport with dock */}
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        {next.mode === "done" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 px-6 py-10 text-center shadow-sm">
            <p className="text-xs font-semibold tracking-wide text-emerald-800 uppercase">完了</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-emerald-950 sm:text-3xl">
              準備ができました
            </h2>
            <p className="mt-2 text-sm text-emerald-900/80">
              すべてのステップが完了しています。出発時刻に合わせて出ましょう。
            </p>
          </div>
        ) : next.node ? (
          <div className="rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/8 to-background px-5 py-8 shadow-sm sm:px-8 sm:py-10">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={next.mode === "active" ? "default" : "warning"}>
                {next.mode === "active" ? "いまやること" : "次にやること"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                ~{next.node.estimatedDurationSeconds}s
              </span>
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              {next.node.label}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {next.node.instructions ?? next.node.summary ?? "準備を進めてください。"}
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-2">
              {next.mode === "ready" ? (
                <Button
                  size="lg"
                  className="min-w-[8rem]"
                  onClick={() =>
                    void run("開始しました", () => session.startStep({ stepId: next.node!.id }))
                  }
                >
                  はじめる
                </Button>
              ) : null}
              {next.mode === "active" ? (
                <Button
                  size="lg"
                  className="min-w-[8rem]"
                  onClick={() =>
                    void run("完了しました", () => session.completeStep({ stepId: next.node!.id }))
                  }
                >
                  できた
                </Button>
              ) : null}
              {next.node.id === "charge" && next.mode === "active" ? (
                <ChargeTimerButton
                  plan={plan}
                  activeTimerIds={snapshot?.activeTimers.map((t) => t.id) ?? []}
                  onStart={(timerId, durationSeconds) =>
                    void run(`タイマー ${durationSeconds}s 開始`, () =>
                      session.startTimer({ timerId, durationSeconds }),
                    )
                  }
                />
              ) : null}
              <Button
                size="lg"
                variant="outline"
                disabled={delayBusy}
                onClick={() => void reportShortDelay()}
              >
                {delayBusy ? "反映中…" : "15分遅れた"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-center text-sm text-muted-foreground">次のステップを準備中…</p>
        )}
      </div>

      {/* Optional detail — collapsed by default so primary view fits */}
      <div className="shrink-0 border-t pt-2">
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "詳細を閉じる" : "すべてのステップを見る"}
        </button>
        {showAll ? (
          <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs">
            {presentation.nodes.map((node) => {
              const st = node.status ?? stepStates[node.id]?.status ?? "unknown";
              return (
                <li
                  key={node.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                >
                  <span className="truncate font-medium">{node.label}</span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {st}
                  </Badge>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function ChargeTimerButton(props: {
  plan: ExecutionPlan | undefined;
  activeTimerIds: string[];
  onStart: (timerId: string, durationSeconds: number) => void;
}) {
  const chargeTimer = findChargeTimer(props.plan);
  if (!chargeTimer) return null;
  const alreadyRunning = props.activeTimerIds.includes(chargeTimer.id);
  return (
    <Button
      size="lg"
      variant="secondary"
      disabled={alreadyRunning}
      onClick={() => props.onStart(chargeTimer.id, chargeTimer.durationSeconds)}
    >
      {alreadyRunning
        ? "タイマー作動中"
        : `充電タイマー（${formatTimerDurationLabel(chargeTimer.durationSeconds)}）`}
    </Button>
  );
}
