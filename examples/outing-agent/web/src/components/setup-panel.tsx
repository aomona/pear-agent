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
  const [departureMode, setDepartureMode] = useState<"structured" | "freeText">("structured");
  const [belongingsMode, setBelongingsMode] = useState<"structured" | "freeText">("structured");
  const [departureLocal, setDepartureLocal] = useState(defaultDepartureLocal);
  const [departureFreeText, setDepartureFreeText] = useState("2026-07-12T10:00:00.000Z");
  const [belongingsText, setBelongingsText] = useState("keys:Keys\nphone:Phone:20\nwallet:Wallet");
  const [belongingsFreeText, setBelongingsFreeText] = useState(
    "keys:Keys, phone:Phone:20, wallet:Wallet",
  );
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    setBusy(true);
    try {
      const departureAt: OutingInput["departureAt"] =
        departureMode === "freeText"
          ? { freeText: departureFreeText }
          : new Date(departureLocal).toISOString();

      let belongings: OutingInput["belongings"];
      if (belongingsMode === "freeText") {
        belongings = { freeText: belongingsFreeText };
      } else {
        belongings = belongingsText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [id, name, charge] = line.split(":").map((s) => s.trim());
            if (!id || !name) throw new Error(`Invalid belonging line: ${line}`);
            const item: Extract<OutingInput["belongings"], unknown[]>[number] = { id, name };
            if (charge !== undefined && charge !== "") {
              item.chargePercent = Number(charge);
            }
            return item;
          });
        if (belongings.length === 0) throw new Error("Add at least one belonging");
      }

      const input: OutingInput = { departureAt, belongings };
      // Free text: deterministic parsers first; inject freeTextResolver (LLM) when needed.
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
          各入力は <strong>構造化</strong> か <strong>自由文</strong> を選べます。自由文は normalize
          時に決定論パーサ（または LLM resolver）で構造化されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="departure">Departure</Label>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={departureMode === "structured" ? "default" : "outline"}
                onClick={() => setDepartureMode("structured")}
              >
                構造化
              </Button>
              <Button
                type="button"
                size="sm"
                variant={departureMode === "freeText" ? "default" : "outline"}
                onClick={() => setDepartureMode("freeText")}
              >
                自由文
              </Button>
            </div>
          </div>
          {departureMode === "structured" ? (
            <Input
              id="departure"
              type="datetime-local"
              value={departureLocal}
              onChange={(e) => setDepartureLocal(e.target.value)}
            />
          ) : (
            <Input
              id="departure-free"
              placeholder="ISO datetime, e.g. 2026-07-12T10:00:00.000Z"
              value={departureFreeText}
              onChange={(e) => setDepartureFreeText(e.target.value)}
            />
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="belongings">Belongings</Label>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={belongingsMode === "structured" ? "default" : "outline"}
                onClick={() => setBelongingsMode("structured")}
              >
                構造化
              </Button>
              <Button
                type="button"
                size="sm"
                variant={belongingsMode === "freeText" ? "default" : "outline"}
                onClick={() => setBelongingsMode("freeText")}
              >
                自由文
              </Button>
            </div>
          </div>
          {belongingsMode === "structured" ? (
            <textarea
              id="belongings"
              className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={belongingsText}
              onChange={(e) => setBelongingsText(e.target.value)}
              placeholder="id:name[:charge%] per line"
            />
          ) : (
            <textarea
              id="belongings-free"
              className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={belongingsFreeText}
              onChange={(e) => setBelongingsFreeText(e.target.value)}
              placeholder="keys:Keys, phone:Phone:20  または  Wallet 50%"
            />
          )}
          <p className="text-xs text-muted-foreground">
            自由文でパースできない文（例: 「明日の朝、いつもの荷物」）は{" "}
            <code className="rounded bg-muted px-1">freeTextResolver</code>（LLM）を渡す想定です。
          </p>
        </div>

        <Button disabled={busy || session.status === "loading"} onClick={() => void handleCreate()}>
          {busy ? "Creating…" : "Create & start session"}
        </Button>
      </CardContent>
    </Card>
  );
}
