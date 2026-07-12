import { usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  buildOutingInputFromForm,
  defaultDepartureLocal,
  type OutingFormState,
} from "../lib/build-outing-input";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type PlanInputPanelProps = {
  planId: string;
  artifact: PlanArtifactDetail | null;
  onNormalized: (artifact: PlanArtifactDetail) => void;
  onBack: () => void;
};

export function PlanInputPanel({ planId, artifact, onNormalized, onBack }: PlanInputPanelProps) {
  const { client } = usePearContext();
  const [form, setForm] = useState<OutingFormState>({
    departureMode: "structured",
    belongingsMode: "structured",
    departureLocal: defaultDepartureLocal(),
    departureFreeText: "tomorrow morning 10:00",
    belongingsText: "keys:Keys\nphone:Phone:20\nwallet:Wallet",
    belongingsFreeText: "keys and phone at 30 percent, wallet",
  });
  const [busy, setBusy] = useState(false);

  async function handleNormalize() {
    setBusy(true);
    try {
      const input = buildOutingInputFromForm(form);
      // Server: deterministic parse first, then Gemini freeTextResolver when needed.
      const next = await client.normalizePlanInput(planId, input);
      toast.success("Input normalized and saved on plan");
      onNormalized(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>2. What to prepare</CardTitle>
            <CardDescription>
              構造化 or 自由文。Normalize は Worker 側（決定論 → Gemini）。
              {artifact?.normalizedInput ? " 既存の normalizedInput があります。" : ""}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to list
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="departure">Departure</Label>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={form.departureMode === "structured" ? "default" : "outline"}
                onClick={() => setForm((f) => ({ ...f, departureMode: "structured" }))}
              >
                構造化
              </Button>
              <Button
                type="button"
                size="sm"
                variant={form.departureMode === "freeText" ? "default" : "outline"}
                onClick={() => setForm((f) => ({ ...f, departureMode: "freeText" }))}
              >
                自由文
              </Button>
            </div>
          </div>
          {form.departureMode === "structured" ? (
            <Input
              id="departure"
              type="datetime-local"
              value={form.departureLocal}
              onChange={(e) => setForm((f) => ({ ...f, departureLocal: e.target.value }))}
            />
          ) : (
            <Input
              id="departure-free"
              placeholder="tomorrow morning / ISO datetime"
              value={form.departureFreeText}
              onChange={(e) => setForm((f) => ({ ...f, departureFreeText: e.target.value }))}
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
                variant={form.belongingsMode === "structured" ? "default" : "outline"}
                onClick={() => setForm((f) => ({ ...f, belongingsMode: "structured" }))}
              >
                構造化
              </Button>
              <Button
                type="button"
                size="sm"
                variant={form.belongingsMode === "freeText" ? "default" : "outline"}
                onClick={() => setForm((f) => ({ ...f, belongingsMode: "freeText" }))}
              >
                自由文
              </Button>
            </div>
          </div>
          {form.belongingsMode === "structured" ? (
            <textarea
              id="belongings"
              className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.belongingsText}
              onChange={(e) => setForm((f) => ({ ...f, belongingsText: e.target.value }))}
              placeholder="id:name[:charge%] per line"
            />
          ) : (
            <textarea
              id="belongings-free"
              className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.belongingsFreeText}
              onChange={(e) => setForm((f) => ({ ...f, belongingsFreeText: e.target.value }))}
              placeholder="keys and phone at 30 percent"
            />
          )}
          <p className="text-xs text-muted-foreground">
            自然文は GEMINI_API_KEY が必要です。構造化・ISO / id:name 形式はキーなしで通ります。
          </p>
        </div>

        {artifact?.normalizedInput !== undefined ? (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">
            {JSON.stringify(artifact.normalizedInput, null, 2)}
          </pre>
        ) : null}

        <Button disabled={busy} onClick={() => void handleNormalize()}>
          {busy ? "Normalizing…" : "Normalize & continue"}
        </Button>
      </CardContent>
    </Card>
  );
}
