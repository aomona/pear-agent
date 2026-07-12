import { outingDomain } from "@pear-agent/outing-domain-example";
import { PearProvider, usePearContext, type PlanArtifactDetail } from "@pear-agent/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { DelayReplanPanel } from "./components/delay-replan-panel";
import { PlanDraftPanel } from "./components/plan-draft-panel";
import { PlanInputPanel } from "./components/plan-input-panel";
import { PlanListPanel } from "./components/plan-list-panel";
import { PlanStepsPanel } from "./components/plan-steps-panel";
import { VoiceContinuationPanel } from "./components/voice-continuation-panel";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  loadStoredPhase,
  loadStoredPlanId,
  storePhase,
  storePlanId,
  type DemoPhase,
} from "./lib/plan-storage";
import { loadStoredSessionId, storeSessionId } from "./lib/session-storage";

const API_BASE = import.meta.env.VITE_PEAR_API_BASE ?? "http://127.0.0.1:8787";
const ACTOR_ID = "demo-user";

const PHASES: { id: DemoPhase; label: string }[] = [
  { id: "list", label: "一覧" },
  { id: "input", label: "入力" },
  { id: "plan", label: "計画" },
  { id: "execute", label: "実行" },
];

function DemoShell() {
  const { client } = usePearContext();
  const [phase, setPhase] = useState<DemoPhase>(() => loadStoredPhase() ?? "list");
  const [planId, setPlanId] = useState<string | null>(() => loadStoredPlanId());
  const [artifact, setArtifact] = useState<PlanArtifactDetail | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(() => loadStoredSessionId());
  const [loadingPlan, setLoadingPlan] = useState(false);

  useEffect(() => {
    storePhase(phase);
  }, [phase]);

  useEffect(() => {
    storePlanId(planId);
  }, [planId]);

  useEffect(() => {
    storeSessionId(sessionId);
  }, [sessionId]);

  const loadArtifact = useCallback(
    async (id: string) => {
      setLoadingPlan(true);
      try {
        const next = await client.getPlan(id);
        if (next.domainId !== outingDomain.id) {
          throw new Error(`Unexpected domain ${next.domainId}`);
        }
        setArtifact(next);
        setPlanId(id);
        return next;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        setArtifact(null);
        return null;
      } finally {
        setLoadingPlan(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (planId && phase !== "list") {
      void loadArtifact(planId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- hydrate once on mount

  const goList = () => {
    setPhase("list");
    setPlanId(null);
    setArtifact(null);
  };

  const openPlan = async (id: string) => {
    const next = await loadArtifact(id);
    if (!next) return;
    if (sessionId) {
      setPhase("execute");
      return;
    }
    if (next.normalizedInput === undefined) {
      setPhase("input");
    } else if (next.currentPlan.steps.length === 0 || next.status === "draft") {
      setPhase("plan");
    } else {
      setPhase("plan");
    }
  };

  const onCreatedPlan = async (id: string) => {
    await loadArtifact(id);
    setPhase("input");
  };

  const onNormalized = (next: PlanArtifactDetail) => {
    setArtifact(next);
    setPhase("plan");
  };

  const onSessionStarted = (id: string) => {
    setSessionId(id);
    setPhase("execute");
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">PEAR Outing Agent</h1>
            <p className="text-xs text-muted-foreground">
              Plan library → Input → Plan → Execute · demo UI
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PHASES.map((p) => (
              <Badge
                key={p.id}
                variant={phase === p.id ? "default" : "outline"}
                className="cursor-default"
              >
                {p.label}
              </Badge>
            ))}
            {planId ? (
              <Badge variant="outline" className="font-mono text-xs max-w-[140px] truncate">
                plan {planId.slice(0, 8)}…
              </Badge>
            ) : null}
            {sessionId ? (
              <>
                <Badge variant="outline" className="font-mono text-xs max-w-[140px] truncate">
                  sess {sessionId.slice(0, 8)}…
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSessionId(null);
                    if (planId) setPhase("plan");
                    else setPhase("list");
                  }}
                >
                  Leave session
                </Button>
              </>
            ) : null}
            <Button size="sm" variant="ghost" onClick={goList}>
              Plans
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 md:grid-cols-2">
        {phase === "list" ? (
          <div className="md:col-span-2">
            <PlanListPanel
              onOpenPlan={(id) => void openPlan(id)}
              onCreatedPlan={(id) => void onCreatedPlan(id)}
            />
          </div>
        ) : null}

        {phase === "input" && planId ? (
          <div className="md:col-span-2">
            {loadingPlan && !artifact ? (
              <p className="text-sm text-muted-foreground">Loading plan…</p>
            ) : (
              <PlanInputPanel
                planId={planId}
                artifact={artifact}
                onNormalized={onNormalized}
                onBack={goList}
              />
            )}
          </div>
        ) : null}

        {phase === "plan" && planId && artifact ? (
          <div className="md:col-span-2">
            <PlanDraftPanel
              planId={planId}
              artifact={artifact}
              onArtifactChange={setArtifact}
              onBackToInput={() => setPhase("input")}
              onSessionStarted={onSessionStarted}
            />
          </div>
        ) : null}

        {phase === "execute" ? (
          <>
            <div className="md:col-span-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Running execution session from saved plan.</span>
              {planId ? (
                <Button size="sm" variant="ghost" onClick={() => setPhase("plan")}>
                  Back to plan
                </Button>
              ) : null}
            </div>
            <PlanStepsPanel sessionId={sessionId} />
            <VoiceContinuationPanel sessionId={sessionId} />
            <div className="md:col-span-2">
              <DelayReplanPanel sessionId={sessionId} />
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

export function App() {
  return (
    <PearProvider
      baseUrl={API_BASE}
      getContext={() => ({
        actorId: ACTOR_ID,
        roles: ["owner"],
        claims: {},
      })}
    >
      <DemoShell />
    </PearProvider>
  );
}
