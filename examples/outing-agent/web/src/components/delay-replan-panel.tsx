import { useExecutionSession, usePearContext, useRuntimeSnapshot } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";

type DelayReplanPanelProps = {
  sessionId: string | null;
};

export function DelayReplanPanel({ sessionId }: DelayReplanPanelProps) {
  const session = useExecutionSession(sessionId);
  const { client } = usePearContext();
  const { snapshot, refetch } = useRuntimeSnapshot(sessionId);
  const [minutes, setMinutes] = useState(15);
  const [lastReplan, setLastReplan] = useState<string | null>(null);

  const planChange = snapshot?.latestPlanChange ?? null;

  async function reportDelay() {
    if (!sessionId) return;
    try {
      await session.reportDomainEvent({
        domainType: "delay",
        payload: { minutes },
      });
      toast.success(`Delay ${minutes} min reported`);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function requestReplan() {
    if (!sessionId) return;
    try {
      const result = await client.requestReplan(sessionId, "automatic");
      setLastReplan(JSON.stringify(result, null, 2));
      toast.success(`Replan: ${result.kind}`);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>4. Delay & Partial Replan</CardTitle>
        <CardDescription>
          遅延イベントを報告すると charge ステップだけが Affected Subgraph として更新されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="delay-min">Delay minutes</Label>
            <Input
              id="delay-min"
              type="number"
              min={1}
              className="w-28"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value) || 1)}
            />
          </div>
          <Button disabled={!sessionId} variant="outline" onClick={() => void reportDelay()}>
            Report delay
          </Button>
          <Button disabled={!sessionId} onClick={() => void requestReplan()}>
            Request replan
          </Button>
        </div>

        {planChange ? (
          <Alert>
            <AlertTitle className="flex items-center gap-2">
              Latest plan change
              <Badge variant="secondary">{planChange.status}</Badge>
              <Badge variant="outline">{planChange.mode}</Badge>
            </AlertTitle>
            <AlertDescription className="mt-2 space-y-2">
              <p>{planChange.patch.summary}</p>
              <p className="text-xs text-muted-foreground">
                affected: {planChange.patch.affectedStepIds.join(", ")} · target v
                {planChange.targetPlanVersion ?? "—"}
              </p>
              <ul className="list-disc pl-5 text-xs">
                {planChange.patch.operations.map((op, i) => (
                  <li key={i}>
                    {op.type}
                    {"stepId" in op ? ` ${op.stepId}` : ""}
                    {op.type === "update_step" ? ` → ${op.step.estimatedDurationSeconds}s` : ""}
                  </li>
                ))}
              </ul>
              {planChange.failureReason ? (
                <p className="text-destructive">{planChange.failureReason}</p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">Plan change はまだありません。</p>
        )}

        {lastReplan ? (
          <ScrollArea className="h-40 rounded-md border">
            <pre className="p-3 text-xs whitespace-pre-wrap">{lastReplan}</pre>
          </ScrollArea>
        ) : null}
      </CardContent>
    </Card>
  );
}
