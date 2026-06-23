---
name: autonomy
type: prompt
version: "0.1.0"
description: Use when a task is multi-step — research/read fan-out, spawning sub-agents, a DAG, scheduling your own work, or messaging your channel — to route it through the orchestration surface instead of one tool call at a time.
---

# Autonomy (stub)

Full body lands in Task 2. This stub names the real surface so the no-drift gate is structurally green:
caps `orch:read` + `orch:web`; in-script `comis_tools.read` + `comis_tools.web_search`; model-facing
tools `orchestrate`, `sessions_spawn`, `pipeline`, `cron`, `message`.
