import { useState } from "react";

import { displayName, type PrepListRow } from "../lib/build-outing-input";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type PrepListItemProps = {
  row: PrepListRow;
  index: number;
  onRemove: () => void;
  onRetry: () => void;
  onChange: (patch: Partial<PrepListRow>) => void;
};

export function PrepListItem({ row, index, onRemove, onRetry, onChange }: PrepListItemProps) {
  const kindBadge = row.kind === "belonging" ? "持ち物" : "タスク";
  const [editing, setEditing] = useState(false);

  if (row.status === "pending") {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-amber-300 bg-amber-50/80 px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{index + 1}</span>
            <Badge variant="outline">{kindBadge}</Badge>
            <Badge variant="warning">Gemini 生成中…</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {row.freeTextPreview ?? displayName(row)}
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          キャンセル
        </Button>
      </li>
    );
  }

  if (row.status === "error") {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-red-50/80 px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{index + 1}</span>
            <Badge variant="outline">{kindBadge}</Badge>
            <Badge variant="destructive">失敗</Badge>
          </div>
          <p className="truncate text-sm">{row.freeTextPreview ?? displayName(row)}</p>
          {row.errorMessage ? <p className="text-xs text-destructive">{row.errorMessage}</p> : null}
        </div>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            再試行
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            削除
          </Button>
        </div>
      </li>
    );
  }

  if (editing) {
    return (
      <li className="space-y-2 rounded-md border border-primary/30 bg-background px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">#{index + 1}</span>
          <Badge variant="secondary">{kindBadge}</Badge>
          <span className="text-xs text-muted-foreground">編集中</span>
        </div>
        {row.kind === "belonging" ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              value={row.name}
              placeholder="名前"
              onChange={(e) => onChange({ name: e.target.value } as Partial<PrepListRow>)}
            />
            <Input
              className="font-mono text-sm"
              value={row.id}
              placeholder="id"
              onChange={(e) => onChange({ id: e.target.value } as Partial<PrepListRow>)}
            />
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="充電%"
              value={row.chargePercent}
              onChange={(e) => onChange({ chargePercent: e.target.value } as Partial<PrepListRow>)}
            />
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              value={row.title}
              placeholder="タスク名"
              onChange={(e) => onChange({ title: e.target.value } as Partial<PrepListRow>)}
            />
            <Input
              className="font-mono text-sm"
              value={row.id}
              placeholder="id"
              onChange={(e) => onChange({ id: e.target.value } as Partial<PrepListRow>)}
            />
            <Input
              type="number"
              min={1}
              placeholder="所要秒"
              value={row.estimatedDurationSeconds}
              onChange={(e) =>
                onChange({ estimatedDurationSeconds: e.target.value } as Partial<PrepListRow>)
              }
            />
            <Input
              className="sm:col-span-3"
              placeholder="メモ"
              value={row.notes}
              onChange={(e) => onChange({ notes: e.target.value } as Partial<PrepListRow>)}
            />
          </div>
        )}
        <div className="flex justify-end gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
            完了
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            削除
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">#{index + 1}</span>
          <Badge variant="secondary">{kindBadge}</Badge>
          <span className="font-medium">{displayName(row)}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.id}
          </Badge>
          {row.kind === "belonging" ? (
            row.chargePercent !== "" ? (
              <Badge variant="outline">充電 {row.chargePercent}%</Badge>
            ) : (
              <Badge variant="outline">充電不要</Badge>
            )
          ) : (
            <>
              {row.estimatedDurationSeconds !== "" ? (
                <Badge variant="outline">{row.estimatedDurationSeconds}s</Badge>
              ) : null}
              {row.notes ? (
                <span className="truncate text-xs text-muted-foreground">{row.notes}</span>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
          編集
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          削除
        </Button>
      </div>
    </li>
  );
}
