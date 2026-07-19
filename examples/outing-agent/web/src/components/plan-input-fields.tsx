import type { OutingFormState } from "../lib/build-outing-input";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type DepartureFieldsProps = {
  form: OutingFormState;
  setForm: React.Dispatch<React.SetStateAction<OutingFormState>>;
};

export function DepartureFields({ form, setForm }: DepartureFieldsProps) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">出発時刻</h3>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={form.departureMode === "structured" ? "default" : "outline"}
            onClick={() => setForm((f) => ({ ...f, departureMode: "structured" }))}
          >
            日時
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
          type="datetime-local"
          value={form.departureLocal}
          onChange={(e) => setForm((f) => ({ ...f, departureLocal: e.target.value }))}
        />
      ) : (
        <Input
          placeholder="例: 明日の朝10時"
          value={form.departureFreeText}
          onChange={(e) => setForm((f) => ({ ...f, departureFreeText: e.target.value }))}
        />
      )}
    </section>
  );
}

type PlaceFieldsProps = {
  form: OutingFormState;
  setForm: React.Dispatch<React.SetStateAction<OutingFormState>>;
  placeBusy: "origin" | "destination" | null;
  onResolvePlace: (which: "origin" | "destination") => void;
};

export function PlaceFields({ form, setForm, placeBusy, onResolvePlace }: PlaceFieldsProps) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">行き先</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="origin">出発地</Label>
          <div className="flex gap-2">
            <Input
              id="origin"
              placeholder="Home / 渋谷"
              value={form.originLabel}
              onChange={(e) => setForm((f) => ({ ...f, originLabel: e.target.value }))}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={placeBusy !== null}
              onClick={() => onResolvePlace("origin")}
            >
              {placeBusy === "origin" ? "…" : "整える"}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dest">目的地</Label>
          <div className="flex gap-2">
            <Input
              id="dest"
              placeholder="Office / 横浜"
              value={form.destinationLabel}
              onChange={(e) => setForm((f) => ({ ...f, destinationLabel: e.target.value }))}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={placeBusy !== null}
              onClick={() => onResolvePlace("destination")}
            >
              {placeBusy === "destination" ? "…" : "整える"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
