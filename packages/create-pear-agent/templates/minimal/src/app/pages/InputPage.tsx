import { usePlanCompiler } from "@pear-agent/react";
import { useEffect, useMemo, useState } from "react";

import { links } from "../navigation";

export function InputPage({ planId }: { planId: string }) {
  const compiler = usePlanCompiler(planId);
  const [request, setRequest] = useState("Turn this source material into a clear execution plan.");
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const clarification = compiler.result?.clarification;

  useEffect(() => {
    // Drop answers from a previous clarification round (server requires exact key set).
    setAnswers({});
  }, [clarification?.id]);

  const hasReadySource = useMemo(() => {
    const sources = compiler.inspector?.sources ?? [];
    return sources.some((item) => item.status === "ready" || item.status === "pending");
  }, [compiler.inspector?.sources]);

  const canCompile =
    compiler.status !== "loading" &&
    request.trim().length > 0 &&
    (source.trim().length > 0 || url.trim().length > 0 || hasReadySource);

  async function ensureSources() {
    // Only add when the field has content; clear after success so recompile does not duplicate.
    if (source.trim()) {
      await compiler.addTextSource({ label: "Brief", content: source.trim() });
      setSource("");
    }
    if (url.trim()) {
      await compiler.addUrlSource({ url: url.trim() });
      setUrl("");
    }
  }

  async function compile() {
    await ensureSources();
    const result = await compiler.compile({ request });
    if (result.artifact) window.location.hash = links.plan(planId).slice(1);
  }

  async function continueCompile() {
    if (!clarification) return;
    const scopedAnswers = Object.fromEntries(
      clarification.questions.map((question) => [question.id, answers[question.id]?.trim() ?? ""]),
    );
    const result = await compiler.answerAndCompile(clarification.id, scopedAnswers, { request });
    if (result.artifact) window.location.hash = links.plan(planId).slice(1);
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <span className="step-number">02</span>
        <div>
          <p className="eyebrow">Sources → Compile</p>
          <h1>自然言語から実行計画へ。</h1>
          <p>テキスト、公開 URL、PDF・Markdown・JSON を一つの durable artifact にまとめます。</p>
        </div>
      </div>
      <div className="workspace-grid">
        <div className="panel form-stack">
          <label htmlFor="request">What should PEAR accomplish?</label>
          <textarea
            id="request"
            rows={3}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
          />
          <label htmlFor="source">Source text</label>
          <textarea
            id="source"
            rows={10}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Describe the outcome, constraints, context, and useful facts here."
          />
          <label htmlFor="url">Public source URL (optional)</label>
          <input
            id="url"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
          />
          <label className="file-button">
            Add PDF / text file
            <input
              type="file"
              accept=".pdf,.txt,.md,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void compiler.addFileSource(file).catch(() => {});
                event.target.value = "";
              }}
            />
          </label>
          <button
            disabled={!canCompile}
            onClick={() => {
              void compile().catch(() => {});
            }}
          >
            {compiler.status === "loading" ? "Compiling…" : "Compile with AI"}
          </button>
          {clarification && (
            <div className="clarification-box">
              <p className="eyebrow">Clarification required</p>
              {clarification.questions.map((question) => (
                <label key={question.id}>
                  {question.question}
                  <input
                    value={answers[question.id] ?? ""}
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <button
                disabled={
                  compiler.status === "loading" ||
                  !clarification.questions.every((question) => answers[question.id]?.trim())
                }
                onClick={() => {
                  void continueCompile().catch(() => {});
                }}
              >
                Continue compile
              </button>
            </div>
          )}
          {compiler.error && <p className="error-message">{compiler.error.message}</p>}
        </div>
        <aside className="panel artifact-inspector">
          <p className="eyebrow">Artifact inspector</p>
          <h2>Durable compile trace</h2>
          <p>{compiler.inspector?.sources.length ?? 0} sources</p>
          <p>{compiler.inspector?.jobs.length ?? 0} compile jobs</p>
          <p>{compiler.inspector?.generations.length ?? 0} model generations</p>
          <ul className="source-list">
            {(compiler.inspector?.sources ?? []).map((item) => (
              <li key={item.id}>
                {item.label} <span className="muted">({item.kind})</span>
              </li>
            ))}
          </ul>
          <button
            className="secondary"
            onClick={() => void compiler.refreshInspector().catch(() => {})}
          >
            Refresh
          </button>
        </aside>
      </div>
    </section>
  );
}
