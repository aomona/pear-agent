import { useEffect, useId, useState } from "react";

import {
  resolveBelongingModalDraftLocal,
  slugFromName,
  type BelongingFormRow,
} from "../lib/build-outing-input";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

export type AddBelongingSubmit =
  | { kind: "ready"; rows: BelongingFormRow[] }
  /** Parent shows optimistic row + runs Gemini in background (TanStack mutation). */
  | { kind: "gemini"; freeText: string };

type AddBelongingModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called immediately; Gemini path does not wait for the network. */
  onSubmit: (result: AddBelongingSubmit) => void;
};

const emptyDraft = () => ({
  freeText: "",
  name: "",
  id: "",
  chargePercent: "",
});

/**
 * Modal only collects input. Free text is not structured here —
 * parent optimistically lists a pending row and mutates with Gemini.
 */
export function AddBelongingModal({ open, onClose, onSubmit }: AddBelongingModalProps) {
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
      const local = resolveBelongingModalDraftLocal(draft);
      if (local.kind === "structured") {
        onSubmit({ kind: "ready", rows: local.rows });
      } else {
        onSubmit({ kind: "gemini", freeText: local.freeText });
      }
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
          「追加」ですぐ一覧に出ます。自由文は Gemini 生成中…
          として並び、完了後に構造化結果へ差し替わります。複数件を並行して積めます。
        </p>

        <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="belonging-free">自由文（Gemini）</Label>
            <Input
              id="belonging-free"
              autoFocus
              placeholder="例: スマホ残量3割と財布"
              value={draft.freeText}
              onChange={(e) => setDraft((d) => ({ ...d, freeText: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              GEMINI_API_KEY 必須。一覧に先に表示し、裏で構造化します。
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            <span>または直接入力（即 ready）</span>
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
