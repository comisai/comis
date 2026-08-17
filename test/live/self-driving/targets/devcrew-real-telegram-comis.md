# TARGET — real-Telegram Comis development through DevCrew

> **Unsupported by the automated emulator campaign.** This manual target is
> documentary only when a campaign requires the local Telegram emulator,
> no human intervention, or no Comis pull-request creation or update. Those
> predicates must be reported as `NO-ACCESS`; this target authorizes no exception.
>
> Protected E0 dogfood campaign for the Comis capability-service platform and
> `comis-dev-crew`. A real human supervises two independent changes to
> `comisai/comis` through the real Telegram app. The campaign may create two
> unmerged pull requests; it may not merge, publish, release, deploy, or touch the
> protected default Comis installation.

## Relationship to the emulator target

The requirements, identity joins, confinement probes, validation oracles, restart
semantics, cleanup refusals, and failure classifications in
`devcrew-fullstack-developer.md` remain mandatory. This target changes two
boundaries only:

- Telegram is the configured real bot and a real human sender, never the loopback
  emulator and never a bot-token impersonation of a user.
- The registered repository is a service-owned canonical checkout of
  `comisai/comis`, not the disposable issue-board fixture.

The companion repository's protected `make test-live` runner is the executable
closeout authority. This document tells the operator and human when to provide its
closed checkpoints; a prose result is not a pass.

## Fixed isolated deployment

- Run on the dedicated Linux development host under a dedicated service owner.
- Use separate Comis and DevCrew service units, data/config/database/runtime/log
  roots, gateway port, repository checkout, worktree root, and Telegram bot from
  the protected default installation. Record the protected service's unit,
  process start time, data root, and delivery count before and after.
- Rotate the campaign Telegram bot token before the run. Store the replacement
  through Comis secret management only. Do not place it in the DevCrew manifest,
  environment files retained as evidence, shell history, task briefs, logs, or
  repository files.
- Install the `dev-crew` prompt skill and eight-tool DevCrew MCP server only for
  the liaison. A control agent must discover neither the skill nor any DevCrew
  tool. The skill is not bundled with the daemon: copy it from the companion
  release's `skills/dev-crew/` into the liaison workspace, and confirm no other
  agent's workspace received it.
- Give DevCrew separate repository-scoped forge-read and branch-push identities.
  Install no merge credential. Required branch protection remains enabled.
- Configure exact reviewed Codex and Claude Code profiles, terminal allow entries,
  reporter attachments, resource limits, and kernel-enforced sibling-worktree
  refusal. Do not fall back between worker profiles.

## Repository and validation contract

Register one opaque repository ID whose canonical primary checkout and Git common
directory resolve to the service-owned `comisai/comis` clone. The worktree root
must be a distinct approved directory; neither worker may run in the primary
checkout or read its sibling's worktree or reporter attachment.

Select two small, independent, domain-neutral Comis issues that can land as
separate pull requests. Each task contract names its owned files and adjacent
tests, requires RED before GREEN, requires current documentation when behavior or
operator contracts change, and forbids unrelated edits without a reasoned
deviation. The two tasks share only the pinned base revision.

Validation programs are fixed operator configuration, never worker-selected shell
fragments. Each candidate runs the checks appropriate to its touched boundary and
the final repository gate:

```text
pnpm capability-protocol:check
pnpm build
pnpm lint:security
pnpm test:architecture
pnpm validate
```

Focused tests run before the broad gate. A candidate head change before, during,
or after validation invalidates the evidence. Delivery waits for current green
required GitHub checks on the exact sealed head.

## Protected manifest handoff

Prepare both tasks from the original Telegram conversation and stop before worker
launch. The operator then copies the manifest example shipped by the checked-out
DevCrew companion repository to an owner-private location and fills it with the
resulting task handles, managed-run references, original/newer chat IDs, human
sender ID, origin explain reference, fixed operation IDs, isolated unit names,
exact executable/data paths, and required check names. This is deployment wiring,
not task supervision. After the protected workflow starts, all supervision is
through Telegram.

Predeclare and use the manifest's stable operation IDs for the one reconciliation,
one handback, and two cleanup calls. Operation identity is not authority: the
service still derives task, run, lease, repository, worktree, branch, head, terminal,
and attachment bindings.

The manifest contains eleven unique opaque `e0cp-*` markers. They are correlation
challenges, not secrets and not instructions to the bot. A marker passes only when
the offline `comis messages` surface finds it once, from the configured real human,
inside the campaign time window and expected conversation.

## Phone-only drive

1. In the original Telegram conversation, send the two issue requests and the
   `task_request` marker. Require the liaison to show the bounded contracts and
   prepare both tasks, then wait for the protected runner to start.
2. Ask the liaison to launch the Codex lane, then the Claude Code lane. The runner
   must observe both exact task handles simultaneously in durable `working` state.
   Issuing two requests concurrently without an observed overlap is a failure.
3. The runner replaces only the isolated `devcrew-mcp` unit. Ask the liaison to
   list both tasks through the new facade, then send `mcp_restarted_ack` in the
   origin conversation.
4. Open the configured newer unrelated Telegram conversation and send only its
   `unrelated_conversation` marker. It receives no task authority.
5. Answer one keyed worker decision in the original conversation and include the
   `decision_reply` marker. A bare or wrong-conversation answer must refuse.
6. Pause the non-recovery lane, edit only that lane through the approved developer
   intervention path, and call `handback_task` with the predeclared operation ID.
   Send `pause_handback` after fresh validation owns the changed head. The sibling
   must continue reporting throughout.
7. Exit the recovery lane after it has one clean non-base commit but before it emits
   a candidate report. Confirm `explain_task` reports settled terminal without
   candidate evidence, approve `reconcile_task` through the normal Comis approval
   path using its predeclared operation ID, and send `reconcile_approval`. The
   report cursor must not be incremented by a synthetic candidate report.
8. Hold one required forge check. After both exact candidate heads finish local
   validation, send `devcrew_restart_ready`. The runner restarts only the isolated
   DevCrew unit, re-proves durable task identity and health, and accepts
   `devcrew_restarted_ack` only after that restart.
9. Send `comis_restart_ready`. The runner restarts only the isolated Comis unit.
   After the real bot receives a new origin-conversation message and the liaison
   can explain both runs, send `comis_restarted_ack`.
10. Release the held check. Require exactly two open, unmerged pull requests whose
    heads, bases, branches, checks, DevCrew delivery evidence, and origin Telegram
    notices agree. No notice may appear in the newer conversation.
11. Exercise cleanup refusal first with an open hold or decision and then with a
    dirty worktree. Resolve both through Telegram, use the two predeclared cleanup
    operations, and send `cleanup_confirmation`. The runner waits until both tasks
    are durably `cleaned` before collecting evidence.

## Hard oracles

| id | required ground truth |
|---|---|
| REAL-1 | `comis messages --channel telegram` finds every checkpoint once from the configured human sender; no bot-authored input satisfies a row. |
| ORIGIN-1 | Decision, recovery, restart, PR, and cleanup delivery remain bound to the preparation-time conversation after the newer chat becomes active. |
| ISO-1 | Two distinct task/run/lease/attachment/branch/worktree identities overlap, and each kernel jail refuses its sibling root and attachment. |
| REC-1 | The exited clean worker becomes `unknown`; `explain_task` names the recoverable reason; approved `reconcile_task` preserves report cursor and remains visible as the judged candidate's origin. |
| INT-1 | The other lane records a completed `HandbackTask` operation and validates the developer-owned head while its sibling remains active. |
| RESTART-1 | MCP replacement and separate DevCrew/Comis restarts preserve identities and create no duplicate report, evidence, PR, or Telegram delivery. |
| FORGE-1 | Exactly two current open, unmerged `comisai/comis` pull requests match sealed heads, protected base, unique task branches, and one successful result for every required check. |
| CLEAN-1 | Open-decision/hold and dirty-worktree cleanup attempts refuse without release; final cleanup removes only selected roots and releases their host authority. |
| OBS-1 | `devcrew service status`, fleet, task show/explain, operation status, `comis explain`, and `comis system-health` reconcile without SQLite or raw-log joins. |
| SAFE-1 | `comis secrets audit --check --json` is empty and the count-only residency oracle finds zero plaintext instances with zero read errors. |
| CTRL-1 | The control agent cannot discover the skill or eight tools before, during, or after restarts. |

## Stop conditions and closeout

Stop immediately on a protected-default mutation, wrong-origin delivery, sibling
access, missing confinement, profile fallback, secret residency, stale/mismatched
head, merge, duplicate side effect, unreconstructable failure, or any cleanup that
widens its target. Preserve evidence and worktrees; do not repair by relaxing an
allowlist or inventing success.

The companion `make test-live` command must finish with a passing verdict in its
owner-private evidence directory. It retains only bounded task/operation/Comis/
Git/forge/secret summaries and hashes; raw Telegram bodies and command stderr are
not retained. `make verify-full` in DevCrew and `pnpm validate` in Comis must also
pass on the recorded commits. A missing real human, rotated token, isolated Linux
host, GitHub credential, service permission, public source pin, or required check
is `NO-ACCESS`, not a skipped or inferred pass.
