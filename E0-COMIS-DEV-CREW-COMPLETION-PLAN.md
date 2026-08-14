# Comis + DevCrew E0 end-to-end completion plan

**Status:** Repository implementation complete; protected acceptance remains open (NO-ACCESS)

**Goal:** From a real Telegram conversation, supervise a confined coding task in a real repository through Comis and `comis-dev-crew`, recover safely from an exited worker, validate the exact candidate, deliver an unmerged pull request with current evidence, survive restarts, and clean up without terminal or SSH intervention.

## Definition of done

E0 is complete when all of the following are true on the dedicated Linux development host:

- A human starts and supervises the workflow through the real Telegram app and the configured Comis bot.
- The Comis liaison discovers only the explicitly enabled DevCrew prompt skill and MCP tools; a control agent cannot discover or call them.
- Two independently confined workers overlap in separate leased worktrees, with task, run, lease, attachment, branch, and report identity isolation.
- One worker decision is delivered to the preparation-time Telegram conversation and answered there without ambiguous binding.
- One lane is paused, edited directly, and handed back for fresh validation while its sibling continues.
- A worker that exits without a candidate report becomes `unknown`, never success, and can be reconciled through a server-authoritative, approval-gated action when a clean candidate is independently provable.
- The exact candidate head passes fixed local validation and current forge checks, then produces one pull request and one exactly-once Telegram delivery. E0 does not merge it.
- Restarting Comis, DevCrew, and the stateless MCP facade preserves durable identities and does not duplicate reports, validation, pull requests, or delivery.
- Cleanup refuses open decisions, active or unknown execution, dirty worktrees, stale forge truth, and open holds; after the conditions are resolved it releases authority and removes only the selected clean task roots.
- Comis and DevCrew are reproducible from publicly reachable source pins, their public documentation matches the shipped behavior, and all repository and protected live gates are green.

## Current posture

- The Comis capability-service platform, durable managed runs, workspace leases, execution attachments, report/evidence delivery, and Linux confinement mechanisms are implemented and validated on the current feature branch.
- DevCrew implements task preparation, Codex and Claude Code worker profiles, worktree isolation, candidate validation, pull-request delivery, pause/edit/handback, cleanup, CLI/MCP parity, restart-safe durable state, and server-authoritative clean-candidate reconciliation for eligible `unknown` tasks.
- The reconciliation action is available through the application layer, local API, CLI, and the eighth MCP tool. Durable diagnostics fail closed when validation, process, or cleanup evidence is absent or contradictory.
- The protected campaign is implemented as a manual-only, bounded Linux runner for two real ship lanes, a real human Telegram sender, isolated service restarts, current Git and forge truth, reconciliation, handback, cleanup refusals, and content-free closeout evidence.
- DevCrew's complete local `make verify` and `make verify-full` gates pass with the patched Go toolchain. Comis protocol verification and `pnpm validate:full` pass, including architecture, security, integration coverage, and tarball smoke checks.
- The protected `make test-live` campaign has not run. The available host is Darwin and has no campaign manifest, evidence root, or protected GitHub credential; it also cannot supply the required real human Telegram checkpoints or isolated Linux systemd services.
- Neither feature branch has been pushed or merged. Public protocol provenance, the protected campaign, Comis dogfood pull request, release-artifact rerun, and final evidence ledger remain dependent on explicit publication authority and protected operator infrastructure.

Repository implementation is complete, but E0 itself is not declared complete until every item in the definition of done is proven by a passing protected campaign. Missing external authority is recorded as NO-ACCESS, never as a skip or pass.

## Scope boundary

This plan completes E0 only.

In scope:

- Unknown-task diagnosis and safe clean-candidate reconciliation.
- CLI, local API, MCP, prompt-skill, and Telegram reachability for that recovery action.
- Real Telegram acceptance with a human sender.
- A dedicated DevCrew live target for the `comisai/comis` repository.
- Public protocol provenance, release reproducibility, operational rollback, and evidence-led closeout.

Deferred:

- Initiative graphs, dependency scheduling, and automatic integration branches.
- Merge-after-approval or any merge credential.
- Direct writable terminal custody, attaching to a Codex session, raw process controls, and operator-client transport.
- External-event ingress, unattended worker-settle inference, and application-specific behavior in the generic Comis runtime.

E0 ends at a green, unmerged pull request. Merge belongs to a separately approved later capability.

## Non-negotiable constraints

- Revoke the existing Telegram bot token and issue a new one before any live run. Store the replacement only through Comis secret management; never place it in Git, shell history, test fixtures, logs, plans, or task briefs.
- Keep the protected default Comis bot, service unit, data root, and conversations untouched. The live target gets separate systemd units, config, data, database, runtime, repository, worktree, log, and gateway roots.
- Comis remains the authority for identity, conversation origin, policy, approvals, confinement, continuation, and delivery. DevCrew remains the sole task/worktree/evidence writer.
- Do not hard-code DevCrew, Snake, Telegram-specific procedures, or repository behavior into the generic Comis runtime. Put deployment policy in the operator workspace and reusable task guidance in the opt-in `dev-crew` prompt skill.
- All recovery inputs are handles and closed actions. Caller-supplied paths, branches, heads, run IDs, lease IDs, attachment IDs, process IDs, commands, or environment values are never accepted as authority.
- Missing or contradictory evidence remains `unknown`. Terminal exit, a clean worktree, a commit, worker prose, and a pull-request URL are individually insufficient to claim delivery.
- Every production behavior change follows RED, GREEN, optional refactor, and a local commit. Documentation changes land with the behavior they describe. No `Co-Authored-By:` trailers are used.
- Pushing or opening a Comis pull request requires new explicit authorization. Existing authorization permits outward PR/release work only in `comis-dev-crew`.

## Execution order

### Secure and freeze the live baseline

Objective: make the next result attributable and prevent testing with a disclosed credential or mutable baseline.

Tasks:

1. Rotate the Telegram bot token, update the Comis secret reference, restart only the isolated live service, and prove bot identity plus channel health without printing the token.
2. Record the exact Comis commit, DevCrew commit, protocol ID/digest, installed binary hashes/versions, systemd unit definitions, worker CLI versions, repository base revision, and validation-profile catalog.
3. Capture the existing Snake task through normal DevCrew and Comis observability surfaces. Preserve its worktree, branch, commit, managed-run binding, report cursor, delivery state, and terminal-exit evidence. Do not mutate or clean it yet.
4. Confirm the protected default service and bot have unchanged unit definitions, process start times, data roots, and recent delivery counts.

Acceptance:

- The rotated bot answers a harmless health message in the intended real Telegram conversation.
- No secret value appears in tracked files, logs, session records, trajectories, reports, or command output retained as evidence.
- The Snake task remains preserved in `unknown` with no fabricated candidate, validation, delivery, or cleanup transition.
- The isolated live baseline is sufficient to reproduce every later command against exact commits.

### Implement the unknown-task recovery tracer

Objective: make the existing `reconcile_task` recommendation executable without weakening fail-closed semantics.

The canonical action is:

```text
reconcile_task(taskHandle, action="validate-clean-candidate")
```

The equivalent CLI is:

```text
devcrew task reconcile TASK --action validate-clean-candidate [--operation OPERATION] [--format json]
```

Implementation tasks in `comis-dev-crew`:

1. Add failing domain and application tests for an `unknown` task whose terminal is no longer active and whose exact registered worktree has a clean, non-base candidate head. Pin the required transition to `reconciling`, then to `validating`, without incrementing the worker report cursor or pretending that the worker emitted a candidate report.
2. Add negative RED cases for dirty or missing worktrees, unchanged base head, divergent or unexpected branch/head, active or ambiguous terminal authority, mismatched repository identity, stale/missing run or lease binding, symlink/path substitution, concurrent reconciliation, cancelled contexts, operation replay, and altered operation reuse.
3. Introduce a closed `ReconcileTaskCommand` and action enum in the application layer. The command accepts only operation ID, task handle, and `validate-clean-candidate`.
4. Build fresh reconciliation evidence inside the service from durable task/preparation authority, the registered canonical worktree identity, current Git head/status, terminal lifecycle evidence, and exact run/lease binding. Never synthesize a worker report.
5. Commit the task, reconciliation evidence, and stable operation result atomically. Exact replay returns the original outcome; altered reuse returns a non-retryable conflict.
6. Hand the exact clean head to the existing candidate supervisor. The supervisor must re-read the head before and after fixed checks, seal validation evidence, and preserve `unknown` or fail safely if the head changes.
7. Add `ReconcileTask` to the closed local API catalog and typed client, with `mutate` side-effect classification and the same owner-only caller policy as prepare, handback, and cleanup.
8. Add the CLI command and the eighth MCP tool, `reconcile_task`, with strict schemas and truthful non-read-only, idempotent, closed-world annotations. Route it through the normal Comis approval path and return no private run, lease, attachment, path, or executable metadata.
9. Update `task explain` so an `unknown` task distinguishes at least: terminal exited without candidate evidence, restart evidence unresolved, host integration unavailable, workspace not recoverable, and reconciliation already in progress. Suggested actions must be reachable and reason-specific.
10. Update the DevCrew prompt skill and isolated Comis workspace policy so the liaison knows when to inspect, reconcile, refuse, or prepare a replacement task. No core prompt or default workspace receives this guidance.
11. Update all catalog-count, adapter-parity, source-policy, documentation, and campaign assertions from seven to eight MCP tools.

Likely DevCrew touch points:

- `internal/domain/task_transition.go` and adjacent transition tests.
- A new application reconciliation coordinator beside `intervention.go`, with co-located tests.
- A SQLite mutation/store implementation with replay, concurrency, and restart tests.
- `internal/localapi`, `internal/cli`, and `internal/mcpadapter` catalogs, handlers, clients, renderers, and parity tests.
- `internal/service` composition and candidate-supervisor wiring.
- `docs/running.md`, `docs/implementation-status.md`, README, command help, and live-test contracts.

Acceptance:

- An eligible clean candidate advances from `unknown` through durable reconciliation into normal validation from CLI and MCP with identical state/version/result semantics.
- Ineligible evidence returns a safe reason and exact operator hint while leaving the task and worktree unchanged.
- A timeout or disconnect can be reconciled by the same operation ID without duplicating validation or delivery.
- The action cannot target another task, choose a filesystem object, swap a branch/head, or bypass approval.
- The original Snake candidate either enters normal validation through this action or receives an honest, evidence-backed refusal. If refused, its work remains preserved and a fresh Snake task is used to finish the live delivery tracer.

### Publish reproducible Comis protocol authority

Objective: make the protocol source recorded by DevCrew reachable and reproducible from a clean checkout.

Tasks:

1. Re-run the Comis protocol check and full validation on the clean capability-platform branch after reviewing the complete diff against `origin/main` for generic-runtime, security, docs, and generated-artifact boundaries.
2. With explicit user authorization, push the Comis feature branch, open its pull request, complete review and CI, and merge it without rewriting the reviewed history.
3. From a fresh checkout of the public merge commit, regenerate the capability-service bundle twice and prove byte identity, artifact count, protocol ID, and digest.
4. In DevCrew, run `make protocol-sync COMIS_ROOT=<fresh-comis-checkout> COMIS_COMMIT=<public-merge-commit>`, review the generated diff, and run `make protocol-check` plus conformance/integration tests.
5. Ensure `protocol/comis/provenance.json` points to the public merge commit and that no protocol artifact references a local-only branch or filesystem path.
6. Publish the next DevCrew prerelease only after the recovery action and the final live campaign pass. Install that release into a fresh prefix and verify archive checksums and all four binaries.

Acceptance:

- A clean machine can clone both repositories, check out the recorded commits, reproduce the protocol digest, build all binaries, and complete the real socket handshake.
- Comis and DevCrew reject altered protocol IDs, digests, credentials, and generated artifacts.
- Public README, installation, implementation-status, and release notes state the actual release posture and exact supported E0 boundary.

### Convert the campaign to real Telegram

Objective: prove phone-only supervision over the real channel rather than the loopback emulator.

Tasks:

1. Add a protected real-Telegram target beside the existing emulator target. Reuse its identity, confinement, restart, origin, forge, validation, and cleanup oracles; change only the channel boundary and user checkpoints.
2. Replace the placeholder DevCrew live test with a bounded black-box campaign runner that fails when required Comis, Telegram-thread, GitHub-repository, worker-profile, service, or credential prerequisites are missing. It must never silently skip a promised protected row.
3. Require a real human Telegram sender for inbound steps. Do not use the bot credential to impersonate a user. The runner may observe state and outbound delivery, but the user supplies task requests, decision replies, pause/reconcile approvals, and cleanup confirmations in the Telegram app.
4. Drive two independent ship tasks from one origin conversation, with Codex and Claude Code profiles, and prove a real overlap interval from task state plus terminal evidence.
5. Open a newer unrelated Telegram conversation before decision, recovery, pull-request, and cleanup delivery. Verify every task event returns only to the preparation-time origin.
6. Stop and replace `devcrew-mcp`, restart DevCrew, and restart Comis at separate durable boundaries. After each restart, reconcile by stable task/operation/run references and prove no duplicate effects.
7. Exercise the Snake unknown-task action through the liaison. The tool call must pass the normal approval flow and return a content-free result before validation/delivery continues.
8. Exercise pause, direct worktree edit, and `handback_task` on one lane while the sibling continues reporting.
9. Hold a forge check, then release it; verify delivery waits for the exact current head and green required checks.
10. Exercise cleanup refusal for an open decision/hold and for a dirty worktree, then resolve both and complete cleanup.

Acceptance:

- All user-facing actions can be completed through real Telegram after initial deployment; no SSH or terminal is needed for supervision.
- The normal surfaces `list_tasks`, `get_task`, `explain_task`, `reconcile_task`, Comis managed-run explanation, and system health are enough to diagnose every injected failure.
- Telegram delivery, Comis trajectory/delivery mirror, DevCrew outboxes/evidence, Git head, and GitHub pull-request/check truth agree on exact identities and counts.
- The protected default bot and service remain unchanged.

### Add a dedicated Comis repository dogfood target

Objective: prove that DevCrew can safely ship a real Comis change, not only a disposable fixture change.

Use a separate DevCrew service instance for the Comis target. Do not add speculative multi-repository scheduling to one E0 instance.

Tasks:

1. Create a canonical service-owned checkout of `comisai/comis`, a dedicated worktree root, and an opaque repository ID. Pin the primary Git common-directory filesystem identity and protected base branch.
2. Configure a repository-scoped push credential and separate forge-read credential with no merge authority. Confirm branch protection prevents worker merge and force push.
3. Add reviewed fixed validation programs for:
   - protocol generation drift: `pnpm capability-protocol:check`;
   - affected-package build, lint, and focused tests;
   - architecture and security tests for touched boundaries;
   - final repository gate: `pnpm validate`.
4. Configure exact Codex and Claude Code worker profiles, terminal allow entries, resource limits, and Comis execution-attachment bindings for the service-owned root.
5. Install the `dev-crew` prompt skill only for the liaison and allow only the Comis-target DevCrew MCP server. Keep the control agent as the negative control.
6. Select a small real Comis issue whose behavior is domain-neutral. Require test-first commits, current documentation, and no changes outside the task's declared files without a reasoned deviation.
7. From Telegram, prepare, supervise, reconcile if needed, validate, and deliver a pull request to `comisai/comis`. Do not merge it.

Acceptance:

- The worktree is not the primary checkout, remains inside the approved root, and cannot read or write sibling worktrees.
- The worker has no Telegram, Comis control, broad GitHub, merge, or unrelated repository credential.
- The pull request head equals the sealed candidate head, targets the protected base, has current green required checks, and is delivered once to the origin conversation.
- The normal Comis and DevCrew observability surfaces explain the run without direct database reads or a raw-log hand join.

### Close observability and operator-recovery gaps

Objective: make the next occurrence diagnosable in one or two commands.

Tasks:

1. Populate only fields supported by E0 authority: current candidate head, last authenticated report activity, decision/block posture, validation judgment, delivery state, and cleanup holds. Keep process/custody fields explicitly `unknown` where E2 process evidence is unavailable.
2. Add closed reason codes and exact hints for recovery refusal, including the config key or authority mismatch the operator must fix.
3. Include stable task, operation, managed-run, report, validation, forge, delivery, and cleanup references in content-free diagnostic projections so Comis and DevCrew views can be reconciled without exposing content or secrets.
4. Emit an INFO completion record with duration for reconciliation and each boundary crossed; emit WARN/ERROR with a closed error kind and actionable hint; emit matching typed lifecycle/health/audit events.
5. Add an operator closeout command/script that gathers `devcrew service status`, fleet, task explanation, operation status, Comis managed-run explanation, system health, Git/forge truth, and secret-residency results into one bounded evidence directory.

Acceptance:

- `devcrew task explain TASK` identifies why an unknown task is recoverable or why it must remain unknown.
- A failed reconciliation can be diagnosed without SQLite, debugger attachment, or unrestricted log grep.
- No diagnostic field fabricates zero, idle, clean, or success when its source is absent.

### Finish release and operations hardening

Objective: make the accepted configuration reinstallable, recoverable, and supportable.

Tasks:

1. Install Comis and DevCrew from the exact release artifacts into fresh isolated prefixes; validate systemd hardening, permissions, working directories, restart policies, and dependency ordering.
2. Prove backup and restore of Comis data, DevCrew SQLite state, configuration, secret references, and repository registry without copying plaintext credentials into the backup artifact.
3. Prove rollback to the previous known-good installed binaries against a copied synthetic data root. Never use live user data as the rollback fixture.
4. Exercise fresh-first-run failures, relative/broad root rejection, busy socket/port, wrong executable version, missing credential, wrong protocol pin, and unavailable host integration.
5. Run at least one hour of resource observation and compare RSS, file descriptors, database sizes, terminals/jails, worktrees, and delivery queues from start to finish.
6. Complete the remaining protected negative and upgrade rows, with every row recorded as pass, honest refusal, unavailable prerequisite, or product failure. Product failures block closeout.
7. Update public docs, operator instructions, CLI examples, configuration references, release notes, and implementation status from the verified final behavior.

Acceptance:

- Fresh install, restart, backup/restore, and rollback are reproducible from documented commands.
- Resource counts return to the expected baseline after cleanup, with no orphan worker, jail, socket, lease, worktree, or delivery record.
- Secret scanning is green across both repositories and retained evidence.

## Dependency map

| Work | Depends on | Can proceed before Comis publication |
| --- | --- | --- |
| Credential rotation and baseline capture | Nothing | Yes |
| Unknown-task recovery implementation | Baseline evidence | Yes |
| CLI/MCP/prompt-skill recovery reachability | Recovery application contract | Yes |
| Real Telegram development campaign | Rotated token, recovery reachability, isolated deployment | Yes, using exact local commits |
| Comis repository dogfood | Real Telegram baseline, Comis-target repository/validation config | Yes, using exact local commits |
| Public protocol re-pin | Public Comis merge commit | No |
| DevCrew prerelease | Recovery code, public protocol re-pin, full verification, final live rerun | No |
| E0 closeout | Release-artifact rerun, dogfood PR, cleanups, evidence audit | No |

## Threat model for reconciliation and live operation

| Threat | Required mitigation and proof |
| --- | --- |
| Reconcile another task | Owner-scoped MCP exposure, valid task handle, durable task lookup, exact operation subject digest, and cross-task negative tests. |
| Substitute a path, worktree, branch, or head | No caller path/head fields; server resolves the registered root and re-proves canonical path, Git common-directory identity, branch, base, and head before and after validation. |
| Infer success from worker exit or a commit | Exit selects `unknown`; reconciliation only starts validation; current local and forge evidence alone can reach delivery. |
| Replay or alter a recovery request | Stable operation ID with exact replay and non-retryable conflict on altered subject. |
| Reconcile while execution may still be active | Require authoritative terminal non-running evidence; missing or stale execution evidence preserves `unknown`. |
| Use a stale run, lease, or attachment | Cross-bind durable task, preparation, managed run, workspace lease, execution attachment, brief hash, and repository identity. |
| Change the candidate during validation | Seal and compare head/status before and after each validation and forge boundary; head drift invalidates evidence. |
| Bypass approval through tool metadata | MCP annotations classify reconciliation as non-read-only and idempotent without understating its side effect; Comis applies the configured mutation approval policy and the result contains no private authority metadata. |
| Leak channel, forge, worker, or control credentials | Separate secret references and identities; no values in argv, logs, reports, prompts, evidence, or tracked files; scan all retained artifacts. |
| Clean before delivery truth is settled | Cleanup requires exact delivered/terminal/lease/forge posture and no holds, dirt, unresolved decisions, or unknown observations. |
| Deliver to the wrong Telegram chat | Persist preparation-time conversation authority; newer chats do not change task origin; verify through wire, trajectory, delivery mirror, and recipient identity. |

High-severity open threats block implementation handoff and live execution. There is no override for ambiguous authority, false-success risk, credential exposure, or destructive cleanup uncertainty.

## Verification contract

Run the narrow RED/GREEN tests for each concern, then the repository gates below.

DevCrew:

```text
make verify
make verify-full
make test-live
```

Comis:

```text
pnpm capability-protocol:check
pnpm validate
```

Cross-repository protocol:

```text
make protocol-sync COMIS_ROOT=<fresh-comis-checkout> COMIS_COMMIT=<public-merge-commit>
make protocol-check
```

Required evidence:

- Unit tests for lifecycle, replay, strict decoding, path/Git identity, and safe failures.
- Real SQLite, Git, Unix-socket, restart, CLI/MCP parity, and installed-process integration tests.
- Linux confinement and sibling read/write refusal.
- Current local-validation and forge-check evidence for the exact candidate head.
- Real Telegram inbound/outbound, exact-origin decision/delivery, and restart evidence.
- One fixture-repository campaign and one `comisai/comis` pull-request campaign.
- Secret-residency scan, resource/decay observation, backup/restore, and rollback evidence.
- Clean `git status --short` in both repositories and a reviewable RED/GREEN commit sequence.

## Stop conditions

Stop and preserve state if any of these occurs:

- The replacement Telegram credential cannot be installed without exposing it.
- The task, worktree, run, lease, attachment, branch, or head identity cannot be proved exactly.
- A worker or caller can choose a path, executable, credential, environment binding, or merge action.
- Validation or forge evidence belongs to a stale or different head.
- A restart duplicates a task, report, validation, pull request, or delivery.
- Cleanup cannot prove the exact selected worktree and released authority.
- The protected default service or bot changes.
- A Comis push or pull request is required before the user grants explicit authorization.

## Closeout artifact

Produce one final evidence ledger containing:

- exact source/release identities and protocol digest;
- every acceptance and negative row with its oracle and result;
- Telegram origin/delivery identity without message bodies or credentials;
- task/run/lease/attachment/report/operation/evidence references;
- validation, Git, pull-request, and check identities;
- restart, replay, cleanup, resource, backup/restore, and rollback results;
- all commands used and their exit status;
- remaining honest limitations, especially network egress and deferred E1/E2 capabilities.

E0 may be declared complete only with zero false successes, zero unresolved product failures, no exposed credentials, no orphan authority, and no merge performed.
