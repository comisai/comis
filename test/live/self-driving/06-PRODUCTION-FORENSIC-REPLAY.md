# Production forensic replay

Use this path when the target is activity that already happened on a real Comis machine. It is separate
from the channel-emulator path: the emulator creates synthetic activity, while forensic replay first
investigates production evidence, reconstructs a bounded activity episode, restores an isolated test
machine, and compares independently observed behavior.

The governing rule is simple: **never call a replay exact unless the framework can prove the initial
state, every replay input, every deterministic value and dependency response consumed during the window,
and the independently observed final result.** A structurally valid bundle is not proof that Comis ran.

## Choose the honest capture class

| Capture class | What it can prove | Exact replay eligibility |
|---|---|---|
| Historical forensic capture | What durable logs, databases, sessions, trajectories, messages, and state reveal after an incident | Never exact when the pre-activity checkpoint or a required source range is missing |
| Prospective bounded episode | A quiesced initial checkpoint, a bounded activity window, durable per-source watermarks, dependency cassettes, deterministic-input sequences, and a quiesced final observation | Eligible only when every required source is covered and no gap is declared |
| Synthetic emulator run | Behavior generated intentionally through a test adapter | Exact only for the synthetic inputs and oracles it actually controls |

A production and target evidence inventory can match while both inventories have the same retention gap.
That is parity, not completeness. `live_non_atomic`, `partial_retention`, `rotation_loss`, `scan_limit`, and
unknown-count evidence are fidelity gaps and must remain visible in the bundle and report.

## Safety boundary

The controller treats the source and target as different trust domains.

- `.live-env` pins distinct full machine-identity digests and the roles `production` and `test`.
- The source role is checked before any mutating operation. Never point `VPS` or an emulator helper at the
  source machine.
- A fresh target is installed with `website/public/install.sh` without initialization, autostart, or a
  service start. `/etc/comis/environment-role` must be root-owned and contain exactly `test`.
- The replay service is disabled and stopped while state or runtime artifacts are promoted.
- The test unit must have the quarantine drop-in: `COMIS_REPLAY_TARGET=1`, `AF_UNIX` only, and all IP
  traffic denied. These controls are a startup boundary, not a complete sandbox.
- The daemon entrypoint resolves the root-owned environment role before importing the live daemon. On a
  test host it validates the committed restore seal and enters a close-only quarantine. It does not load
  channels, schedulers, providers, plugins, or the normal composition root.
- A cloned runtime is committed only if the trusted entrypoint, exact unit `ExecStart`, role marker, and
  quarantine controls all survive promotion. Any failure rolls back and leaves both services stopped.
- State restore is accepted only with a root-owned, read-only attestation that binds the data directory,
  source manifest, entry count, byte count, and independently recomputed target tree digest.

Do not start a target whose unit still points to `daemon.js`, whose trusted entrypoint is absent, or whose
restore seal does not match the restored tree. A target that cannot pass those gates is evidence to fix,
not a reason to weaken the gate.

For the explicitly authorized whole-state workflow, the state clone includes the service user's entire
Comis data directory and the production service environment, including encrypted secret stores and usable
credentials. The target must therefore be disposable, single-purpose, network-confined, access-restricted,
and securely erased after the investigation. The reusable default should instead copy secret references,
bind them to target-only credentials, and replay external behavior from authenticated cassettes. Copying
live secret values must remain an explicit exceptional mode, never a hidden default.

## Controller commands

Create the ignored controller profile and pin both identities:

```bash
cp test/live/self-driving/scripts/.live-env.example \
  test/live/self-driving/scripts/.live-env
chmod 600 test/live/self-driving/scripts/.live-env
```

Run the controller from the repository root:

```bash
CTRL='pnpm exec tsx test/live/self-driving/scripts/production-replay.ts'

$CTRL profile
$CTRL doctor
$CTRL prepare-target
$CTRL runtime-attest
$CTRL evidence-source --package-root /absolute/source/package/root
$CTRL messages-attest --channel telegram
```

`doctor`, the source evidence inventory, and message attestation are read-only. Retrieve user-authored
channel messages through the offline `comis messages` command embodied by `messages-attest`; never mine
message bodies from daemon logs.

Capture state only after deciding how source consistency will be obtained:

```bash
$CTRL clone-state --run-id unique-state-run --capture-mode offline --agent-id main
$CTRL clone-runtime --run-id unique-runtime-run
$CTRL runtime-attest
$CTRL messages-attest --channel telegram
$CTRL evidence-parity
```

`offline` requires the production service to already be stopped and is the preferred historical capture.
`bounded-freeze` may temporarily stop an active production service and must restore its original service
state even when capture fails. That source mutation requires explicit operator authority; do not infer it
from a request to inspect production.

These commands prepare, clone, and attest. They do **not** yet constitute an end-to-end exact replay
command. Until the concrete Comis replay driver and flight recorder are wired into the controller, keep the
target service stopped after attestation. The test-role daemon is intentionally close-only rather than a
way to run production adapters with copied credentials.

## Investigation and transcript construction

Build the production baseline before changing code:

1. Inventory every configured and discovered persistence surface: SQLite tables, session records and
   parts, trajectories, diagnostic and audit stores, delivery queues and mirrors, cron definitions and
   runs, heartbeat and proactive queues, memory and learning stores, cache traces, graphs and subagents,
   plugin state, files, external stores, and channel-native records.
2. Read observability from broad to narrow: fleet health and diagnostics, structured logs and events,
   session and trajectory evidence, offline channel messages, then the underlying database or external
   system as ground truth.
3. Normalize records without bodies into the public transcript. Put private payloads in the encrypted
   vault and bind them by authenticated digest and typed metadata.
4. Preserve authoritative per-source sequence numbers. Reject collisions, reordered records, missing
   sequence values without a declared retention gap, source/event-family mismatches, unknown event kinds,
   and dangling causal parents.
5. Derive causality and ordering from durable identifiers. Wall-clock order across unrelated clocks is
   supporting evidence, not authority.
6. Compare source and target evidence independently after restore. Matching counts and timestamps alone do
   not establish matching content.

The current activity compiler recognizes channel, scheduler, proactive, system-dispatch, heartbeat,
subagent, graph, provider, tool, MCP, media, state-mutation, and daemon activity families. Recognition is
not capture coverage: any family without a durable extractor and watermarks contributes a fidelity gap.

## Prospective episode contract

An exact-eligible bundle must contain a capture episode bound to the same capture ID and include:

- a quiesced initial checkpoint captured before the first accepted activity;
- inclusive activity-window boundaries and an independently observed final checkpoint;
- source start/end watermarks for every required activity authority;
- deterministic sequences for time, randomness, and generated identifiers;
- typed external-dependency request/response cassettes;
- explicit coverage attestations for sources that legitimately emitted zero records;
- a target/oracle definition that distinguishes production fidelity from desired correctness;
- zero unresolved capture, ordering, retention, or consistency gaps.

Final production state captured after the activity is not an initial checkpoint. Replaying old events on
that state can double-apply writes, hit deduplication, and manufacture a false match. Historical material
without the initial checkpoint remains a forensic incident bundle even if every available digest agrees.

## Replay and feedback loop

The replay engine must be hostile to self-attestation:

- Resolve every bundle blob through an authenticated artifact resolver and parse the typed contents.
- Restore the initial checkpoint into an immutable baseline with a clean per-run overlay.
- Inject only causal roots such as channel input, scheduled dispatch, webhook input, or an approved
  operator action. Expected internal events are never passed to a driver as values it can echo.
- Intercept time, randomness, generated identifiers, providers, tools, MCP calls, media services, and
  external APIs. Require exact ordered consumption of every deterministic value and cassette.
- Observe internal events, replies, durable state, queues, files, and external side effects through an
  independent observer. Compute observed digests inside the framework from ground-truth artifacts.
- Fail on missing, duplicate, extra, reordered, or unconsumed activity, even if final output text matches.
- Re-run from a clean initial checkpoint for every code change.

Score two independent outcomes:

1. **Reproduction fidelity:** did the unmodified baseline reproduce the captured production behavior?
2. **Desired correctness:** did the declared security, quality, and state oracle pass?

The useful failure state is “production behavior reproduced, desired oracle failed.” After a fix, the
desired oracle must pass; an intentional difference from the buggy production output is expected and must
not be mislabeled as replay failure. Bind each transition to the actual bundle, source tree, build,
deployment digest, restore, replay observation, oracle artifacts, and regression tests rather than
caller-supplied strings.

## Required additions before general availability

The following work is part of supporting arbitrary use cases and installations; unsupported capabilities
must produce an explicit gap rather than silently disappearing.

- An encrypted append-only flight recorder at every port and adapter boundary, with a durable global
  sequence, all causal parents, source watermarks, routing and trust facts, state mutation facts,
  deterministic-input use, dependency cassettes, and durable loss counters.
- A concrete Comis replay driver, virtual scheduler, deterministic time/random/identifier providers,
  dependency interceptors, independent observer, and controlled concurrency/interleaving.
- One resumable command that performs capture, assembly, restore, replay, observation, diff, and the
  test-first correction loop, with signed or append-only transition evidence.
- Recoverable restore transactions or immutable baselines with copy-on-write runs; startup recovery and
  kill-point tests for every promotion step.
- Canonical machine and state identity covering ownership, times where semantic, ACLs, xattrs,
  capabilities, hardlinks, sparse extents, symlink policy, OS, architecture, Node ABI, native libraries,
  unit/drop-in configuration, timezone data, browsers, media tools, and kernel features.
- Strong replay confinement: private mount/process/network namespaces, syscall and capability reduction,
  controlled Unix sockets, read-only host filesystems, no device access, and live escape probes under the
  exact execution context.
- Streaming chunked authenticated encryption, opaque keyed artifact IDs, bounded-memory assembly,
  target-local decryption, explicit retention, crash cleanup, and secret-canary scans of controller and
  target artifacts.
- Capability discovery and adapters for installer/systemd, user services, process managers, containers,
  orchestration platforms, source installations, remote stores, and plugin-declared persistence and
  dependency surfaces.
- End-to-end disposable two-machine Linux tests using real systemd, archives, permissions, large
  artifacts, crash injection, confinement probes, nested Comis storage layouts, real daemon execution,
  and independently verified output and state.
- Total operation deadlines, cancellation, termination escalation, and orphan cleanup for SSH and binary
  transfer operations.

The release gate is operational evidence, not schema coverage: a disposable production-like machine and a
fresh Linux target must complete the whole command, reproduce a deliberately seeded defect, reject a
no-op/echo implementation, apply the test-first fix, restore from the same checkpoint, pass the desired
oracle, and leave the source unchanged and the target confined.
