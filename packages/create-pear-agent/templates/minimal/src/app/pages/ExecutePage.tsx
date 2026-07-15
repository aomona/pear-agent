import { useExecutionSession, useRuntimeSnapshot } from "@pear-agent/react";

import { links } from "../navigation";

export function ExecutePage({ sessionId }: { sessionId: string }) {
  const actions = useExecutionSession(sessionId);
  const runtime = useRuntimeSnapshot(sessionId);

  async function updateStep(stepId: string, status: string) {
    if (status === "ready" || status === "paused") {
      await actions.startStep({ stepId });
    } else if (status === "active") {
      await actions.completeStep({ stepId });
    }
    await runtime.refetch();
  }

  if (runtime.status === "loading" || !runtime.snapshot) {
    return <div className="panel muted">Connecting to execution session…</div>;
  }
  if (runtime.error) return <div className="panel error-message">{runtime.error.message}</div>;

  const { plan, session, stepStates } = runtime.snapshot;
  const completed = Object.values(stepStates).filter(({ status }) => status === "completed").length;

  return (
    <section className="page-stack">
      <div className="page-heading execution-heading">
        <span className="step-number">04</span>
        <div>
          <p className="eyebrow">Execute · {session.status}</p>
          <h1>{plan.title ?? "Execution session"}</h1>
          <p>
            {completed} of {plan.steps.length} tasks complete. This state survives refreshes and
            reconnects.
          </p>
        </div>
      </div>
      <div className="progress" aria-label={`${completed} of ${plan.steps.length} complete`}>
        <span
          style={{ width: `${plan.steps.length ? (completed / plan.steps.length) * 100 : 0}%` }}
        />
      </div>
      <ol className="step-list">
        {plan.steps.map((step, index) => {
          const status = stepStates[step.id]?.status ?? "blocked";
          const actionable = ["ready", "active", "paused"].includes(status);
          return (
            <li className={`panel step-card execution-step is-${status}`} key={step.id}>
              <span className="step-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{step.label ?? step.id}</h2>
                <p className="status-label">{status}</p>
              </div>
              {actionable && (
                <button
                  className={status === "active" ? "complete-button" : "secondary-button"}
                  disabled={actions.status === "loading"}
                  onClick={() => void updateStep(step.id, status)}
                >
                  {status === "active" ? "Complete" : "Start"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {actions.error && <p className="error-message">{actions.error.message}</p>}
      <div className="button-row end">
        <a className="button secondary" href={links.plans()}>
          Back to plans
        </a>
      </div>
    </section>
  );
}
