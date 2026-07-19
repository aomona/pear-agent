import type { ExecutionPlan } from "@pear-agent/core";

export function orderMeta(plan: ExecutionPlan) {
  const meta = plan.metadata ?? {};
  return {
    refined: meta.orderRefined === true,
    reason: typeof meta.orderRefineReason === "string" ? meta.orderRefineReason : undefined,
  };
}

export function generateSuccessMessage(plan: ExecutionPlan): string {
  const { refined, reason } = orderMeta(plan);
  if (refined) return "計画を作成しました（順序を Gemini が調整）";
  switch (reason) {
    case "no_api_key":
      return "計画を作成しました（並列のまま — GEMINI_API_KEY 未設定）";
    case "single_step":
      return "計画を作成しました（1 step のため順序調整なし）";
    case "parse_failed":
      return "計画を作成しました（順序調整に失敗 — 並列のまま）";
    case "disabled":
      return "計画を作成しました（順序調整オフ）";
    default:
      return reason
        ? `計画を作成しました（並列のまま — ${reason.slice(0, 80)}）`
        : "計画を作成しました（並列のまま）";
  }
}

export function orderBadgeLabel(plan: ExecutionPlan): string | null {
  if (plan.steps.length === 0) return null;
  const { refined, reason } = orderMeta(plan);
  if (refined) return "順序: Gemini 調整済";
  if (reason === "no_api_key") return "順序: 並列（キー無し）";
  if (reason === "single_step") return "順序: 1 step";
  if (reason === "disabled") return "順序: 調整オフ";
  if (reason) return "順序: 並列（調整失敗）";
  return "順序: 未調整 / 並列";
}
