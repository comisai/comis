# Production forensic replay framework review

## Outcome

The framework can now investigate a pinned production host, preserve the available activity and state as
authenticated evidence, prepare a distinct test-role machine, install the current build through the public
installer, clone state and runtime transactionally, and reject unsupported exactness claims. It is not yet
an operational self-driving replay system: the controller has no concrete Comis replay worker, production
boundary recorder, independent observer, or end-to-end feedback-loop command.

The investigated historical activity cannot be reproduced *exactly*. The pre-activity state checkpoint,
global deterministic-input ledger, and external dependency cassettes were not recorded when the activity
happened. Replaying the recovered events against final production state would double-apply effects and can
manufacture a match. The evidence remains useful for incident analysis and for deriving regression tests,
but it is `historical_best_effort`, never an exact replay.

This is an honest stop condition, not a request to weaken the gate. Exact replay becomes possible for a
future bounded episode only after the prospective recorder and operational replay worker described below
exist.

## Live investigation result

The source host was inspected read-only while its Comis service was already stopped. It remains stopped
and enabled. The target was kept stopped throughout installation and restore work and remains disabled,
marked `test`, and confined by a root-owned systemd drop-in with a private network namespace, AF_UNIX-only
address families, IP deny-all rules, a read-only system, and an empty capability set.

Available production evidence established the following bounded picture:

- 486 agent executions, 435 cron executions, 430 skipped heartbeat ticks, 365 queue enqueues, 36 channel
  deliveries, and 5 subagent executions;
- 22 recoverable user prompts and 36 authenticated Telegram message records, with matching content digests
  between source and target;
- 2,161 state entries in the whole-state snapshot, including the nested workspace/session layout;
- 58 inventoried evidence items and 14 explicit fidelity gaps; the capture was live/non-atomic and had no
  pre-window checkpoint;
- repeated operational signals including unstable prompt prefixes, dependency tool failures, TTL marker
  upgrades, JSON-RPC internal failures, duplicate active runs, durable-resume no-progress outcomes, prompt
  timeouts, and an oversized reflection prompt.

No prompt body, credential, token, attachment caption, or filename is copied into this report.

### Observed issue ledger

| Signal | Available count | Classification and next proof |
|---|---:|---|
| Unstable prompt prefix | 127 | Cache/prompt determinism degradation. Correlate the prompt-component digests and the first changing component per execution; the recorder must retain component identities, not prompt text. |
| Dependency tool failure | 26 | Mixed external failures. Group by tool, provider, error kind, request digest, and cassette coverage; each distinct shape needs a forced-failure regression or an explicit external outage verdict. |
| TTL marker upgrade | 17 | Durable-state normalization activity. Prove whether every marker converged and whether repeat reads remain write-free; repeated upgrades after convergence are a defect. |
| JSON-RPC internal error | 13 | Product failure until method-level evidence proves otherwise. Bind method, caller trust, error kind, trace, and handler outcome without parameters or bodies, then reproduce each unique failure digest. |
| Duplicate active run | 8 | Concurrency/idempotency contention. Verify whether the duplicate was safely rejected or caused a lost/duplicated effect; pin the root run and outward-ledger result. |
| Durable resume made no progress | 4 | Resume/liveness failure. Replay from the last durable step, require a monotonic step or an honest terminal reason, and verify cleanup of child processes and leases. |
| Prompt timeout/provider error | Present | Provider/budget boundary failure. Separate connection, timeout, authentication, model-capability, and token-budget causes and capture the response cassette or declared outage. |
| Reflection prompt over model limit | Present | Concrete budgeting defect. The reflection path must resolve the effective model window before submission and use the bounded deterministic fallback when the prompt cannot fit. |
| Orphaned LCD summaries | 50 | Context-store integrity debt reported by doctor. Run the supported compaction repair or rebuild and prove the context-item view reconciles. |
| Fallback LCD summaries | 28 | Summary quality debt. Exercise normal compaction with an available summarizer and verify the fallback markers are replaced without losing source coverage. |
| Cron XLSX attachment denied | 1 confirmed episode | Product-surface defect described below; retain the security denial and add an origin-bound artifact lane. |
| Private content in structured logs | Multiple paths | Fixed with sentinel regression tests for tool/audit/memory/system/attachment paths; retain a repository-wide canary scan in the release gate. |

Counts describe the retained evidence window, not lifetime totals. A category is not considered closed merely
because its log line is understood; the framework must bind it to a reproducible failure shape or an explicit
external/expected verdict.

## Confirmed product defect

A scheduled daily report generated its XLSX file but could not attach it to the configured channel. The
fallback text was delivered. The denial itself was correct: a user-trust unattended cron turn reached the
admin-scoped `message.attach` handler, which can select arbitrary targets and paths, and the deny-by-origin
guard rejected it.

The defect is the inconsistent product surface around that guard:

- automatic cron delivery supports only final text;
- the cron tool profile still exposes the general message tool;
- general tool guidance says a workspace artifact can be sent with `message.attach`;
- the scheduler has no safe, origin-bound artifact delivery path.

Do not persist admin trust on cron jobs, relax `message.attach`, or add a dispatcher exception. The safe
fix is a separate artifact-publication capability whose destination comes only from a short-lived run grant
bound to the scheduler's trusted delivery target. Its request must accept only a relative path in a
per-run outbox, prohibit URLs and caller-selected channels, reject traversal/symlinks/oversized or expired
files, enforce count and byte quotas, reuse the exactly-once delivery ledger, and revoke the grant in a
`finally` path. The cron-minimal profile should expose that capability instead of arbitrary-target
attachment delivery.

## Changes made during the review

The framework and the production code paths exercised by the investigation were hardened in these areas:

- pinned source/target identities and machine roles, a trusted role-gated daemon entrypoint, and a
  close-only test-role daemon path that cannot load normal channels, schedulers, providers, or plugins;
- installer-safe target preparation, stopped/disabled service invariants, transactional quarantine
  installation, and strict systemd containment checks;
- bounded SSH and binary transports with deadlines, TERM-to-KILL escalation, stream teardown, and failure
  settlement;
- authenticated evidence bundles, private payload vault bindings, causal transcript validation, activity
  family coverage, deterministic sequence and dependency-cassette contracts, and explicit fidelity gaps;
- snapshot identity for regular files, directories, hardlinks, ownership, modes, nanosecond timestamps,
  ACLs, xattrs, and capabilities, with symlinks rejected and unsupported metadata recorded as a gap;
- semantic host/runtime inventory covering OS, kernel, libc, Node ABI, timezone data, launcher, browsers,
  media tools, and native dependencies;
- a replay contract that injects only causal roots, resolves artifacts through an out-of-band authority,
  enforces exact deterministic consumption, checks independently observed events/state, and is structurally
  unable to claim that its generic contract engine is an operational exact replay;
- a feedback campaign that records reproduction fidelity separately from desired correctness and rejects
  unauthenticated/no-op evidence instead of treating caller-supplied status strings as GREEN;
- content-free logging for system dispatches, tool arguments, audit metadata, memory-review duplicates,
  and attachment captions/filenames across Telegram, Discord, Slack, WhatsApp, Signal, iMessage, and LINE.

## Missing operational pieces

These are required before the framework can support arbitrary use cases and production installations.
They are ordered by whether their absence can create a false exact claim.

### Exactness and evidence authority

1. Add an encrypted append-only flight recorder at every inbound, scheduler, provider, tool, MCP, media,
   queue, state-write, and outbound adapter boundary. Use one durable global sequence across event kinds,
   causal parents, source start/end watermarks, loss counters, deterministic values, and typed dependency
   cassettes.
2. Sign or hash-chain recorder segments and campaign state with an out-of-band authority. Re-authenticate
   the root bundle, episode, target, runtime, build, oracle, and observed result every time saved campaign
   state is loaded.
3. Seal hard-oracle definitions, derive their set digest from those definitions, and require every returned
   check to be a member. Bind forced-failure evidence to the defect, scenario, expected failure shape, and
   independent observation that proved the failure.
4. Keep data-state identity, captured production environment evidence, effective target configuration, and
   target confinement as separate attestations. Recompute identity after promotion; never copy a source
   digest into a target report.

### Operational replay

5. Add a root-owned, disabled-by-default one-shot replay worker separate from the production daemon unit.
   Give each run an immutable restored baseline and a fresh writable overlay. The worker must use a
   replay-only composition root and must never load live channel/provider credentials as active adapters.
6. Implement concrete Comis driver and observer adapters. Define a typed root-input artifact for channel
   messages, cron dispatches, proactive/system dispatches, heartbeats, webhooks, and operator actions.
   Expected internal events must never be sent to the driver as values it can echo.
7. Intercept clock, timers, randomness, identifiers, models, tools, MCP, HTTP, media, filesystem effects,
   and outbound delivery at their authoritative ports. Consume one globally ordered deterministic ledger,
   fail on any unused or extra record, and prohibit live network fallback.
8. Observe events, replies, queues, databases, files, process state, and attempted external effects through
   a separate flight-recorder/observer authority. Define quiescence explicitly and fail on missing, extra,
   duplicate, reordered, or late activity.
9. Add controller verbs for assemble, verify, replay-baseline, apply-build, replay-candidate, force-failure,
   finalize, and erase. Every verb must be resumable, idempotent, bounded by a total deadline, and leave a
   durable transaction journal.

### Restore, confinement, and portability

10. Verify source/target service UID and GID compatibility before restoring numeric ownership. Include
    hardlink topology, ACL/xattr/capability support, sparse extents, and filesystem feature parity in the
    exactness decision.
11. Make restore and runtime promotion crash-recoverable at every rename boundary. The rollback guard must
    recognize the journaled state where the live package root is temporarily absent. Add kill-point tests.
12. Add an explicit finalize/retention policy for rollback trees and copied environment material. Bound
    retained generations and securely remove secret-bearing rollback artifacts after durable attestation.
13. Use one canonical quarantine attestation in bootstrap, restore, runtime promotion, and startup. Verify
    both the root-owned file and effective systemd properties; run escape probes inside the exact replay
    execution context.
14. Discover installer/systemd, user-service, process-manager, container, orchestration, source-install,
    remote-store, and plugin persistence capabilities. Unsupported surfaces must create a typed gap before
    capture, not disappear from the transcript.
15. Stream large artifacts with chunked authenticated encryption and bounded memory. Use opaque keyed
    artifact identifiers, target-local decryption, crash cleanup, retention controls, and secret-canary
    scans of controller and target storage.
16. Reject an unmarked target that contains installer receipts, service units, package roots, or state from
    another lifecycle. A disposable-target cleanup must be explicit and audited; the controller must not
    reinterpret an incompatible receipt or silently reuse installation residue.

## Release gate

General availability requires a disposable two-machine Linux test that uses real systemd and the public
installer. Seed a known defect and a prospective episode, capture it, restore an independently verified
baseline, reproduce the defect, reject a no-op/echo replay, apply a test-first patch, replay from the same
baseline, pass the desired oracle, prove a forced failure still fails honestly, and verify that the source
never changed and the target never escaped confinement. Schema-only and fake-port tests do not satisfy
this gate.
