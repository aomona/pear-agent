import { buildPlanPresentation } from "@pear-agent/core";
import { useExecutionSession, useRuntimeSnapshot } from "@pear-agent/react";
import { useMemo } from "react";
import { toast } from "sonner";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

type NextActionHeroProps = {
  sessionId: string | null;
};

/**
 * Hero card: the single most useful next step during execution.
 */
export function NextActionHero({ sessionId }: NextActionHeroProps) {
  const { snapshot, refetch } = useRuntimeSnapshot(sessionId);
  const session = useExecutionSession(sessionId);

  const presentation = useMemo(
    () => (snapshot?.plan ? buildPlanPresentation(snapshot.plan, snapshot.stepStates) : null),
    [snapshot?.plan, snapshot?.stepStates],
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

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast.success(label);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (!sessionId) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>いまやること</CardTitle>
          <CardDescription>セッションを開始すると次の一手が表示されます。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!next || !presentation) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>いまやること</CardTitle>
          <CardDescription>Snapshot を読み込み中…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (next.mode === "done") {
    return (
      <Card className="border-emerald-300 bg-emerald-50/50">
        <CardHeader>
          <CardTitle>準備完了</CardTitle>
          <CardDescription>
            すべてのステップが完了しました。出発時刻に間に合えばそのまま出られます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            critical path ~{presentation.totalDurationSeconds}s · {presentation.title}
          </p>
        </CardContent>
      </Card>
    );
  }

  const node = next.node;
  if (!node) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">いまやること</CardTitle>
          <Badge variant={next.mode === "active" ? "default" : "warning"}>
            {next.mode === "active" ? "進行中" : "次に開始"}
          </Badge>
        </div>
        <CardDescription>
          {presentation.title} · 残り critical ~{presentation.totalDurationSeconds}s 想定
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-lg font-semibold tracking-tight">{node.label}</p>
          {node.instructions ? (
            <p className="mt-1 text-sm text-muted-foreground">{node.instructions}</p>
          ) : node.summary ? (
            <p className="mt-1 text-sm text-muted-foreground">{node.summary}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            ~{node.estimatedDurationSeconds}s · {node.id}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {next.mode === "ready" ? (
            <Button
              onClick={() =>
                void run(`Started ${node.id}`, () => session.startStep({ stepId: node.id }))
              }
            >
              開始する
            </Button>
          ) : null}
          {next.mode === "active" ? (
            <Button
              onClick={() =>
                void run(`Completed ${node.id}`, () => session.completeStep({ stepId: node.id }))
              }
            >
              完了にする
            </Button>
          ) : null}
          {node.id === "charge" && next.mode === "active" ? (
            <Button
              variant="secondary"
              onClick={() =>
                void run("Charge timer started", () =>
                  session.startTimer({ timerId: "charge-wait", durationSeconds: 300 }),
                )
              }
            >
              充電タイマー開始
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
