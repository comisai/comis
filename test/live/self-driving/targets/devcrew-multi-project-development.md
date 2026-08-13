# TARGET — concurrent multi-project development through Comis and DevCrew

> A comprehensive live acceptance campaign for the Comis ↔ comis-dev-crew integration. Run it on
> the dedicated Linux development box reached through the `comis-dev` SSH alias. The operator drives
> only Comis through the loopback Telegram emulator; the Comis liaison plans the portfolio and calls
> the explicitly installed DevCrew MCP facade. DevCrew prepares isolated worktrees, launches reviewed
> coding-worker profiles, collects task-scoped evidence, validates candidates, and verifies delivery.
>
> The campaign uses one disposable private fixture repository and may create branches and pull
> requests only there. It never merges, releases, publishes, deploys, calls the real Telegram API, or
> mutates an operator repository.

## Purpose and architecture truth

This target extends [`devcrew-fullstack-developer.md`](devcrew-fullstack-developer.md). The compact
target proves one backend lane, one frontend lane, and one scout. This campaign tests a sustained
software-development portfolio: four projects, eight bounded coding tasks, two reviewed worker
families, dependency-aware waves, intervention, restarts, partial failure, cross-candidate
integration, verified pull-request handoff, and safe cleanup.

The current companion is an E0 service. One installed DevCrew service instance configures one
repository, and E0 does not provide a cross-repository dependency scheduler, automatic integration
branches, or merge authority. Therefore the fixture is a single disposable monorepo containing four
independently testable projects. The Comis liaison owns the portfolio plan, decides when a ready task
may launch, and keeps the concurrency ceiling. Dependencies in the manifest are campaign launch and
oracle gates; every task remains independently applicable to the pinned base and may not consume an
unmerged sibling candidate. A request that genuinely requires an unmerged candidate must fail
honestly as an unavailable E1 workflow.

The scenario tests the product boundary rather than working around it:

- Comis owns the user conversation, agent and capability policy, exact-origin continuation,
  approvals, managed runs, workspace leases, execution attachments, terminal confinement,
  operator-visible health, and delivery mirror.
- `comis-dev-crew` owns the development task contracts, Git worktrees and branches, reviewed Codex
  and Claude Code adapters, worker reports and decisions, candidate validation, forge truth, durable
  delivery evidence, handback, and cleanup.
- The liaison uses `prepare_task`, `get_launch_plan`, `list_tasks`, `get_task`, `explain_task`,
  `handback_task`, and `cleanup_task`. It never constructs a DevCrew command line, opens the DevCrew
  database, invents task state from worker prose, or treats terminal exit as success.

## Fixed rig and authority boundary

- Host: `comis-dev`, running the deployed build under test as the dedicated service user.
- Channel: loopback Telegram emulator with an explicitly configured admin sender; no real Telegram
  network call.
- Isolation: a fresh campaign data root, config, gateway port, service unit, DevCrew database,
  service/MCP sockets, private runtime root, fixture checkout, worktree parent, and artifact root.
  A before/after guard proves the pre-existing Comis service, data root, repositories, and companion
  state are unchanged.
- Provenance: all four DevCrew binaries come from one committed companion revision. The Comis and
  companion protocol ID, artifact catalog, bundle digest, and source revision agree before any task
  is prepared.
- Capability exposure: one linked DevCrew capability-service instance, one replaceable
  `devcrew-mcp` process, and the `dev-crew` prompt skill are available only to the liaison. A control
  agent has none of them.
- Workers: exact installed Codex and Claude Code versions, authentication postures, fixed launch
  descriptors, terminal allow entries, and concurrency limits are probed before use. There is no
  provider/profile fallback.
- Forge: one disposable private GitHub fixture repository. Read and push use distinct scoped
  credentials. Branch protection prevents merge, and no merge credential is installed.
- Validation: fixed service-owned executables and argument templates only. Worker output cannot
  choose the program, shell fragment, forge identity, or required check set.
- Confinement: each task receives one distinct leased Git worktree and one protected reporter
  attachment. Sibling-root denial must be kernel-enforced. Network posture is reported at the level
  the host actually enforces; unsupported egress allowlisting is a declared limitation.

Before the live drive, build and test Comis and the companion at their recorded revisions, deploy
Comis through the real installer, build the four companion binaries, start both services under
systemd, and prove a byte-exact emulator `PONG42` baseline through wire, session, trajectory, and
delivery mirror. Run the deterministic DevCrew mechanics journey ten times with retries disabled;
the real-worker portfolio does not start unless all ten runs pass.

## Fixture monorepo

The repository starts from a pinned commit with neutral seed data, deterministic local tests, and
intentional implementation gaps. It contains:

| project | path | contract under test |
|---|---|---|
| API service | `apps/api` | HTTP issue API, typed errors, optimistic revisions, idempotent create, bulk status changes, health |
| Web client | `apps/web` | issue board, status filter, bulk editor, cache refresh, loading/error states, keyboard access |
| TypeScript client | `libs/client` | generated request/response types, stable public client surface, contract fixtures, package tests |
| Event worker | `services/events` | durable notification jobs, bounded retry/backoff, deduplication, dependency update, shutdown recovery |

The base repository supplies all build scripts and local dependencies; no task may install a new
system tool or add an unapproved package. Every work item has a non-overlapping intended code seam,
adjacent tests, acceptance criteria, and one fixed validation profile. The repository-level harness
can assemble candidate diffs into an ephemeral scratch checkout in manifest order, but it never
writes a task worktree, candidate branch, primary checkout, or remote branch.

## Campaign manifest

This manifest is the frozen workload. Copy it into the run's `TEST-PLAN.md` and record any skipped
row explicitly; do not silently replace a task because a worker or provider is unavailable.

<!-- devcrew-campaign-manifest:start -->
```json
{
  "schemaVersion": 1,
  "systemUnderTest": "comis+comis-dev-crew",
  "rig": "comis-dev",
  "repositoryModel": "single-disposable-monorepo",
  "maxConcurrentWorkers": 4,
  "projects": [
    { "id": "api", "role": "backend", "root": "apps/api" },
    { "id": "web", "role": "frontend", "root": "apps/web" },
    { "id": "client", "role": "shared", "root": "libs/client" },
    { "id": "events", "role": "worker", "root": "services/events" }
  ],
  "workItems": [
    {
      "id": "CLIENT-TEST-BASELINE",
      "project": "client",
      "kind": "test_backfill",
      "wave": 0,
      "profile": "codex-reviewed",
      "dependsOn": [],
      "allowedPaths": ["libs/client/spec/contract-baseline.spec.ts"],
      "validationProfile": "client-tests"
    },
    {
      "id": "API-IDEMPOTENCY-BUG",
      "project": "api",
      "kind": "bug_fix",
      "wave": 1,
      "profile": "codex-reviewed",
      "dependsOn": ["CLIENT-TEST-BASELINE"],
      "allowedPaths": ["apps/api/src/idempotency.ts", "apps/api/spec/idempotency.spec.ts"],
      "validationProfile": "api-tests"
    },
    {
      "id": "WEB-STALE-CACHE-BUG",
      "project": "web",
      "kind": "bug_fix",
      "wave": 1,
      "profile": "claude-reviewed",
      "dependsOn": ["CLIENT-TEST-BASELINE"],
      "allowedPaths": ["apps/web/src/issue-cache.ts", "apps/web/spec/issue-cache.spec.ts"],
      "validationProfile": "web-tests"
    },
    {
      "id": "CLIENT-ERROR-REFACTOR",
      "project": "client",
      "kind": "refactor",
      "wave": 1,
      "profile": "codex-reviewed",
      "dependsOn": ["CLIENT-TEST-BASELINE"],
      "allowedPaths": ["libs/client/src/errors.ts", "libs/client/spec/errors.spec.ts"],
      "validationProfile": "client-tests"
    },
    {
      "id": "EVENTS-RETRY-BUG",
      "project": "events",
      "kind": "bug_fix",
      "wave": 1,
      "profile": "claude-reviewed",
      "dependsOn": ["CLIENT-TEST-BASELINE"],
      "allowedPaths": ["services/events/src/retry.ts", "services/events/spec/retry.spec.ts"],
      "validationProfile": "events-tests"
    },
    {
      "id": "API-BULK-STATUS-FEATURE",
      "project": "api",
      "kind": "feature",
      "wave": 2,
      "profile": "codex-reviewed",
      "dependsOn": ["API-IDEMPOTENCY-BUG"],
      "allowedPaths": ["apps/api/src/bulk-status.ts", "apps/api/spec/bulk-status.spec.ts"],
      "validationProfile": "api-tests"
    },
    {
      "id": "WEB-BULK-EDITOR-FEATURE",
      "project": "web",
      "kind": "feature",
      "wave": 2,
      "profile": "claude-reviewed",
      "dependsOn": ["WEB-STALE-CACHE-BUG"],
      "allowedPaths": ["apps/web/src/bulk-editor.ts", "apps/web/spec/bulk-editor.spec.ts"],
      "validationProfile": "web-tests"
    },
    {
      "id": "EVENTS-DEPENDENCY-UPDATE",
      "project": "events",
      "kind": "dependency_update",
      "wave": 2,
      "profile": "codex-reviewed",
      "dependsOn": ["EVENTS-RETRY-BUG"],
      "allowedPaths": ["services/events/package.json", "pnpm-lock.yaml"],
      "validationProfile": "events-tests"
    }
  ],
  "requiredFaults": [
    "concurrency_ceiling",
    "worker_exit_without_report",
    "required_validation_red",
    "restart_with_pending_outbox",
    "stale_forge_head",
    "dirty_cleanup_refusal"
  ]
}
```
<!-- devcrew-campaign-manifest:end -->

The dependency edges order launch and evidence comparison only. They do not authorize a task to
read another task's worktree or consume its unmerged commit. The allowed paths are an oracle, not a
new filesystem capability: after each candidate report, compare the actual diff with the declared
paths and reject unrelated changes before local validation.

## Work-item acceptance criteria

| work item | user-shaped request and deterministic acceptance |
|---|---|
| `CLIENT-TEST-BASELINE` | Backfill contract tests for malformed payloads, unknown enum members, and optimistic-revision conflicts. The test must fail against its embedded broken fixture and pass against the base client implementation; production files remain unchanged. |
| `API-IDEMPOTENCY-BUG` | Reproduce two concurrent creates with the same key producing duplicate issues, then fix it test-first. Exactly one issue is durable and both successful replies identify it. Unrelated request keys stay independent. |
| `WEB-STALE-CACHE-BUG` | Reproduce an issue status remaining stale after a successful update, then fix cache reconciliation. Loading, failure, retry, keyboard focus, and successful refresh remain correct. |
| `CLIENT-ERROR-REFACTOR` | Replace duplicated error decoding with one typed internal helper without changing the exported API. Existing behavior tests plus malformed-error fixtures remain green. |
| `EVENTS-RETRY-BUG` | Reproduce a restart resetting the retry counter and causing excess delivery attempts. Persist the bounded attempt state; a recovered job resumes once and a terminal failure stays terminal. |
| `API-BULK-STATUS-FEATURE` | Add a typed bulk status endpoint with optimistic revisions and all-or-nothing validation. Empty input, duplicates, unknown IDs, stale revisions, oversized input, and a valid mixed update are covered. |
| `WEB-BULK-EDITOR-FEATURE` | Add a keyboard-usable bulk editor that consumes the pinned API contract, displays per-selection validation, disables duplicate submission, and renders typed API failures without losing selection. |
| `EVENTS-DEPENDENCY-UPDATE` | Update the one preselected direct dependency within the fixture's allowed version range, update the lockfile, prove the intended API use still works, and report audit/license changes. No unrelated dependency changes. |

Every `ship` brief states the pinned base revision, allowed paths, forbidden paths, validation
profile, requested worker profile, delivery mode `pull_request`, acceptance criteria, and explicit
non-goals. A separate `scout` task, using no repository mutation, reviews the portfolio plan before
wave 0 and writes a bounded `report.md` containing overlap risks, likely file conflicts, validation
order, and the fact that cross-repository/E1 dependencies are unavailable.

## Ground-truth requirements

| requirement | predicate and oracle |
|---|---|
| Isolated campaign | The protected-host guard is byte-identical before/after; all campaign paths, processes, sockets, databases, sessions, and remotes resolve under the isolated roots. |
| Exact installed authority | Deployed Comis version, service start time, four companion versions, protocol ID, artifact hashes, and bundle digest identify the recorded commits. |
| Opt-in integration | Liaison discovery contains exactly the DevCrew MCP catalog and selected prompt skill; a control agent has neither. Replacing the stateless MCP process preserves all task state. |
| Faithful portfolio plan | Before preparation, the liaison returns the manifest waves, dependencies, profiles, ceiling, estimated validation order, and E0 limitations without inventing merge or scheduling authority. |
| One logical preparation | Eight ship tasks plus one scout receive unique task, operation, managed-run, lease, worktree, branch, attachment, brief-hash, and delivery identities. Replays do not duplicate them. |
| Worktree isolation | Every canonical task root differs from the primary and all siblings. Pre-provider probes cannot read/write sibling roots or reporter attachments. |
| Reviewed launch | Each actual terminal binds the same task, run, lease, worktree, attachment target, profile, exact executable/version, and terminal allow entry projected by `get_launch_plan`. |
| Real concurrency | Wave 1 proves at least one backend and one frontend worker are simultaneously `working`; the measured overlap interval is positive in monotonic terminal/report timestamps. |
| Bounded concurrency | No more than four portfolio workers, two per reviewed profile, are `launching` or `working`. Ready overflow stays unlaunched until a slot is visibly free. |
| Dependency gate | No wave-1 task launches before the baseline gate closes; no wave-2 task launches before its named predecessor reaches an allowed terminal evidence posture. A code dependency on an unmerged candidate is refused as E1-unavailable. |
| Sibling independence | Pausing, failing, answering, killing, handing back, or validating one task does not stop, rebind, or change the cursor of a sibling. |
| Decision routing | Two workers request decisions concurrently. Handle-qualified replies from the origin resolve only the named key; a bare ambiguous reply asks for clarification and advances neither. |
| Candidate honesty | A coding CLI result or terminal exit never means success. Only the task-scoped candidate report plus clean-head validation and current forge truth can advance delivery. |
| Scope fidelity | Actual changed paths are a subset of each task's allowed paths; forbidden or cross-project changes reject the candidate and name the mismatch. |
| Local validation | Each task runs only its fixed profile. Required failures are terminal for that task but do not stop the candidate supervisor or unrelated tasks. |
| Cross-project behavior | The scratch integration oracle assembles all accepted diffs in manifest order, runs full repository checks, starts the API and event worker, drives the real web UI, and proves the pinned client contract end to end. |
| Verified delivery | Each accepted ship task maps to exactly one open pull request for the exact branch/head/base with current green required checks. The scout maps to one hashed report attachment. No merge occurs. |
| Restart recovery | Comis and DevCrew restarts preserve task/run/lease/origin/evidence/outbox identities; uncertain worker state becomes `unknown`; reports and deliveries are neither lost nor duplicated. |
| Cleanup safety | Open holds, active siblings, unresolved decisions, dirty worktrees, stale forge heads, and unknown process posture refuse cleanup without removing work or releasing the lease. Clean settled tasks are removed exactly once. |
| Normal-surface observability | DevCrew status/fleet/task explanation and Comis managed-run explanation/system health reconcile every lane without opening SQLite or requiring a raw-log hand join. |
| Credential confinement | Plaintext secret residency is zero in logs, sessions, trajectories, reports, task roots, repositories, and process arguments. Workers cannot reach Comis control, sibling attachments, broad forge credentials, or merge authority. |

## Concurrency plan and oracles

The driver must not infer concurrency from messages being sent close together. Record a monotonic
timeline for every transition: preparation accepted, activation, terminal created, wrapper
acknowledged, `working`, report received, candidate complete, validation start/end, forge check,
delivery, and cleanup.

1. Prepare all nine tasks before launching any real worker. Confirm every worktree and lease is
   distinct and all ship tasks pin the same base commit.
2. Run the scout and wave 0 first. Hold wave 1 ready and prove it does not launch early.
3. Launch wave 1 in the manifest order. Codex and Claude each receive two tasks. Require all four
   to become `working` before allowing any candidate-complete report. The common intersection of
   the backend, frontend, client, and event-worker working intervals is the primary overlap interval;
   if the workers are too fast, use a deterministic reporter barrier rather than sleeps.
4. While all four slots are occupied, attempt to launch one wave-2 task. It must remain ready or
   receive the documented bounded-concurrency refusal. A fifth terminal or process is a failure.
5. Release only the API bug barrier. Once its terminal posture is reconciled, launch the API feature
   into that one free profile slot. Repeat slot-by-slot; never bulk-release the remaining wave.
6. Pause the web lane, apply one operator edit inside that task's allowed paths, and hand it back.
   Stale evidence must be invalidated and the exact task revalidated while all other lanes continue.
7. Stop the event-worker terminal during active work. Only that task changes posture; the liaison
   reports the unknown/paused state and may safely obtain a fresh launch plan if supported.
8. Finish with zero workers active and reconcile measured maximums against both the global ceiling
   and per-profile ceilings.

Required concurrency evidence:

- DevCrew fleet snapshots and task event histories at every slot transition;
- Comis managed-run and terminal identities joined to each task handle;
- monotonic start/end intervals proving overlap, not wall-clock guesses;
- process census grouped by task, profile, worktree, lease, and attachment;
- no duplicate branch/worktree/terminal/report/outbox identity;
- no task report or decision advancing another task's cursor;
- zero writes in the primary checkout and zero reads/writes across sibling task roots.

## Failure-injection matrix

Run each injection as an isolated row, stop on the first Comis/DevCrew defect, and close it under the
kit's fix-verify discipline before continuing.

| fault | drive | required outcome |
|---|---|---|
| `concurrency_ceiling` | Hold four workers at the authenticated reporter barrier and request the fifth launch. | No fifth terminal/process starts; the task stays ready or returns the documented retryable capacity result; existing workers continue. |
| `worker_exit_without_report` | Let a reviewed coding CLI exit normally without a task report. | The selected task becomes `unknown` or the documented degraded posture, never candidate/success; siblings stay live. |
| `required_validation_red` | Enable the fixture's deterministic failing assertion for one candidate. | Only that task becomes failed with the exact validation profile/check in `explain_task`; no push/PR/delivery occurs; later valid candidates still progress. |
| `restart_with_pending_outbox` | Stop both services after evidence is durable but before the host acknowledgement is recorded. | Recovery reuses exact report/outbox identities and delivers once to the preparation-time origin. |
| `stale_forge_head` | Advance one fixture PR branch after local validation but before forge reconciliation. | Delivery blocks on head mismatch, invalidates stale evidence, and never claims the PR is current or green. |
| `dirty_cleanup_refusal` | Add an untracked file after a task settles and request cleanup. | Cleanup enters a durable hold, preserves worktree/lease/evidence, names the dirty posture, then resumes the same cleanup effect after the file is removed. |
| Wrong report binding | Send a report through a sibling attachment or alter run/lease/cwd/brief binding. | Authentication/binding rejection before either task cursor changes. |
| Altered operation replay | Reuse a completed operation ID with changed task content. | Durable non-retryable conflict and one logical task/effect. |
| Ambiguous decision | Leave two decisions open and send a bare reply. | Comis asks for a handle; no guessed response reaches either reporter. |
| MCP replacement | Kill and replace `devcrew-mcp` during active tasks. | Durable service/task state is unchanged; the replacement returns the same projections. |
| Service restart while working | Restart DevCrew, then Comis, with two workers live. | No automatic success or silent relaunch; exact recoverable identities survive and uncertain activity becomes honest `unknown`. |
| Local remote unavailable | Make the fixture remote unavailable during push. | Retryable dependency failure with actionable evidence; no PR URL or delivered state is invented. |
| Required check pending/red | Hold one required check, then make it red. | Candidate stays validating while pending and fails only when conclusive; unrelated candidates continue. |
| Cleanup with live sibling | Request removal while a process still owns that task root. | Refusal preserves the worktree and lease; no recursive or broad deletion occurs. |

Provider/model outages, rate limits, and worker timeouts are also driven once per worker family. The
liaison must distinguish provider failure, worker failure, validation failure, forge failure, and
capacity refusal instead of collapsing them into a generic task failure.

## Cross-project integration oracle

This oracle validates the portfolio without claiming an E1 integration task or creating a delivery
branch.

1. Verify every accepted candidate is clean, based on the pinned base, within its allowed paths,
   and locally green under its own fixed profile.
2. Create a fresh ephemeral scratch checkout beneath the campaign artifact root. Apply candidate
   diffs in manifest dependency order. Record every commit and patch digest. A conflict is a failed
   composition result, not permission to edit a task worktree.
3. Install from the existing lockfile in offline/frozen mode, then run repository formatting,
   static analysis, unit tests, API contract tests, and production builds.
4. Start the candidate API and event worker on ephemeral loopback ports. Serve the built web client,
   then drive the browser through issue creation, bulk status editing, cache refresh, typed failure,
   keyboard navigation, and notification retry/recovery.
5. Use the candidate client package against the live candidate API. Recompute durable API rows,
   event attempts, and UI-visible state from fixture storage rather than trusting the browser text.
6. Destroy only the ephemeral oracle checkout and processes. Task worktrees, branches, evidence,
   and forge state remain untouched for delivery verification and cleanup tests.

The oracle fails on a patch conflict, unexpected path, API/schema mismatch, duplicate durable issue,
lost event, stale UI state, flaky retry, test/build failure, leaked process, or any need to hand-edit
the scratch assembly. It records duration, peak RSS, file descriptors, network listeners, and full
test command/result digests.

## Real-world supervision arc

1. From one emulator conversation, ask the liaison to review the frozen portfolio, restate the
   boundary, identify independent versus unavailable dependency work, and propose the three waves.
2. Prepare the scout and all ship tasks through DevCrew MCP. Compare the returned plan to the
   manifest and ask one follow-up that changes priority without changing any task contract.
3. Drive the concurrency sequence, including the fifth-launch ceiling control and simultaneous
   backend/frontend work.
4. While siblings work, ask for fleet status, one task explanation, which slot will free next, and
   why no merge/integration task exists. Answers must reconcile with durable state.
5. Resolve two concurrent decisions, pause/edit/hand back the web task, and stop/recover the event
   task without disrupting siblings.
6. Run candidate validation, inject the required red validation in its isolated repetition, then
   restore the fixture control and prove the normal candidate path.
7. Run the cross-project integration oracle, hold delivery, restart both services, and release the
   forge checks one at a time.
8. Verify exactly one scout attachment and one pull request per accepted ship candidate. Exercise
   stale-head refusal and revalidation. Confirm no merge, release, or deployment exists.
9. Exercise cleanup refusals, settle all holds and decisions, remove every clean task root, release
   every lease, and prove zero orphan terminals, wrappers, sockets, and scratch processes.

## Negative and boundary controls

- Unknown repository, raw repository/worktree path, altered base, unknown profile, unknown
  validation profile, shell-shaped validation input, extra authority field, malformed contract,
  oversized contract, or expired preparation: reject before worktree/lease/run/process creation.
- Duplicate task request with the same operation and content: return the original task. Same
  operation with changed content: conflict without a second effect.
- More than four active workers or more than two from either reviewed profile: refuse/queue without
  killing a sibling or broadening a profile.
- Task asks to read a sibling candidate, base a branch on an unmerged task, create an integration
  branch, merge, deploy, publish, or push to the protected branch: explain the E0 boundary and do not
  attempt the action.
- Candidate modifies a forbidden path, generated authority file, worker configuration, repository
  hook, or validation command: reject before validation/delivery.
- Missing/ambiguous/old validation, dirty head, divergent branch, stale forge checks, wrong PR base,
  closed PR, changed PR head, broad credential, or missing branch protection: no delivery success.
- Wrong conversation replies to a decision or becomes the newest chat: no authority transfer and
  all reports/decisions/delivery notices remain bound to the preparation-time origin.
- Missing DevCrew MCP/skill allowlist entry: liaison cannot discover/use it; the control agent never
  gains it. Agent attempts to change capability-service topology are rejected as restart-only
  operator configuration.
- Malformed, reordered, duplicated, late, or cross-task terminal/report events: fail closed and
  preserve the prior durable state.
- Empty, very large, non-UTF-8, or rapidly repeated status requests: bounded responses, correct
  attribution, no dropped task state, and no message-body logging.

## Config polarities

| surface | positive posture | negative/control posture |
|---|---|---|
| Capability service | Exact enabled instance, contribution, MCP owner, control socket, secret reference, agent and root allowlists | Disabled/missing/mismatched instance: no activation or private metadata leak; health names the exact config fault |
| Prompt skill and MCP | Explicitly installed and allowlisted only for liaison | Each removed separately; absent from discovery and no authority change |
| Worker profiles | Exact Codex and Claude Code binaries, versions, auth, models, efforts, allow entries, and per-profile ceiling two | Missing/wrong/unauthenticated/unsupported profile fails without fallback |
| Global concurrency | Four portfolio workers maximum | Fifth launch stays ready/refused and starts only after a proven free slot |
| Validation | Fixed per-project profile with current clean head | Unknown profile, worker-selected program, red/missing/stale evidence blocks delivery |
| Forge | Distinct repository-scoped read/push identities, protected base, no merge identity | Shared/broad/missing/merge-capable credential or unprotected base blocks campaign start |
| Delivery | Ship tasks use verified pull requests; scout uses one bounded report | URL/prose/terminal exit or stale forge state never selects delivered |
| Cleanup | Settled, clean, current, no holds/decisions/processes | Dirty, active, held, unresolved, stale, mismatched, or unknown preserves work |

## Broad surface and fifth-axis sweep

- DevCrew MCP/CLI parity: all seven MCP tools and service/doctor/status/fleet/task/operation reads
  agree on versioned projections, state, source, confidence, freshness, and side-effect class.
- Comis: capability activation/health, managed-run reports/evidence/release, attention resolution,
  workspace leases, execution attachments, managed terminals, exact-origin continuation, delivery
  mirror, `explain`, and system health.
- Channel: emulator inbound/outbound, overlapping status turns, unrelated newer chat, exact-once
  notices, restart recovery, and no real Telegram request.
- Git/forge: primary/base identity, eight worktrees/branches, allowed-path diffs, fixed checks,
  separate credentials, current PR head/base/checks, cleanup safety, and no merge.
- Latency: baseline and compare preparation, activation, launch-to-working, decision round-trip,
  slot turnover, validation, restart recovery, delivery, integration, and cleanup durations.
- Cost: record liaison tokens/cost/cache behavior and any trustworthy per-worker usage. Missing
  coding-CLI accounting is `unknown`, never zero. Compare cost by work kind and profile.
- Resource/decay: over at least a two-hour campaign, sample both services' RSS/FDs, SQLite/WAL size,
  terminal/wrapper descendants, sockets, worktrees, and scratch processes at every wave boundary.
- Upgrade/first-run: start once from a genuinely fresh isolated install, exercise wrong-input setup,
  then upgrade over a populated synthetic campaign root and prove schema/history recovery. Never use
  existing operator data as the fixture.
- Concurrency: require the measured positive overlap interval, ceiling refusal, slot turnover, and
  cross-task identity isolation. Near-simultaneous chat messages alone do not count.
- Cross-lens integrity: reconcile emulator wire, session, trajectory, managed-run evidence,
  DevCrew database projections, Git/forge facts, terminal census, and cost totals.

Run `node packages/cli/dist/cli.js system-health --since <hours>` first for daemon-wide findings and
`node packages/cli/dist/cli.js explain "<ref>"` for each managed run. Use DevCrew's normal
`status`, `tasks list`, and `task explain` surfaces for companion truth. Raw logs or SQLite reads are
allowed only to debug those observability surfaces; needing them creates an instrumentation finding
that must be closed before campaign completion.

## Cyber-abuse classification

Ordinary feature, bug-fix, refactor, test, dependency, status, and deterministic fixture prompts in
this campaign are provider-safe. Filesystem isolation, wrong-binding, credential residency, broad
authority, and destructive cleanup protections are tested through offline configuration checks,
kernel probes, protocol fixtures, and service-owned fault controls before a model is invoked.

Do not send credential extraction, prompt injection, sandbox/approval bypass, internal-network
probing, destructive shell, policy override, or privilege-escalation text to a provider as part of
this target. If a newly derived row has that shape, label it exactly
`NOT-RUN: provider cyber-abuse safety suspension` unless the operator separately authorizes that exact row under
[`../CYBER-ABUSE-SUSPENSIONS.md`](../CYBER-ABUSE-SUSPENSIONS.md). Target inclusion is not
authorization.

## Explicit non-goals

- Multiple repositories under one E0 DevCrew service, a cross-repository scheduler, automatic
  dependency propagation, integration-task ownership, or shared writable worktrees.
- Merge, release, deployment, publication, production credentials/data, real Telegram traffic, or
  writes outside the disposable fixture repository and campaign roots.
- Treating a worker's prose, CLI output, terminal exit, branch name, commit, PR URL, or chat reply as
  sufficient delivery evidence.
- Claiming full network isolation when the host proves only filesystem/process confinement.
- Tuning Comis runtime defaults or prompts toward this fixture's application domain.

## Completion bar

The run begins with a comprehensive `TEST-PLAN.md` derived under the self-driving kit and ends only
when every manifest item, requirement, polarity, negative control, failure injection, fifth-axis
check, and broad-surface row is recorded as `OK`, `fails-honestly`, `COMIS-FAIL`, `NO-ACCESS`, or
`NOT-RUN`. A never-driven row is `NOT-RUN`; it cannot disappear from the matrix.

Completion requires ten-of-ten deterministic mechanics, both reviewed worker adapters proven live,
positive backend/frontend overlap, enforced global/per-profile ceilings, exact task/worktree/run/
lease/attachment/report isolation, all accepted candidates locally green, the ephemeral
cross-project oracle green, current forge truth for every delivered PR, exact-once origin delivery,
restart recovery, safe cleanup, clean health surfaces, zero leaked secrets, zero orphan processes,
zero false successes, and zero open Comis or DevCrew failures. Host Comis validation and companion
`make verify-full` must pass on the recorded revisions. Any E1 request remains an explicit honest
non-goal rather than being reclassified as an E0 product failure.
