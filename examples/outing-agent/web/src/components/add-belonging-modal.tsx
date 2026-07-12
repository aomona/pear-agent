import { useEffect, useId, useState } from "react";

import {
  resolveBelongingModalDraft,
  slugFromName,
  type BelongingFormRow,
} from "../lib/build-outing-input";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

type AddBelongingModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (rows: BelongingFormRow[]) => void;
};

const emptyDraft = () => ({
  freeText: "",
  name: "",
  id: "",
  chargePercent: "",
});

/**
 * Add one belonging at a time: free text → structured, or direct fields.
 */
export function AddBelongingModal({ open, onClose, onAdd }: AddBelongingModalProps) {
  const titleId = useId();
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(emptyDraft());
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const rows = resolveBelongingModalDraft(draft);
      onAdd(rows);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 w-full max-w-md rounded-lg border bg-background p-4 shadow-lg"
      >
        <h2 id={titleId} className="text-base font-semibold">
          持ち物を追加
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          自由文を入れると構造化して一覧に追加します。1 回の追加 = 1
          件（またはカンマ区切り数件）です。
        </p>

        <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="belonging-free">自由文</Label>
            <Input
              id="belonging-free"
              autoFocus
              placeholder="例: Phone 30 / phone:Phone:20 / 財布"
              value={draft.freeText}
              onChange={(e) => setDraft((d) => ({ ...d, freeText: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              追加時に決定論パーサで構造化します（曖昧な長文は不可。下の欄を使ってください）。
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            <span>または直接入力</span>
            <Separator className="flex-1" />
          </div>

          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="belonging-name">名前</Label>
              <Input
                id="belonging-name"
                placeholder="Phone"
                value={draft.name}
                onChange={(e) => {
                  const name = e.target.value;
                  const autoId = slugFromName(name);
                  const prevAuto = slugFromName(draft.name);
                  const shouldSyncId = !draft.id || draft.id === prevAuto;
                  setDraft((d) => ({
                    ...d,
                    name,
                    ...(shouldSyncId ? { id: autoId } : {}),
                  }));
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="belonging-id">id</Label>
                <Input
                  id="belonging-id"
                  className="font-mono text-sm"
                  placeholder="phone"
                  value={draft.id}
                  onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="belonging-charge">充電 %（任意）</Label>
                <Input
                  id="belonging-charge"
                  type="number"
                  min={0}
                  max={100}
                  placeholder="空=不要"
                  value={draft.chargePercent}
                  onChange={(e) => setDraft((d) => ({ ...d, chargePercent: e.target.value }))}
                />
              </div>
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit">追加</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
