---
name: dev-crew
version: 1.0.0
description: "Supervise durable isolated software-development tasks through the explicitly enabled comis-dev-crew MCP service. Use when a user asks the current Comis agent to prepare, inspect, recover, hand back, validate, deliver, or clean up a DevCrew coding task. Do not use for ordinary coding requests when the DevCrew capability is not enabled."
comis:
  requires:
    bins: []
    env: []
---

# Dev Crew

Use the DevCrew MCP tools as the only task-control surface. Never construct a
`devcrew` command, open its SQLite database, invent a filesystem path, or infer
task state from worker prose or terminal output. This skill recommends procedures;
it grants no capability and never bypasses Comis policy or approval.

## Inspect before mutating

1. Call `list_tasks` to discover durable task handles.
2. Call `get_task` for the selected handle.
3. Call `explain_task` whenever the state is blocked, failed, reconciling, or
   unknown. Follow only a suggested action that is present in the live tool set.
4. Use `get_launch_plan` only for a task whose durable posture says it is ready
   for launch. Treat returned run and lease references as opaque.

Keep task, operation, managed-run, lease, attachment, branch, and report
identities separate. Never copy authority from one task to another.

## Prepare work

Call `prepare_task` with one strict task contract:

- `shape`: `ship` for a pull request or `scout` for a bounded report.
- `repositoryId`, `validationProfile`, and `workerProfileId`: select only
  operator-configured catalog identities.
- `baseRevision`: use the exact pinned 40-character Git commit.
- `acceptanceCriteria` and `constraints`: send JSON arrays of bounded strings.
- `deliveryMode`: `pull_request` for `ship`, `report` for `scout`.

Do not provide a path, command, executable, credential, run, lease, attachment,
branch, or service identity. If required catalog or base authority is unavailable,
refuse or ask the user for that missing choice instead of guessing.

## Supervise and recover

A terminal or coding CLI exit is not candidate evidence and never means success.

For an `unknown` task, call `explain_task` and branch on its reason:

- `terminal_exited_without_candidate_evidence`: after the normal approval, call
  `reconcile_task` with only `taskHandle` and
  `action: "validate-clean-candidate"`.
- `reconciliation_in_progress`: inspect the task; do not start a second recovery.
- `host_integration_unavailable`: report the host-control blocker and inspect
  service health. Do not retry a mutation blindly.
- `restart_evidence_unresolved`: inspect the task and service health. Do not
  infer a settled terminal or candidate.
- `workspace_not_recoverable`: do not reconcile. Explain that the existing task
  remains preserved; prepare a replacement only after the user approves a new
  bounded task contract.

Never add a worktree path, repository, branch, head, run, lease, terminal, or
attachment field to `reconcile_task`. DevCrew derives and re-proves that authority
server-side. A refused recovery must leave the task and worktree unchanged.

Use `handback_task` only after a developer intentionally changed a safely paused
task worktree. Call it with `action: "validate-developer-work"`. Handback is not a
substitute for recovering an exited worker that emitted no candidate report.

## Delivery and cleanup

Treat `validating`, `candidate_complete`, and `delivering` as in-progress
states. Delivery is complete only when DevCrew reports a durable `delivered`
state backed by current validation and forge or report evidence.

Call `cleanup_task` only for the exact delivered task and only after the normal
approval. Cleanup can refuse an open decision or hold, active or unknown
execution, dirty worktree, stale delivery truth, or ambiguous authority. Preserve
the task, explain the reason from `explain_task`, resolve only the named
condition, then retry the same task. Never request merge, force-push, deployment,
raw terminal custody, or sibling-worktree access; those actions are outside the
DevCrew E0 boundary.

