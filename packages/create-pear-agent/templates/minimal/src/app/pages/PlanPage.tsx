import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useExecutionSession, usePearContext, type PlanEditProposal } from "@pear-agent/react";

import { pearConfig } from "../../pear.config";
import { links } from "../navigation";

export function PlanPage({ planId }: { planId: string }) {
  const { client } = usePearContext();
  const session = useExecutionSession();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editRequest, setEditRequest] = useState("");
  const [proposal, setProposal] = useState<PlanEditProposal | null>(null);
  const artifact = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => client.getPlan(planId),
  });

  async function startExecution() {
    if (!artifact.data) return;
    setStarting(true);
    setError(null);
    try {
      if (artifact.data.status !== "ready") {
        await client.updatePlan(planId, { status: "ready" });
      }
      const created = await session.create({
        domainId: artifact.data.domainId,
        actorIds: [pearConfig.actorId],
        planArtifactId: planId,
      });
      await session.startSession();
      window.location.hash = links.execute(created.sessionId).slice(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }

  if (artifact.isLoading) return <div className="panel muted">Building plan…</div>;
  if (artifact.isError) return <div className="panel error-message">{artifact.error.message}</div>;
  if (!artifact.data) return null;

  return (
    <section className="page-stack">
      <div className="page-heading">
        <span className="step-number">03</span>
        <div>
          <p className="eyebrow">Review</p>
          <h1>{artifact.data.title ?? "Execution plan"}</h1>
          <p>Confirm the sequence before creating a durable execution session.</p>
        </div>
      </div>
      <ol className="step-list">
        {artifact.data.currentPlan.steps.map((step, index) => (
          <li className="panel step-card" key={step.id}>
            <span className="step-index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h2>{step.label ?? step.id}</h2>
              <p>{step.summary ?? step.instructions}</p>
            </div>
            <span className="duration">{Math.ceil(step.estimatedDurationSeconds / 60)} min</span>
          </li>
        ))}
      </ol>
      <div className="panel form-stack">
        <p className="eyebrow">Natural-language edit</p>
        <label htmlFor="edit-request">Describe the change</label>
        <input
          id="edit-request"
          value={editRequest}
          onChange={(event) => setEditRequest(event.target.value)}
          placeholder="Move the important work earlier…"
        />
        <button
          className="secondary"
          disabled={!editRequest.trim()}
          onClick={() =>
            void client
              .proposePlanEdit(planId, editRequest)
              .then(setProposal)
              .catch((caught) =>
                setError(caught instanceof Error ? caught.message : String(caught)),
              )
          }
        >
          Preview diff
        </button>
        {proposal && (
          <div className="diff-summary">
            <p>
              {proposal.diff.addedStepIds.length} added · {proposal.diff.updatedStepIds.length}{" "}
              changed · {proposal.diff.removedStepIds.length} removed ·{" "}
              {proposal.diff.durationDeltaSeconds >= 0 ? "+" : ""}
              {proposal.diff.durationDeltaSeconds}s
            </p>
            <button
              onClick={() =>
                void client
                  .confirmPlanEdit(planId, proposal.id)
                  .then(() => window.location.reload())
                  .catch((caught) =>
                    setError(caught instanceof Error ? caught.message : String(caught)),
                  )
              }
            >
              Apply reviewed edit
            </button>
          </div>
        )}
      </div>
      <div className="button-row end">
        <a className="button secondary" href={links.input(planId)}>
          Edit input
        </a>
        <button disabled={starting} onClick={() => void startExecution()}>
          {starting ? "Starting…" : "Start execution"}
        </button>
      </div>
      {error && <p className="error-message">{error}</p>}
    </section>
  );
}
