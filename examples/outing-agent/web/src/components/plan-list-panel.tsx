import { outingDomain, outingGoal } from "@pear-agent/outing-domain-example";
import { usePearContext, type PlanListItem } from "@pear-agent/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type PlanListPanelProps = {
  onOpenPlan: (planId: string) => void;
  onCreatedPlan: (planId: string) => void;
};

function statusVariant(
  status: PlanListItem["status"],
): "default" | "secondary" | "success" | "outline" {
  switch (status) {
    case "ready":
      return "success";
    case "draft":
      return "secondary";
    case "archived":
      return "outline";
    default:
      return "default";
  }
}

export function PlanListPanel({ onOpenPlan, onCreatedPlan }: PlanListPanelProps) {
  const { client } = usePearContext();
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("Outing prep");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await client.listPlans({ domainId: outingDomain.id });
      setPlans(list.filter((p) => p.status !== "archived"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    setBusy(true);
    try {
      const artifact = await client.createPlan({
        domainId: outingDomain.id,
        goal: outingGoal,
        title: title.trim() || "Outing prep",
      });
      toast.success("Draft plan created");
      onCreatedPlan(artifact.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(planId: string) {
    try {
      await client.updatePlan(planId, { status: "archived" });
      toast.success("Archived");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Plan library</CardTitle>
        <CardDescription>
          保存された外出準備プラン。新規作成 → 入力 → 実行計画 → 実行の順に進みます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1 space-y-1">
            <Label htmlFor="new-title">New plan title</Label>
            <Input
              id="new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weekend trip"
            />
          </div>
          <Button disabled={busy} onClick={() => void handleCreate()}>
            {busy ? "Creating…" : "New draft"}
          </Button>
          <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading plans…</p>
        ) : plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plans yet. Create a draft to start.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {plans.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium truncate">{plan.title ?? plan.id}</span>
                    <Badge variant={statusVariant(plan.status)}>{plan.status}</Badge>
                    <span className="text-xs text-muted-foreground">v{plan.version}</span>
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground truncate">{plan.id}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => onOpenPlan(plan.id)}>
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void handleArchive(plan.id)}>
                    Archive
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
