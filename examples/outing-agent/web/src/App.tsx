import { PearProvider } from "@pear-agent/react";
import { useCallback, useEffect, useState } from "react";

import { DelayReplanPanel } from "./components/delay-replan-panel";
import { PlanStepsPanel } from "./components/plan-steps-panel";
import { SetupPanel } from "./components/setup-panel";
import { VoiceContinuationPanel } from "./components/voice-continuation-panel";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { loadStoredSessionId, storeSessionId } from "./lib/session-storage";

const API_BASE = import.meta.env.VITE_PEAR_API_BASE ?? "http://127.0.0.1:8787";
const ACTOR_ID = "demo-user";

function DemoShell() {
  const [sessionId, setSessionId] = useState<string | null>(() => loadStoredSessionId());

  useEffect(() => {
    storeSessionId(sessionId);
  }, [sessionId]);

  const onSessionCreated = useCallback((id: string) => {
    setSessionId(id);
  }, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">PEAR Outing Agent</h1>
            <p className="text-xs text-muted-foreground">
              Plan → Execute → Assess → Replan · demo UI (shadcn/ui)
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sessionId ? (
              <>
                <Badge variant="outline" className="font-mono text-xs max-w-[220px] truncate">
                  {sessionId}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(sessionId);
                  }}
                >
                  Copy id
                </Button>
                <Button size="sm" variant="outline" onClick={() => setSessionId(null)}>
                  Clear
                </Button>
              </>
            ) : (
              <Badge variant="secondary">no session</Badge>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 md:grid-cols-2">
        <div className="space-y-6 md:col-span-2">
          <SetupPanel onSessionCreated={onSessionCreated} />
        </div>
        <PlanStepsPanel sessionId={sessionId} />
        <VoiceContinuationPanel sessionId={sessionId} />
        <div className="md:col-span-2">
          <DelayReplanPanel sessionId={sessionId} />
        </div>
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
