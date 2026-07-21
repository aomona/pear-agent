# Use the Agent Skill

The repository ships a portable Agent Skill for coding agents that support the open `SKILL.md` format. It teaches the agent where PEAR ends, where the host application begins, and which invariant must survive each integration step.

## Install

```bash
npx skills add aomona/pear-agent --skill pear-agent
```

Choose the agents that should receive the skill, or install non-interactively for a supported agent:

```bash
npx skills add aomona/pear-agent --skill pear-agent -a codex -y
```

The installer copies/symlinks the skill into the selected agent's discovery directory. Commit a project-local installation only when your team wants the same workflow version in every checkout.

## Ask for a vertical slice

Good requests name the product Domain and a runnable outcome:

```text
Use the pear-agent skill. Create a PEAR app for field maintenance reports.
The first slice must accept a report and photo notes, compile a reviewable plan,
and start an execution session after human approval. Keep auth fail-closed.
```

For an existing application, state the boundary to preserve:

```text
Use the pear-agent skill. Integrate PEAR into this existing React + Cloudflare app.
Reuse our router, session auth, and design system. Do not replace our D1 schema
or expose provider credentials. Prove Sources → Review → Execute locally.
```

## What the skill enforces

- greenfield apps use `create-pear-agent` instead of copying the reference app;
- existing apps are inspected before packages or bindings are added;
- Domain, AI, Cloudflare, React, and verification guidance are loaded only as needed;
- HTTP Snapshots remain authoritative;
- Runtime mutation stays event-driven, atomic, and idempotent;
- authorization stays host-owned and fail-closed;
- voice and partial replan are added after the base flow works;
- completion requires a real smoke path, not compilation alone.

## Repository source

The distributable source lives at [`skills/pear-agent`](https://github.com/aomona/pear-agent/tree/dev/skills/pear-agent). Its reference files are self-contained so an installed skill does not depend on a local clone of this monorepo.
