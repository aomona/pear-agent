import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import {
  resolveAddPrepModalLocal,
  slugFromName,
  type ItemKind,
  type PrepListRow,
} from "../lib/build-outing-input";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";

export type AddPrepSubmit =
  | { kind: "ready"; rows: PrepListRow[] }
  | { kind: "gemini"; itemKind: ItemKind; freeText: string };

type AddPrepModalProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (result: AddPrepSubmit) => void;
};

const emptyDraft = (kind: ItemKind = "belonging") => ({
  kind,
  freeText: "",
  name: "",
  id: "",
  chargePercent: "",
  title: "",
  taskId: "",
  estimatedDurationSeconds: "",
  notes: "",
});

/**
 * Add belonging or task. Free text → optimistic pending + Gemini; direct fields → ready.
 * Uses native &lt;dialog&gt; for focus trap / Escape / backdrop.
 */
export function AddPrepModal({ open, onClose, onSubmit }: AddPrepModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (open) {
      setDraft(emptyDraft("belonging"));
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onDialogClose = () => {
      // native Escape / backdrop close
      onCloseRef.current();
    };
    el.addEventListener("close", onDialogClose);
    return () => el.removeEventListener("close", onDialogClose);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const local = resolveAddPrepModalLocal(draft);
      if (local.kind === "structured") {
        onSubmit({ kind: "ready", rows: local.rows });
      } else {
        onSubmit({
          kind: "gemini",
          itemKind: local.itemKind,
          freeText: local.freeText,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 m-auto w-full max-w-md rounded-lg border border-border bg-background p-4 text-foreground shadow-lg backdrop:bg-black/50 open:flex open:flex-col"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="text-base font-semibold">
        項目を追加
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        持ち物または準備タスク。自由文は一覧に即表示し、Gemini が裏で構造化します。
      </p>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={draft.kind === "belonging" ? "default" : "outline"}
            onClick={() => setDraft((d) => ({ ...emptyDraft("belonging"), freeText: d.freeText }))}
          >
            持ち物
          </Button>
          <Button
            type="button"
            size="sm"
            variant={draft.kind === "task" ? "default" : "outline"}
            onClick={() => setDraft((d) => ({ ...emptyDraft("task"), freeText: d.freeText }))}
          >
            タスク
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="prep-free">自由文（Gemini）</Label>
          <Input
            id="prep-free"
            autoFocus
            placeholder={
              draft.kind === "belonging"
                ? "例: スマホ残量3割と財布"
                : "例: 天気予報を確認、玄関の鍵をかける"
            }
            value={draft.freeText}
            onChange={(e) => setDraft((d) => ({ ...d, freeText: e.target.value }))}
          />
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Separator className="flex-1" />
          <span>または直接入力</span>
          <Separator className="flex-1" />
        </div>

        {draft.kind === "belonging" ? (
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="prep-name">名前</Label>
              <Input
                id="prep-name"
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
                <Label htmlFor="prep-id">id</Label>
                <Input
                  id="prep-id"
                  className="font-mono text-sm"
                  value={draft.id}
                  onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prep-charge">充電 %（任意）</Label>
                <Input
                  id="prep-charge"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.chargePercent}
                  onChange={(e) => setDraft((d) => ({ ...d, chargePercent: e.target.value }))}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="prep-title">タスク名</Label>
              <Input
                id="prep-title"
                placeholder="Lock the door"
                value={draft.title}
                onChange={(e) => {
                  const title = e.target.value;
                  const autoId = slugFromName(title);
                  const prevAuto = slugFromName(draft.title);
                  const shouldSyncId = !draft.taskId || draft.taskId === prevAuto;
                  setDraft((d) => ({
                    ...d,
                    title,
                    ...(shouldSyncId ? { taskId: autoId } : {}),
                  }));
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="prep-task-id">id</Label>
                <Input
                  id="prep-task-id"
                  className="font-mono text-sm"
                  value={draft.taskId}
                  onChange={(e) => setDraft((d) => ({ ...d, taskId: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prep-dur">所要秒（任意）</Label>
                <Input
                  id="prep-dur"
                  type="number"
                  min={1}
                  value={draft.estimatedDurationSeconds}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, estimatedDurationSeconds: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prep-notes">メモ（任意）</Label>
              <Input
                id="prep-notes"
                placeholder="Double-check deadbolt"
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              />
            </div>
          </div>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit">追加</Button>
        </div>
      </form>
    </dialog>
  );
}
