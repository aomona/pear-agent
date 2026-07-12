import { readyItems, type OutingFormState } from "../lib/build-outing-input";
import { Badge } from "./ui/badge";

type InputSummaryProps = {
  form: OutingFormState;
};

/** Compact pre-normalize overview so users know what they're committing. */
export function InputSummary({ form }: InputSummaryProps) {
  const ready = readyItems(form.items);
  const belongings = ready.filter((r) => r.kind === "belonging");
  const tasks = ready.filter((r) => r.kind === "task");
  const pending = form.items.filter((r) => r.status === "pending").length;
  const failed = form.items.filter((r) => r.status === "error").length;

  const route =
    form.originLabel.trim() && form.destinationLabel.trim()
      ? `${form.originLabel.trim()} → ${form.destinationLabel.trim()}`
      : form.destinationLabel.trim()
        ? `→ ${form.destinationLabel.trim()}`
        : form.originLabel.trim()
          ? `${form.originLabel.trim()} →`
          : "行き先未設定";

  const when =
    form.departureMode === "freeText"
      ? form.departureFreeText.trim() || "出発未設定"
      : form.departureLocal.replace("T", " ") || "出発未設定";

  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">サマリー</span>
        <Badge variant="outline">{route}</Badge>
        <Badge variant="outline">{when}</Badge>
        <Badge variant="secondary">荷物 {belongings.length}</Badge>
        <Badge variant="secondary">タスク {tasks.length}</Badge>
        {pending > 0 ? <Badge variant="warning">生成中 {pending}</Badge> : null}
        {failed > 0 ? <Badge variant="destructive">失敗 {failed}</Badge> : null}
      </div>
      {ready.length > 0 ? (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {ready.map((r) => r.name).join(" · ")}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          プリセットを選ぶか、＋追加で持ち物・タスクを入れてください。
        </p>
      )}
    </div>
  );
}
