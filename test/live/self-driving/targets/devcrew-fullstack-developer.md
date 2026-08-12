# TARGET — phone-only full-stack development through DevCrew

> A compact E0 acceptance campaign for the Comis capability-service platform and the
> `comis-dev-crew` companion. The only human-facing drive is the loopback Telegram emulator.
> The liaison prepares and supervises development work through the explicitly installed
> DevCrew MCP facade and prompt skill; it never constructs companion CLI command lines.
>
> This target is delivery-shaped. It may create branches and pull requests only in one
> disposable operator-owned GitHub fixture repository. It never merges, publishes, deploys,
> calls the real Telegram API, or reads an existing user's conversation data.

## Scenario

A developer sends one substantial request from the Telegram emulator: build a small but real
full-stack issue-tracking application and return verified delivery artifacts. The liaison turns
that request into three independent E0 tasks:

- a `ship` task for the backend, launched with the reviewed Codex profile;
- a `ship` task for the frontend, launched second with the reviewed Claude Code profile while
  the backend worker is still running;
- a `scout` task that returns a bounded architecture and integration-risk report.

The backend and frontend tasks use distinct leased Git worktrees and distinct branches from the
same pinned base revision. They share only a checked-in interface contract. No initiative graph,
dependency scheduler, integration task, or shared writable worktree is implied. An independent
test harness may combine the two candidate roots read-only to prove that the delivered components
interoperate; that is an oracle, not an E1 integration claim.

The developer supervises the work from chat: views the fleet, answers one worker decision, pauses
one lane, edits that lane's worktree directly, hands it back for revalidation, and observes the
sibling continue. Comis and DevCrew are restarted while delivery evidence is pending. Delivery is
accepted only from current Git and forge truth. Cleanup first refuses an open hold and then a dirty
worktree before removing both clean task roots and releasing their leases.

## Fixed deployment boundary

- Host: the dedicated Linux development box reached through the operator's SSH alias.
- Comis: the current checkout installed through the real installer, running as the dedicated
  service user under systemd.
- Campaign state: a new isolated data root, config, gateway port, service unit, DevCrew database,
  runtime root, repository root, and emulator. The pre-existing default Comis service and data
  root are protected by a before/after guard and are never used as campaign state.
- Channel: loopback Telegram emulator, admin sender `678314278`; no real Telegram API call.
- Companion: all four binaries built from one committed Go authority; `devcrew-service` is the
  sole durable writer, `devcrew-mcp` is stateless, and `devcrew-report` is task-scoped.
- Forge: one disposable private GitHub repository. The service receives separate read and push
  credential files. Worker credentials are limited to repository contents for that repository;
  branch protection prevents merge. No merge credential is installed.
- Capability exposure: the DevCrew MCP server and `dev-crew` prompt skill are installed only for
  the named liaison through explicit allowlists. A control agent receives neither.
- Worker order: Codex launches first; Claude Code launches second. Both exact installed versions,
  authentication postures, launch descriptors, and terminal allow entries are probed before use.
- Confinement: each worker receives only its leased root, protected reporter attachment, reviewed
  executable/argv, and the minimum credential/network posture needed by that harness. Filesystem
  sibling refusal must be kernel-enforced. Network isolation is reported at the level actually
  enforced by the host; lack of a host egress allowlist is an explicit limitation, never a hidden
  pass.

## Fixture application contract

The disposable repository contains a pinned `contract/api.json` and independent backend and
frontend test suites. The application is an issue board with these behaviors:

- `GET /api/issues` returns the durable issue collection;
- `POST /api/issues` validates and creates a title, priority, and optional description;
- `PATCH /api/issues/:id` changes status with optimistic revision checking;
- malformed JSON, invalid enum values, missing titles, unknown IDs, and stale revisions receive
  typed non-2xx responses without corrupting the store;
- the browser client lists issues, filters by status, creates an issue, changes status, renders
  API failures, and remains keyboard-usable;
- the backend serves health and static assets and accepts a test-only `STATIC_ROOT` so the oracle
  can combine the frontend candidate root with the backend candidate root without creating an
  integration branch;
- backend, frontend, and combined end-to-end checks are deterministic and require no external
  service.

The base repository carries the contract, test harness, neutral seed data, and intentional
implementation gaps. Each ship task owns only its component and its adjacent tests. The scout owns
only `report.md`. Candidate validation uses fixed reviewed programs and argument templates; a
worker cannot select a validation executable or shell fragment.

## Requirements and ground-truth oracles

| id | requirement | ground-truth predicate and oracle |
|---|---|---|
| ENV-1 | Campaign isolation | The protected default service/data guard is unchanged; every campaign session, DB, socket, worktree, and log resolves under the isolated campaign roots. |
| INST-1 | Installer-first deployment | Deployed-build record, installed CLI version, systemd `ExecStart`, and daemon start time identify the current Comis checkout. |
| PIN-1 | Exact companion authority | All four binaries report the intended Go commit; the pinned Comis protocol ID, bundle digest, artifact catalog, and source provenance match on both sides. |
| MECH-1 | Deterministic mechanics dependency | The real production delivery/forge/validation paths pass ten consecutive independent deterministic mechanics runs with retries disabled and no real coding CLI started. |
| EMU-1 | Channel baseline | `PONG42` is present byte-for-byte in emulator outbound, delivery mirror, and trajectory; sender resolves to admin. |
| CAP-1 | Opt-in capability pack | Liaison tool discovery contains the exact DevCrew MCP catalog and the skill is selected; a control agent has neither. Killing/replacing the MCP facade loses no task state. |
| PROF-1 | Codex adapter | Exact version/auth/profile probe succeeds; launch plan and actual terminal use the same reviewed profile and allow entry. |
| PROF-2 | Claude Code adapter | Exact version/auth/profile probe succeeds; launch plan and actual terminal use the same reviewed profile and allow entry. No fallback to Codex is permitted. |
| PREP-1 | Independent task preparation | Backend, frontend, and scout receive distinct task, managed-run, lease, branch, brief-hash, and attachment identities bound to the same repository/base revision. |
| JOIN-1 | Concurrent real workers | Codex backend reaches `working`; Claude frontend then reaches `working` before backend becomes terminal. Fleet and terminal views show both concurrently. |
| ISO-1 | Worktree confinement | Canonical roots are distinct from primary and one another; a pre-provider jail probe cannot read or write the sibling root and cannot see the sibling reporter attachment. |
| ISO-2 | Report identity | Each task accepts its own reporter traffic; a wrong-task or altered-binding report is rejected and changes no other task cursor/state. |
| NET-1 | Honest network posture | Kernel/firewall/container facts and an allow/deny control identify exactly what worker egress is constrained. Unsupported egress allowlisting is recorded as a limitation, not inferred from filesystem isolation. |
| DEC-1 | Decision answerer closes | One keyed decision is delivered to the origin, a handle-qualified emulator reply binds to it, the worker emits the matching resolution, and no unresolved decision remains. |
| ORIGIN-1 | Exact-origin delivery | After an unrelated emulator chat becomes newer, decision, scout, PR, recovery, and cleanup notices still go only to the preparation-time conversation. |
| INT-1 | E0 developer intervention | One worker reaches a safe paused state; the developer changes that task root directly; `validate-developer-work` captures the new head/dirty posture and invalidates stale evidence. |
| INT-2 | Sibling independence | During pause, direct edit, handback, and revalidation of one task, the sibling terminal remains listed and continues reporting. |
| CAND-1 | Candidate-state honesty | Coding-CLI or terminal exit never selects delivered/success. Only candidate report plus validation and forge/artifact evidence can advance. |
| VAL-1 | Fixed local validation | Reviewed backend and frontend checks pass on their candidate heads; the combined read-only harness proves API/UI interoperability and curl returns 200. |
| FORGE-1 | Verified ship delivery | Exactly two pull requests exist for the exact task branches/heads; required checks are current and green; delivery references match forge truth. No merge occurs. |
| SCOUT-1 | Verified report delivery | One bounded regular `report.md` is hashed, archived, and delivered once as the scout attachment. |
| RESTART-1 | Mid-flight recovery | Restarting both systemd services with forge truth pending preserves identities, candidates, decisions, outboxes, terminals where supported, and produces no duplicate PR/report delivery. |
| CLEAN-1 | Hold refusal | Cleanup with an open hold is rejected, reason-coded, and leaves worktree and lease intact. |
| CLEAN-2 | Dirty refusal | Cleanup with a dirty file is rejected, reason-coded, and leaves worktree and lease intact. |
| CLEAN-3 | Final cleanup | After resolving holds and dirt, all task roots are removed, leases released with the safe disposition, and no terminal/jail process remains. |
| OBS-1 | Normal-surface diagnosis | DevCrew fleet/task explanation and Comis managed-run/system health reconcile state, source, confidence, freshness, reports, evidence, delivery, and cleanup without a raw-log hand join. |
| SAFE-1 | Credential boundary | Plaintext secret residency is zero in logs, sessions, trajectories, reports, repository, and task roots; no worker can reach Comis control, channel credentials, or merge authority. |
| VALID-1 | Repository gates | Host `pnpm validate`, companion `make verify-full`, relevant Linux isolation suites, emulator tests, and live campaign-specific checks are green on the recorded commits. |

## Real-world arc

1. Establish isolated installer/emulator/service baselines and prove deterministic mechanics 10/10.
2. From one emulator message, have the liaison restate the delivery boundary and prepare all three
   tasks through MCP.
3. Launch the Codex backend worker, then the Claude frontend worker; prove overlap, fleet
   visibility, task/report isolation, and live sibling-path refusal.
4. Make a second emulator chat the most recent conversation without giving it task authority.
5. Deliver and answer one keyed worker decision from the origin chat; require worker resolution.
6. Pause the frontend lane, edit its worktree directly, and hand back for revalidation while the
   backend lane remains live.
7. Run fixed local checks and the read-only combined full-stack oracle. Hold forge checks, restart
   Comis and DevCrew, then release them.
8. Reconcile exactly two current pull requests and one scout attachment against GitHub, Git, the
   DevCrew evidence store, Comis evidence, and emulator outbound.
9. Exercise hold and dirty cleanup refusals, resolve both conditions, clean all task roots, and
   verify released leases plus zero orphan terminals.

## Edge, failure, and negative controls

| id | drive | required outcome |
|---|---|---|
| NEG-1 | Prepare with unknown repository, profile, validation profile, altered base, raw path, extra authority field, and malformed/oversized contract | Strict rejection before worktree, lease, run, or process creation; exact safe hint. |
| NEG-2 | Remove liaison MCP allow entry and skill allow entry one at a time | The corresponding tool/skill is absent and the relaxation/absence is visible; control agent remains unchanged. |
| NEG-3 | Stop and replace `devcrew-mcp` after preparation | Service/task state survives; a new facade returns the same state/version. |
| NEG-4 | Reuse an operation ID with altered content | Durable conflict; no second logical task or side effect. |
| NEG-5 | Send a report through the wrong task attachment or with altered run/lease/cwd/brief binding | Authentication/binding rejection; neither task cursor advances. |
| NEG-6 | Bare decision answer with zero or multiple open decisions; answer from wrong conversation | Clarification/refusal; no guessed binding and no worker input. |
| NEG-7 | Stop one terminal while its sibling runs | Only the selected terminal leaves the fleet; sibling keeps running and its state/report cursor advances. |
| NEG-8 | Exit a coding CLI without candidate evidence | Task becomes unknown/paused as positively supported, never candidate/delivered. |
| NEG-9 | Forge check held, red, stale, or head-mismatched | Delivery remains validating/blocked and names the evidence problem; no false PR success. |
| NEG-10 | Restart at report-persist/outbox/forge-check boundaries | Replay is idempotent; exact identities and origin survive; no duplicate delivery. |
| NEG-11 | Open cleanup hold, dirty file, unresolved decision, or unknown lease/process posture | Cleanup refuses and preserves work. |
| NEG-12 | Enumerate the installed operator/MCP catalogs for merge, publish, deploy, writable attach, and terminal custody | Deferred E1/E2 or disallowed actions are absent or explicitly unavailable; no provider prompt and no attempted side effect. |

Cyber-abuse-shaped provider prompts are not part of this campaign. Sibling access, environment
scrubbing, network posture, and secret residency are proven by deterministic pre-provider/kernel
oracles. Any prompt-shaped credential extraction, sandbox bypass, destructive command, internal
network probe, or policy override remains `NOT-RUN: provider cyber-abuse safety suspension` unless
the operator separately authorizes that exact row.

## Config polarities

| posture | positive | negative/control |
|---|---|---|
| Capability service | Enabled with exact bundle/service instance and seven contributed MCP tools | Disabled or missing allow entry: no tools activate and no private metadata leaks into model-visible output. |
| Prompt skill | Explicitly installed and allowlisted only for liaison | Removed from liaison or requested by control agent: not selected and no authority changes. |
| Worker profile | Exact Codex and Claude profiles resolve independently | Missing, wrong-version, unauthenticated, unsupported shape, or unknown lifecycle signal is reason-coded; no vendor/profile fallback. |
| Terminal allow entry | Exact command/profile/run/lease/attachment binding | Raw command/path/env override, wrong allow ID, or altered binding is refused. |
| Forge credentials | Separate repository-scoped read and push identities; branch protection/no merge credential | Shared, broad, missing, or merge-capable posture blocks campaign start. |
| Delivery | Ship=`pull_request`, scout=`report` | Wrong shape/mode or missing artifact/check truth does not deliver. |
| Cleanup | Clean, landed, settled, no holds | Held, dirty, unresolved, active, stale, mismatched, or unknown preserves work. |

## Broad surface sweep

- DevCrew MCP: `prepare_task`, `handback_task`, `cleanup_task`, `list_tasks`, `get_task`,
  `explain_task`, `get_launch_plan`; strict schemas, side-effect classes, metadata privacy, and
  idempotency.
- DevCrew CLI: service/doctor/fleet/task list/show/explain/launch-plan/operation plus prepare,
  handback, and cleanup JSON paths. CLI and MCP shared commands must agree.
- Comis: capability-service health/activation/report/evidence/release, workspace leases, execution
  attachments, managed terminal create/list/kill, attention resolution, exact-origin continuation,
  delivery mirror, managed-run explanation, and system health.
- Channel: Telegram inbound/outbound, newer unrelated chat, dual-oracle delivery, restart recovery,
  and no real Telegram network call.
- Forge/Git: canonical repo/base/worktrees, fixed checks, separate credential posture, exact PR
  branch/head/check truth, no merge, cleanup safety.
- Provider/model: verify the liaison's configured model ID equals the served model. A full provider
  catalog sweep is outside this product-focused target; both worker harness families are exercised
  at their exact reviewed versions instead.

## Fifth-axis checks

- Latency: record preparation, launch-to-working, decision round-trip, handback-to-validation,
  restart recovery, delivery, and cleanup durations; compare with the prior mechanics/live run.
- Cost: record liaison model cost/cache use and operator-visible external coding-CLI usage where the
  harness exposes it. Absence of trustworthy worker usage is reported as unknown, never zero.
- Resource/decay: over the full campaign (target at least one hour), compare daemon/service RSS,
  file descriptors, DB sizes, terminal/bwrap descendants, and worktree count at start/end.
- Upgrade: upgrade the current checkout over an isolated populated synthetic prior-release data
  root and prove boot/history/schema preservation. Existing real-user data is never the fixture.
- First run: exercise fresh isolated initialization plus wrong-input branches before normal setup.
- Concurrency: require real overlapping worker intervals and independent task attribution; merely
  issuing two requests together is insufficient.
- Cross-lens integrity: reconcile emulator wire, raw session, trajectory, incident report, DevCrew
  task/fleet state, Git/forge identities, and exact model/token/cost budgets for the origin chat.

## Explicit non-goals

- E1 initiative DAGs, dependency scheduling, contract supersession, integration-task ownership,
  and automatic multi-component merge.
- E2 terminal custody, writable attach, raw process signals, and operator control clients.
- Merge, release, deploy, package publication, production data, real Telegram, or writes outside the
  disposable GitHub repository.
- Claiming full network isolation when the host enforces only filesystem/process confinement.
- Treating a worker's prose, screen, exit code, branch, or pull-request URL as delivery truth.

## Completion bar

Every planned row is accounted for as `OK`, `fails-honestly`, `COMIS-FAIL`, `NO-ACCESS`, or
`NOT-RUN`; zero false successes and zero open COMIS-FAILs remain. The deterministic mechanics gate
is 10/10, both real worker adapters have live evidence, every HARD identity/confinement/origin/
cleanup/credential oracle is green, and all local/remote validation gates pass. E1/E2 rows remain
explicit non-goals rather than being misreported as product failures.
