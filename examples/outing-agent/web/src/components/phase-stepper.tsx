import type { DemoPhase } from "../lib/plan-storage";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

const PHASES: { id: DemoPhase; label: string; hint: string }[] = [
  { id: "list", label: "1. 一覧", hint: "Plan を選ぶ" },
  { id: "input", label: "2. 入力", hint: "準備を書く" },
  { id: "plan", label: "3. 計画", hint: "確認して開始" },
  { id: "execute", label: "4. 実行", hint: "いまやること" },
];

type PhaseStepperProps = {
  phase: DemoPhase;
  /** Which phases the user can jump to. */
  canGo: Partial<Record<DemoPhase, boolean>>;
  onSelect: (phase: DemoPhase) => void;
};

export function PhaseStepper({ phase, canGo, onSelect }: PhaseStepperProps) {
  return (
    <nav aria-label="Demo phases" className="flex w-full flex-wrap gap-1">
      {PHASES.map((p, index) => {
        const active = phase === p.id;
        const enabled = canGo[p.id] ?? false;
        return (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant={active ? "default" : "outline"}
            disabled={!enabled && !active}
            className={cn(
              "h-auto flex-col items-start gap-0 px-2.5 py-1.5 text-left",
              !enabled && !active && "opacity-50",
            )}
            onClick={() => {
              if (enabled || active) onSelect(p.id);
            }}
          >
            <span className="text-xs font-semibold">{p.label}</span>
            <span
              className={cn(
                "text-[10px] font-normal",
                active ? "text-primary-foreground/80" : "text-muted-foreground",
              )}
            >
              {p.hint}
            </span>
            {index < PHASES.length - 1 ? <span className="sr-only">then</span> : null}
          </Button>
        );
      })}
    </nav>
  );
}
