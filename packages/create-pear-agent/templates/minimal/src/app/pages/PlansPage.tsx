import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePearContext } from "@pear-agent/react";

import { buildStarterGoal } from "../../domain/plan";
import { pearConfig } from "../../pear.config";
import { links } from "../navigation";

export function PlansPage() {
  const { client } = usePearContext();
  const [title, setTitle] = useState("Launch my project");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({
    queryKey: ["plans", pearConfig.domainId],
    queryFn: () => client.listPlans({ domainId: pearConfig.domainId }),
  });

  async function createDraft() {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    setCreating(true);
    setError(null);
    try {
      const artifact = await client.createPlan({
        domainId: pearConfig.domainId,
        goal: buildStarterGoal(cleanTitle),
        title: cleanTitle,
      });
      window.location.hash = links.input(artifact.id).slice(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <span className="step-number">01</span>
        <div>
          <p className="eyebrow">Plan library</p>
          <h1>Choose work worth finishing.</h1>
          <p>Create a durable plan, shape its inputs, then execute it step by step.</p>
        </div>
      </div>

      <div className="panel create-row">
        <label htmlFor="plan-title">New plan title</label>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createDraft();
          }}
        >
          <input
            id="plan-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Launch my project"
          />
          <button type="submit" disabled={creating || !title.trim()}>
            {creating ? "Creating…" : "Create plan"}
          </button>
        </form>
        {error && <p className="error-message">{error}</p>}
      </div>

      <div className="plan-grid" aria-live="polite">
        {plans.isLoading && <div className="panel muted">Loading plans…</div>}
        {plans.isError && <div className="panel error-message">{plans.error.message}</div>}
        {plans.data?.length === 0 && (
          <div className="panel empty-state">No plans yet. Create your first one above.</div>
        )}
        {plans.data?.map((plan) => (
          <a className="plan-card" href={links.input(plan.id)} key={plan.id}>
            <span className={`status status-${plan.status}`}>{plan.status}</span>
            <h2>{plan.title ?? "Untitled plan"}</h2>
            <p>Version {plan.version}</p>
            <span className="text-link">Open plan →</span>
          </a>
        ))}
      </div>
    </section>
  );
}
