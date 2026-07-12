import { usePearContext } from "@pear-agent/react";
import { useEffect, useId, useState } from "react";

import {
  belongingServerValueToRows,
  resolveBelongingModalDraftLocal,
  slugFromName,
  type BelongingFormRow,
} from "../lib/build-outing-input";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

type AddBelongingModalProps = {
  open: boolean;
  planId: string;
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
 * Add one belonging at a time.
 * Free text is kept raw until the user presses 「構造化して追加」— no structure on type/blur.
 */
export function AddBelongingModal({ open, planId, onClose, onAdd }: AddBelongingModalProps) {
  const { client } = usePearContext();
  const titleId = useId();
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(emptyDraft());
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Structure only here (button press), never while typing.
      const local = resolveBelongingModalDraftLocal(draft);
      if (local.kind === "structured") {
        onAdd(local.rows);
        onClose();
        return;
      }

      // Ambiguous free text → Worker (deterministic again + Gemini freeTextResolver).
      const resolved = await client.resolvePlanField(planId, {
        field: "belongings",
        freeText: local.freeText,
      });
      const rows = belongingServerValueToRows(resolved.value);
      onAdd(rows);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="Close dialog"
        disabled={busy}
        onClick={() => {
          if (!busy) onClose();
        }}
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
          入力中は構造化しません。<strong>「構造化して追加」</strong>
          を押したタイミングで構造化して一覧に出します。
        </p>

        <form className="mt-4 space-y-4" onSubmit={(e) => void handleSubmit(e)}>
          <div className="space-y-1.5">
            <Label htmlFor="belonging-free">自由文</Label>
            <Input
              id="belonging-free"
              autoFocus
              disabled={busy}
              placeholder="例: Phone 30 / 財布 / スマホ残量3割"
              value={draft.freeText}
              onChange={(e) => setDraft((d) => ({ ...d, freeText: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              追加ボタンで決定論パース → だめなら Gemini。単純な文はキー不要です。
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            <span>または直接入力（追加時にそのまま採用）</span>
            <Separator className="flex-1" />
          </div>

          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="belonging-name">名前</Label>
              <Input
                id="belonging-name"
                disabled={busy}
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
                  disabled={busy}
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
                  disabled={busy}
                  placeholder="空=不要"
                  value={draft.chargePercent}
                  onChange={(e) => setDraft((d) => ({ ...d, chargePercent: e.target.value }))}
                />
              </div>
            </div>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "構造化中…" : "構造化して追加"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
