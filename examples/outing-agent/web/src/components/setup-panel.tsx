import {
  outingDomain,
  outingGoal,
  buildOutingWorldState,
  type OutingInput,
} from "@pear-agent/outing-domain-example";
import { useExecutionSession } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type SetupPanelProps = {
  onSessionCreated: (sessionId: string) => void;
};

function defaultDepartureLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SetupPanel({ onSessionCreated }: SetupPanelProps) {
  const session = useExecutionSession();
  const [departureLocal, setDepartureLocal] = useState(defaultDepartureLocal);
  const [belongingsText, setBelongingsText] = useState("keys:Keys\nphone:Phone:20\nwallet:Wallet");
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    setBusy(true);
    try {
      const belongings = belongingsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, name, charge] = line.split(":").map((s) => s.trim());
          if (!id || !name) throw new Error(`Invalid belonging line: ${line}`);
          const item: OutingInput["belongings"][number] = { id, name };
          if (charge !== undefined && charge !== "") {
            item.chargePercent = Number(charge);
          }
          return item;
        });

      const departureAt = new Date(departureLocal).toISOString();
      const input: OutingInput = { departureAt, belongings };
      const normalizedInput = await outingDomain.normalizeInput(input);
      const worldState = buildOutingWorldState(normalizedInput);

      const created = await session.create({
        domainId: outingDomain.id,
        actorIds: ["demo-user"],
        goal: outingGoal,
        normalizedInput,
        worldState,
      });
      await session.startSession();
      onSessionCreated(created.sessionId);
      toast.success("Session created and started");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Setup</CardTitle>
        <CardDescription>
          出発時刻と持ち物を入力して Execution Session を作成します。phone のように charge%
          がある行は charge ステップの対象になります。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="departure">Departure (local)</Label>
          <Input
            id="departure"
            type="datetime-local"
            value={departureLocal}
            onChange={(e) => setDepartureLocal(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="belongings">Belongings (id:name[:charge%], one per line)</Label>
          <textarea
            id="belongings"
            className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={belongingsText}
            onChange={(e) => setBelongingsText(e.target.value)}
          />
        </div>
        <Button disabled={busy || session.status === "loading"} onClick={() => void handleCreate()}>
          {busy ? "Creating…" : "Create & start session"}
        </Button>
      </CardContent>
    </Card>
  );
}
