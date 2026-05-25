# Requirements: Comis Observability Initiative

**Defined:** 2026-05-24
**Core Value:** A fleet-wide bug must be diagnosable from one structured artifact with one command in under five minutes.

Each requirement maps to a design move (D1–D16) in `.planning/design/OBSERVABILITY_DESIGN.md`. The §5 acceptance criteria from the design doc are the test names in the corresponding RED commits (per AGENTS.md §2.10).

## v1 Requirements

### Trace Propagation

- [x] **TRACE-01**: TraceId is generated at channel ingress (in each `handleInboundMessage`) before any dispatch — closes G1
  - Acceptance: `grep "messageId=<id>" daemon.log` returns lines all sharing one `traceId`
  - Acceptance: `Inbound message` log line carries the trace id
  - Acceptance: Existing agent-side `traceId` consumers see no change
  - Design: D1 *(files: `packages/channels/src/*/...-inbound.ts` ×10, `packages/orchestrator/src/channel-manager.ts:243`, `packages/agent/src/executor/...`)*
  - Arch test: new `test/architecture/trace-propagation.test.ts` asserting every `adapter.onMessage(...)` site wraps in `runWithContext`
- [x] **TRACE-02**: `TrajectoryEvent` carries `source: "runtime" | "transcript" | "export"` discriminator
  - Acceptance: every event in `*.trajectory.jsonl` carries `source: "runtime"`
  - Acceptance: bundle exporter can mix in `source: "transcript"` events with stable tiebreak
  - Design: D2 *(files: `packages/observability/src/trajectory/{types,runtime}.ts`)*
- [x] **TRACE-03**: `NormalizedMessage.metadata.traceId?: string` typed concretely (replaces `Record<string, unknown>` accessor)
  - Design: D1 schema addition *(files: `packages/core/src/domain/...`)*

### Lifecycle Envelopes

- [x] **LIFE-01**: Every well-formed trajectory emits exactly one `trace.metadata` event after `session.started`, carrying harness/model/config/plugins/skills/prompting/redaction snapshot
  - Design: D4 *(files: `packages/observability/src/trajectory/metadata.ts` NEW, `packages/agent/src/executor/...`)*
- [x] **LIFE-02**: Every well-formed trajectory emits exactly one `trace.artifacts` event before `session.ended`, carrying finalStatus/abort/timeout flags, token usage, prompt-cache hit rate, compaction count, lastToolError
  - Design: D4 *(files: `packages/observability/src/trajectory/artifacts.ts` NEW, `packages/agent/src/executor/...`)*
- [x] **LIFE-03**: When the trajectory runtime file fills, the last event written is `trace.truncated` with non-zero `droppedEvents`/`droppedEventBytes`/`limitBytes`
  - Design: D4 / D7 *(files: `packages/observability/src/trajectory/runtime.ts`)*

### Bus Bridge Expansion

- [x] **BRIDGE-01**: Bridge maps `queue:enqueued/dequeued/overflow/coalesced` to `queue.{enqueued,dequeued,overflow,coalesced}` — closes G2 for the queue layer (would have caught today's bug in one query)
  - Design: D6 *(file: `packages/observability/src/trajectory/event-bus-bridge.ts:47`)*
- [x] **BRIDGE-02**: Bridge maps `retry:attempted/exhausted/markdown_fallback` to `delivery.{retry,retry_exhausted,markdown_fallback}`
  - Design: D6
- [x] **BRIDGE-03**: Bridge maps `execution:{aborted,budget_warning,prompt_timeout,output_escalated,signed_replay_recovered}` to corresponding `execution.*` types
  - Design: D6
- [x] **BRIDGE-04**: Bridge maps `security:{injection_detected,memory_tainted,warn}` and `sender:blocked` to `security.*` and `sender.blocked`
  - Design: D6
- [x] **BRIDGE-05**: Bridge maps `mcp:server:{disconnected,reconnecting,reconnect_failed,reconnected,tools_changed}` to `mcp.*` types
  - Design: D6
- [x] **BRIDGE-06**: Bridge maps `channel:health_changed`, `channel:registered`, `channel:deregistered` to `channel.{health_changed,lifecycle}`
  - Design: D6
- [x] **BRIDGE-07**: Bridge maps `compaction:{started,flush,recommended}` and `context:{evicted,masked,reread,overflow,integrity,rehydrated}` to `compaction.*` and `context.*` types
  - Design: D6
- [x] **BRIDGE-08**: Bridge maps `approval:requested` and `approval:resolved` to `approval.*` types (human-in-the-loop trace)
  - Design: D6
- [x] **BRIDGE-09**: Bridge expansion preserves emit-site architecture test; total mapped events grows from 18 → ≥ 45
  - Design: D6 *(arch test: existing `event-bus-bridge` enumeration grows shrink-only)*

### Payload Bounding

- [x] **BOUND-01**: Trajectory recorder applies recursive `limitTrajectoryPayloadValue(value, depth, seen)` with caps: string ≤ 32,768 chars, array ≤ 64 items, object ≤ 64 keys, depth ≤ 6, per-event ≤ 256 KB
  - Acceptance: `data: { x: <5MB string> }` becomes `{ truncated: true, reason: "trajectory-field-size-limit", originalChars: 5242880, limitChars: 32768 }`
  - Acceptance: circular object emits `{ truncated: true, reason: "trajectory-circular-reference" }`
  - Design: D7 *(file: `packages/observability/src/trajectory/runtime.ts`)*
- [x] **BOUND-02**: Trajectory file hits 10 MB soft / 50 MB hard cap → recording stops → final event is `trace.truncated`
  - Design: D7
- [x] **BOUND-03**: Trajectory writers stored in LRU `Map<string, QueuedFileWriter>` evicting at `MAX_TRAJECTORY_WRITERS = 100`
  - Design: D7

### Startup Invariants

- [x] **BOOT-01**: Daemon emits one `daemon:startup_invariants` INFO record per startup, asserting `adaptersByChannelType`, `handlersPerAdapter`, `pluginRegistryCount`, `channelRegistryCount`, `depSlotConsistency`, `agentCount`, `toolCatalogSize`, `mcpServerCount` — closes G3
  - Acceptance: boot log contains the record exactly once
  - Design: D10 *(files: `packages/daemon/src/wiring/setup-startup-invariants.ts` NEW, `packages/daemon/src/daemon.ts:1241`)*
  - **Completed:** Phase 3 Plan 01 (commits 97bce0a, ccefa97, b374e1f)
- [x] **BOOT-02**: If `handlersPerAdapter[<type>] > 1`, daemon emits WARN with `hint: "Duplicate adapter registration detected; see AGENTS.md §6.1"` and `errorKind: "config"` *before* the daemon accepts traffic
  - Acceptance: replay 2026-05-24 incident → WARN fires at boot
  - Design: D10
  - **Completed:** Phase 3 Plan 01 (commits 97bce0a, ccefa97, b374e1f)

### Forensic INFO Promotion

- [x] **INFO-01**: Forensic events promoted from DEBUG → INFO regardless of operator log level — `Adapter registered`, `Message enqueued`, `Message dequeued`, `Execution started`, `Execution complete`, `Memory store complete`, `Outbound message`. Closes G5.
  - Acceptance: production `logLevel: "info"` daemon still shows the queue-enqueue lines that would diagnose today's bug class
  - Acceptance: per-turn INFO count grows from ~5 to ~10 (bounded)
  - Design: D11

### Duplicate-Inbound Detection

- [x] **DEDUP-01**: New bus event `dedup:duplicate_inbound { messageId, channelType, chatId, firstSeenAt, duplicateAt, deltaMs, source }` added to `events-channel.ts` — closes G6
  - Design: D12 *(file: `packages/core/src/event-bus/events-channel.ts`)*
- [x] **DEDUP-02**: Bounded LRU (~1024 entries, 10 s window) in inbound pipeline emits `dedup:duplicate_inbound` + WARN on duplicate `messageId` within window
  - Acceptance: replay today's incident → fires `dedup:duplicate_inbound` with `deltaMs: 1`
  - Acceptance: LRU memory growth bounded
  - Design: D12 *(files: `packages/orchestrator/src/inbound/dedup-detector.ts` NEW, `packages/orchestrator/src/inbound/inbound-pipeline.ts:150`)*
- [x] **DEDUP-03**: `dedup:duplicate_inbound` mapped through bridge (BRIDGE-* set) to `dedup.duplicate_inbound` trajectory event
  - Design: D12 hand-off to D6

### Session DAG

- [x] **SESSION-01**: Every persisted session entry (non-`session` type) carries `parentId` pointing to its predecessor — closes G7 prerequisite for bundle export
  - Design: D3 *(file: `packages/agent/src/session/...`)*
- [x] **SESSION-02**: `readSessionBranch(filePath)` returns `{ header, leafId, branchEntries, warnings }` reading from leaf backward, with bounded-cycle and missing-parent detection
  - Acceptance: cycle → `cyclic-session-branch` warning (≤ 20 rows), export continues with reachable suffix
  - Acceptance: missing parent → `incomplete-session-branch` warning, export reachable suffix
  - Design: D3 *(file: `packages/observability/src/trajectory/export.ts` NEW)*

### Session Index

- [x] **INDEX-01**: Append-only `~/.comis/logs/session-index.jsonl` co-located with daemon logs, written via `QueuedFileWriter`. Three event kinds: `session_started`, `turn_completed`, `session_ended`. Bounded by date-roll.
  - Acceptance: `jq 'select(.channelType=="telegram" and .lastError != null)' session-index.*.jsonl` returns failures
  - Acceptance: `comis trace --since 1h --where error` (CLI-* set) uses the index as primary scan
  - Design: D14 *(files: `packages/observability/src/session-index/` NEW)*
- [x] **INDEX-02**: Agent emits `turn_completed` to the index after each turn (durationMs, input/output tokens, lastError)
  - Design: D14 *(file: `packages/agent/src/executor/...`)*
- [x] **INDEX-03**: Session lifecycle emits `session_started` and `session_ended` to the index
  - Design: D14 *(file: `packages/agent/src/session/...`)*

### Bundle Export

- [x] **BUNDLE-01**: `exportTrajectoryBundle(sessionId)` produces a directory under `<workspaceDir>/.comis/trace-exports/comis-trace-<sid8>-<ts>/` containing `manifest.json` + `events.jsonl` + `session-branch.json` + `metadata.json` + `artifacts.json` + `prompts.json` + `system-prompt.txt` + `tools.json`
  - Acceptance: `comis trace export <sessionId>` writes the directory
  - Acceptance: bundle round-trip — reader reconstructs chronological turn timeline from `events.jsonl` alone
  - Design: D5 *(file: `packages/observability/src/trajectory/export.ts` NEW)*
- [x] **BUNDLE-02**: Bundle manifest matches `TrajectoryBundleManifest` shape (§6.2), with `contents: [{path, mediaType, bytes}]` auto-populated and `warnings: TrajectoryBundleWarning[]` capped at 20 rows per code
  - Design: D5
- [x] **BUNDLE-03**: Bundle export honors hard limits — `MAX_TRAJECTORY_RUNTIME_EVENTS = 200_000`, `MAX_TRAJECTORY_TOTAL_EVENTS = 250_000`, `MAX_TRAJECTORY_SESSION_FILE_BYTES = 50 MB`, `MAX_TRAJECTORY_WARNING_ROWS = 20`
  - Acceptance: re-running export over a corrupted JSONL emits structured warnings, never crashes
  - Design: D5
- [x] **BUNDLE-04**: Bundle export merges runtime + transcript events with primary `ts` sort and `(source, sourceSeq)` tiebreak
  - Design: D5

### Trajectory Pointer Files

- [x] **POINTER-01**: Each session writes a `<sessionFile>.trajectory-pointer.json` sidecar (mode `0o600`, `O_NOFOLLOW` where supported) pointing to the runtime trajectory file
  - Design: D8 *(files: `packages/observability/src/trajectory/{paths,runtime}.ts`)*
- [x] **POINTER-02**: `observability.trajectory.dirOverride?: string` config knob honored (defaults to env `COMIS_TRAJECTORY_DIR` at gateway env-layer)
  - Acceptance: bundle export reads the pointer to locate the runtime file
  - Design: D8 *(file: `packages/core/src/config/schema-observability.ts`)*

### Platform-Aware Redaction

- [x] **REDACT-01**: Value-shape regex redactors applied at bundle time: secret fields, payload fields, identifier fields, AWS access keys, JWTs, URL userinfo, URL params, basic-auth, cookie headers, emails, long decimal IDs
  - Acceptance: bundle of a real session has zero unredacted Telegram chat IDs (`\d{9,}` shape)
  - Acceptance: `email@host.com` becomes redacted
  - Design: D9 *(files: `packages/observability/src/redact/patterns.ts`, `packages/observability/src/trajectory/export.ts`)*
- [x] **REDACT-02**: Bundle-time path substitution replaces literal paths with `$WORKSPACE_DIR` / `$HOME` / `$STATE_DIR` placeholders
  - Acceptance: a path containing `$HOME` is substituted, not echoed
  - Design: D9
- [x] **REDACT-03**: Test fixtures cover each pattern + the bundle-time integration (both directions: redacts true positives, leaves legitimate values alone where designed)
  - Design: D9 *(file: `packages/observability/src/redact/__tests__/`)*

### Operator CLI

- [ ] **CLI-01**: `comis trace --message-id <uuid>` returns channel→queue→agent→delivery rows in <2s on a session of 100 turns — closes G8
  - Design: D13 *(files: `packages/cli/src/commands/trace.ts` NEW, `packages/daemon/src/api/obs-handlers/obs-trace.ts` NEW)*
- [ ] **CLI-02**: `comis trace --trace-id <uuid>` returns every log/event/trajectory row sharing the traceId
  - Design: D13
- [ ] **CLI-03**: `comis trace --chat <chatId> --tail` streams trace events live for a chat
  - Design: D13
- [ ] **CLI-04**: `comis trace --since 10m --where error` returns the last 10 minutes of failures across all chats, using session index as primary scan
  - Design: D13
- [ ] **CLI-05**: `comis trace export <sessionId>` writes a bundle and prints the path
  - Design: D13
- [ ] **CLI-06**: Three new RPC contracts added: `ObsTraceSearchContract`, `ObsTraceTailContract`, `ObsTraceExportContract`
  - Design: D13 *(file: `packages/core/src/api-contracts/observability.ts`)*
- [ ] **CLI-07**: All `comis trace` subcommands support `--json` for machine consumption (human-readable columns by default)
  - Design: D13

### Owner-Gated Bundle Export

- [ ] **EXPORT-01**: `/export-trajectory` slash command works in a Telegram DM; in a group chat the result is DM'd to the owner, never inline
  - Design: M2.7 *(files: `packages/orchestrator/src/commands/...`, command handler)*

### Log Rotation

- [ ] **ROTATE-01**: `observability.logRotation` schema added to `schema-daemon.ts` with surfaced defaults (`maxSizeBytes: 50 MB`, `maxFiles: 5`, `maxAgeDays: 30`, `compressAged: true`) — closes G9
  - Design: D15 *(file: `packages/core/src/config/schema-daemon.ts`)*
- [ ] **ROTATE-02**: Rotation policy applied to `daemon.log`, `cache-trace.jsonl`, `config-audit.jsonl`, `session-index.jsonl`, `*.trajectory.jsonl` via Pino transport + per-stream honoring
  - Acceptance: 60 MB `daemon.log` rolls to `daemon.1.log.gz` automatically
  - Acceptance: operators see policy in `comis config get observability.logRotation`
  - Design: D15 *(files: `packages/infra/src/logging/logger.ts`, `packages/observability/src/{trajectory,session-index,cache-trace,config-audit}/...`)*
- [ ] **ROTATE-03**: `docs/operations/logging.mdx` documents the rotation policy
  - Design: D15

### Alert Budget

- [ ] **ALERT-01**: Rate-aggregator subscribed to health/safety events emits `health:budget_exceeded { kind, count, windowMs }` when per-`errorKind` threshold crossed in a sliding window — closes G10
  - Design: D16 *(spec'd in design §5; marked DEFER but landing in M3)*

### Pipeline-Tag Discipline

- [ ] **HYGIENE-01**: Architecture test asserts each known pipeline stage emits at least one `step:`-tagged log line — closes G4
  - Acceptance: `step:` coverage in `daemon.log` ≥ 50% (up from 3%)
  - Design: M3.3 *(file: `test/architecture/pipeline-step-coverage.test.ts` NEW)*

### Operator Documentation

- [ ] **DOCS-01**: `docs/operations/observability.mdx` rewritten to reflect new bridge mapping, lifecycle envelopes, INFO promotions, dedup detector
  - Design: M3.4
- [ ] **DOCS-02**: New `docs/operations/incident-bundle.mdx` documents `comis trace export` and `/export-trajectory` flow, including the privacy warning from design §8.5
  - Design: M3.4
- [ ] **DOCS-03**: New `docs/operations/trace-cli.mdx` documents every `comis trace` subcommand with copy-pasteable examples
  - Design: M3.4

## v2 Requirements

Deferred to a future scope. Not blocking M1/M2/M3 completion.

### Future Observability

- **OTEL-01**: OpenTelemetry export adapter on top of the trajectory stream (becomes a thin trajectory → OTLP shim once D1/D2/D4 land — design §11)
- **RETENT-01**: Per-stream retention policies — `observability.logRotation[stream].{...}` (acknowledged in design §15 open question 2; one-policy-fits-all is M3.1, per-stream is v2)
- **STREAM-01**: True streaming RPC for `comis trace --tail` (WebSocket), replacing the poll implementation (design §15 open question 3)
- **SIGN-01**: Bundle signing (sigstore / cosign) for non-repudiable handoff (design §15 open question 4)
- **REMOTE-01**: Remote trajectory storage as a port (S3, GCS) — design §15 open question 1

## Out of Scope

Explicitly excluded per design §11 — *not* in v1 *or* v2.

| Feature | Reason |
|---------|--------|
| Centralized log aggregation (Loki / Elasticsearch / Datadog) | Bundle exporter (D5) is the supported handoff; operators can ship bundles or stream logs themselves |
| Cross-instance / multi-tenant correlation | Different problem shape; design assumes one daemon at a time |
| ML-driven anomaly detection | D16 (alert budget) is rule-based; ML on the trajectory stream is a separate project |
| GUI for trajectory replay | Bundle is JSON-consumable by any tool; dedicated UI is downstream |
| Chat-level user-opt-out for trajectory recording | Separate policy decision; technical scope here doesn't gate it |
| OpenClaw direct-call-site recording pattern | Comis keeps bus-bridged design (better typing + arch-test enforcement); D6 grows coverage instead (design §14) |
| Mass-targeting / detection-evasion observability | Strict scope: defensive/diagnostic only |

## Traceability

Mapped 2026-05-24 by `/gsd-new-project` roadmapper. Phase numbers refer to `.planning/ROADMAP.md`.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TRACE-01 | Phase 1 | Complete |
| TRACE-02 | Phase 1 | Complete |
| TRACE-03 | Phase 1 | Complete |
| LIFE-01 | Phase 1 | Complete |
| LIFE-02 | Phase 1 | Complete |
| LIFE-03 | Phase 1 | Complete |
| BRIDGE-01 | Phase 2 | Complete |
| BRIDGE-02 | Phase 2 | Complete |
| BRIDGE-03 | Phase 2 | Complete |
| BRIDGE-04 | Phase 2 | Complete |
| BRIDGE-05 | Phase 2 | Complete |
| BRIDGE-06 | Phase 2 | Complete |
| BRIDGE-07 | Phase 2 | Complete |
| BRIDGE-08 | Phase 2 | Complete |
| BRIDGE-09 | Phase 2 | Complete |
| BOUND-01 | Phase 2 | Complete |
| BOUND-02 | Phase 2 | Complete |
| BOUND-03 | Phase 2 | Complete |
| BOOT-01 | Phase 3 Plan 01 | **Complete** |
| BOOT-02 | Phase 3 Plan 01 | **Complete** |
| INFO-01 | Phase 3 | Complete |
| DEDUP-01 | Phase 3 | Complete |
| DEDUP-02 | Phase 3 | Complete |
| DEDUP-03 | Phase 3 | Complete |
| SESSION-01 | Phase 4 | Complete |
| SESSION-02 | Phase 4 | Complete |
| BUNDLE-01 | Phase 4 | Complete |
| BUNDLE-02 | Phase 4 | Complete |
| BUNDLE-03 | Phase 4 | Complete |
| BUNDLE-04 | Phase 4 | Complete |
| POINTER-01 | Phase 5 | Complete |
| POINTER-02 | Phase 5 | Complete |
| REDACT-01 | Phase 5 | Complete |
| REDACT-02 | Phase 5 | Complete |
| REDACT-03 | Phase 5 | Complete |
| INDEX-01 | Phase 6 | Complete |
| INDEX-02 | Phase 6 | Complete |
| INDEX-03 | Phase 6 | Complete |
| CLI-01 | Phase 6 | Pending |
| CLI-02 | Phase 6 | Pending |
| CLI-03 | Phase 6 | Pending |
| CLI-04 | Phase 6 | Pending |
| CLI-05 | Phase 6 | Pending |
| CLI-06 | Phase 6 | Pending |
| CLI-07 | Phase 6 | Pending |
| EXPORT-01 | Phase 6 | Pending |
| ROTATE-01 | Phase 7 | Pending |
| ROTATE-02 | Phase 7 | Pending |
| ROTATE-03 | Phase 7 | Pending |
| ALERT-01 | Phase 7 | Pending |
| HYGIENE-01 | Phase 8 | Pending |
| DOCS-01 | Phase 8 | Pending |
| DOCS-02 | Phase 8 | Pending |
| DOCS-03 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 54 total (corrected from earlier "52" count after recounting; BRIDGE-01..09 = 9 not 7, and BOUND-01..03 = 3 not 2)
- Mapped to phases: 54 (100%)
- Unmapped: 0

Distribution: Phase 1 = 6 reqs, Phase 2 = 12, Phase 3 = 6, Phase 4 = 6, Phase 5 = 5, Phase 6 = 11, Phase 7 = 4, Phase 8 = 4. Total: 54.

---
*Requirements defined: 2026-05-24*
*Last updated: 2026-05-24 — traceability mapped by roadmapper*
