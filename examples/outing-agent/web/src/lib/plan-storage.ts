const PLAN_KEY = "pear-outing-plan-id:v1";
const PHASE_KEY = "pear-outing-phase:v1";
const LEGACY_PLAN_KEY = "pear-outing-plan-id";
const LEGACY_PHASE_KEY = "pear-outing-phase";

export type DemoPhase = "list" | "input" | "plan" | "execute";

export function loadStoredPlanId(): string | null {
  try {
    return localStorage.getItem(PLAN_KEY) ?? localStorage.getItem(LEGACY_PLAN_KEY);
  } catch {
    return null;
  }
}

export function storePlanId(planId: string | null): void {
  try {
    if (planId) {
      localStorage.setItem(PLAN_KEY, planId);
      localStorage.removeItem(LEGACY_PLAN_KEY);
    } else {
      localStorage.removeItem(PLAN_KEY);
      localStorage.removeItem(LEGACY_PLAN_KEY);
    }
  } catch {
    // ignore
  }
}

export function loadStoredPhase(): DemoPhase | null {
  try {
    const raw = localStorage.getItem(PHASE_KEY) ?? localStorage.getItem(LEGACY_PHASE_KEY);
    if (raw === "list" || raw === "input" || raw === "plan" || raw === "execute") return raw;
    return null;
  } catch {
    return null;
  }
}

export function storePhase(phase: DemoPhase): void {
  try {
    localStorage.setItem(PHASE_KEY, phase);
    localStorage.removeItem(LEGACY_PHASE_KEY);
  } catch {
    // ignore
  }
}
