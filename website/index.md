---
layout: home

hero:
  name: "PEAR"
  text: "Plans that survive contact with reality."
  tagline: Compile messy source material into a reviewable DAG, then execute, assess, and replan without losing durable state.
  actions:
    - theme: brand
      text: Create an app
      link: /guide/getting-started
    - theme: alt
      text: Install the Agent Skill
      link: /guide/agent-skill

features:
  - title: Sources become evidence
    details: Interpret text, URLs, and files into normalized Domain input with clarification and source provenance.
  - title: Plans stay inspectable
    details: Validate a typed DAG, review it before execution, and retain immutable artifact versions.
  - title: Execution stays durable
    details: D1-backed events and materialized state survive browser, voice, and Worker lifecycles.
  - title: Replans stay bounded
    details: Update only the affected subgraph while protecting completed, skipped, and active work.
---

<div class="pear-loop" aria-label="PEAR runtime loop">
  <div class="pear-loop__phase">
    <span class="pear-loop__label">01 / Plan</span>
    <strong>Compile intent</strong>
    <small>Sources → normalized input → validated DAG</small>
  </div>
  <div class="pear-loop__phase">
    <span class="pear-loop__label">02 / Execute</span>
    <strong>Advance work</strong>
    <small>Typed events drive one durable session</small>
  </div>
  <div class="pear-loop__phase">
    <span class="pear-loop__label">03 / Assess</span>
    <strong>Observe change</strong>
    <small>Facts, criteria, resources, and constraints</small>
  </div>
  <div class="pear-loop__phase">
    <span class="pear-loop__label">04 / Replan</span>
    <strong>Repair the path</strong>
    <small>Patch the affected subgraph, not the history</small>
  </div>
</div>

## Build the application, not a demo

PEAR Agent is a TypeScript runtime for execution-support products. Your application owns the Domain, UI, authentication, authorization, and provider choices. PEAR supplies the contracts and durable loop underneath them.

```bash
pnpm dlx create-pear-agent@beta my-agent
cd my-agent
pnpm install
cp .env.example .env
cp .dev.vars.example .dev.vars
pnpm dev
```

The Minimal Starter opens at four editable surfaces: **Plans → Sources → Review → Execute**. Start with the [getting-started guide](/guide/getting-started), or give your coding agent the [PEAR Agent Skill](/guide/agent-skill).
