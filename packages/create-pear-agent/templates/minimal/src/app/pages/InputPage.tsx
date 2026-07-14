import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { usePearContext } from "@pear-agent/react";

import { links } from "../navigation";

export function InputPage({ planId }: { planId: string }) {
  const { client } = usePearContext();
  const artifact = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => client.getPlan(planId),
  });
  const [title, setTitle] = useState("");
  const [tasks, setTasks] = useState("Define the outcome\nBuild the smallest version\nReview it");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (artifact.data?.title) setTitle(artifact.data.title);
  }, [artifact.data?.title]);

  async function buildPlan() {
    const taskLines = tasks
      .split("\n")
      .map((task) => task.trim())
      .filter(Boolean);
    if (!title.trim() || taskLines.length === 0) return;
    setBuilding(true);
    setError(null);
    try {
      await client.buildPlanArtifact(planId, { title: title.trim(), tasks: taskLines });
      window.location.hash = links.plan(planId).slice(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBuilding(false);
    }
  }

  if (artifact.isLoading) return <div className="panel muted">Loading plan…</div>;
  if (artifact.isError) return <div className="panel error-message">{artifact.error.message}</div>;

  return (
    <section className="page-stack narrow-page">
      <div className="page-heading">
        <span className="step-number">02</span>
        <div>
          <p className="eyebrow">Input</p>
          <h1>Describe the work.</h1>
          <p>This is the main seam to replace with your own domain input.</p>
        </div>
      </div>
      <div className="panel form-stack">
        <label htmlFor="work-title">Outcome</label>
        <input id="work-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <label htmlFor="tasks">Tasks, one per line</label>
        <textarea
          id="tasks"
          rows={8}
          value={tasks}
          onChange={(event) => setTasks(event.target.value)}
        />
        <div className="button-row">
          <a className="button secondary" href={links.plans()}>
            Back
          </a>
          <button
            disabled={building || !title.trim() || !tasks.trim()}
            onClick={() => void buildPlan()}
          >
            {building ? "Building…" : "Build execution plan"}
          </button>
        </div>
        {error && <p className="error-message">{error}</p>}
      </div>
    </section>
  );
}
