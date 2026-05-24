# Roadmap: Comis Observability Initiative

**Created:** 2026-05-24
**Granularity:** coarse
**Source design:** `.planning/design/OBSERVABILITY_DESIGN.md` (1018 lines, 14 D-moves)
**Total v1 requirements:** 54 (all mapped)
**Total phases:** 8 (3 in M1, 3 in M2, 2 in M3)

## Core Value Reminder

A fleet-wide bug (today's worked example: 2026-05-24 duplicate Telegram adapter that double-fired every inbound) must be diagnosable from **one structured artifact with one command in under five minutes** — not 30 minutes of `grep | jq | python` across three log streams.

Phase ordering reflects this priority: M1 closes the today's-bug-class gaps first; M2 ships the operator tooling; M3 polishes retention + docs.

## Milestone Framing

| Milestone | Goal | Phases |
|-----------|------|--------|
| **M1 — Foundations** | Today's bug becomes diagnosable from one structured artifact in under 5 min if re-introduced tomorrow | Phases 1–3 |
| **M2 — Bundle + CLI** | Operators have one-command incident bundle export and one-command trace correlation | Phases 4–6 |
| **M3 — Polish + Retention** | Logs auto-rotate, alert budget watches health events, `step:` discipline is enforced, docs published | Phases 7–8 |

## Phases

- [ ] **Phase 1: Trace Propagation & Lifecycle Envelopes** — Every inbound carries a traceId from ingress; every turn has metadata/artifacts/truncated envelopes
- [ ] **Phase 2: Bridge Expansion & Payload Bounding** — Trajectory mapping grows from 18 to ~45 events with defense-in-depth bounds and writer LRU
- [ ] **Phase 3: Boot Invariants, INFO Promotion & Dedup Detector** — Today's bug visible at boot AND at first message AND at queue layer
- [ ] **Phase 4: Session DAG & Bundle Exporter** — Parent-linked session entries enable one-command bundle export with manifest + redaction-safe contents
- [ ] **Phase 5: Trajectory Pointer & Platform-Aware Redaction** — Trajectory storage is relocatable; bundles ship with platform-aware redaction at export boundary
- [ ] **Phase 6: Operator CLI & Slash-Command Export** — `comis trace` subcommands + session index + `/export-trajectory` owner-gated DM delivery
- [ ] **Phase 7: Log Rotation & Alert Budget** — Auto-rotating logs with compressed aged files + rate-aggregated health budget alerts
- [ ] **Phase 8: Pipeline-Tag Discipline & Operator Docs** — `step:` coverage ≥50% architecture-test-enforced + three new operator docs published

## Phase Details

### Phase 1: Trace Propagation & Lifecycle Envelopes

**Goal**: Every inbound message carries a traceId from channel ingress through queue, agent, and delivery; every well-formed trajectory emits exactly one `trace.metadata` (after `session.started`), one `trace.artifacts` (before `session.ended`), and a `trace.truncated` sentinel on bound exhaustion. This closes G1 (traceId born too late) and adopts O1 (source-tagged events) + O5 (lifecycle envelopes). Groups M1.1 + M1.2 + M1.3 (D1 + D2 + D4) — they share the trajectory schema surface and the executor-emit-site touchpoints, so landing them together avoids two passes over `packages/agent/src/executor/`. **TDD-first:** each D-move's design §5 acceptance criteria becomes a RED test commit before its production patch per AGENTS.md §2.10.

**Depends on**: Nothing (first phase)

**Requirements**: TRACE-01, TRACE-02, TRACE-03, LIFE-01, LIFE-02, LIFE-03

**Success Criteria** (what must be TRUE):
1. For any inbound message, `grep "messageId=<id>" daemon.log` returns lines all sharing one `traceId`, and the `Inbound message` log line itself carries that traceId (was previously `traceId=NONE`)
2. Every event in `*.trajectory.jsonl` carries `source: "runtime"` and validates against `TrajectoryEvent` schema v1 with the new `source` / `sourceSeq` / `parentEntryId` optional fields
3. Every well-formed trajectory has exactly one `trace.metadata` event after `session.started` (carrying harness/model/config/plugins/skills/prompting/redaction snapshot) and exactly one `trace.artifacts` event before `session.ended` (carrying finalStatus/abort/timeout flags, token usage, prompt-cache hit rate, compaction count, lastToolError)
4. When the trajectory runtime file fills (10 MB soft cap), the last event written is `trace.truncated` with non-zero `droppedEvents`, `droppedEventBytes`, and `limitBytes`
5. New `test/architecture/trace-propagation.test.ts` asserts every `adapter.onMessage(...)` site is wrapped in `runWithContext` (shrink-only; no allowlist entries)

**Plans** (6):
- [x] 01-01-PLAN.md — Schema-level foundations: relax RequestContextSchema; type NormalizedMessage.metadata.traceId; widen TrajectoryEventSource union; append trace.metadata + trace.artifacts to TRAJECTORY_EVENT_TYPES + DIRECT_EMIT_TRAJECTORY_TYPES carve-out; land RED trace-propagation arch test
- [x] 01-02-PLAN.md — Telegram + Discord + Slack ingress wraps (6 wrap sites in the three multi-entry adapters)
- [x] 01-03-PLAN.md — Remaining adapter wraps (WhatsApp + Signal + LINE + iMessage + IRC + Email + Echo) + orchestrator channel-manager second-wrap site
- [x] 01-04-PLAN.md — Reuse ingress traceId at execution-execute.ts:159 + execution-pipeline.ts:292 (close G1) + end-to-end integration test
- [x] 01-05-PLAN.md — Lifecycle envelopes: buildTraceMetadata + buildTraceArtifacts modules + emit sites in pi-event-bridge and comis-session-manager
- [ ] 01-06-PLAN.md — emitTraceTruncated public hook + refactor flushAndClose to share codepath (LIFE-03)

### Phase 2: Bridge Expansion & Payload Bounding

**Goal**: The trajectory bus-bridge maps ~45 events (up from 18) covering queue/retry/execution/security/mcp/compaction/context/approval, with defense-in-depth bounding (per-string char cap, per-array item cap, per-object key cap, max depth, per-event byte limit, file soft/hard cap, writer LRU). This closes G2 (12% bridge coverage) and adopts O4 (defense-in-depth bounding). The expansion would have caught today's bug in a single `queue.enqueued` trajectory query. Groups M1.4 + M1.5 (D6 + D7) — bridge expansion grows trajectory volume 2–3× per turn, so bounding must land in the same phase to prevent runaway. **TDD-first:** each new bridge mapping lands with a corresponding architecture-test growth and translator test before the production map entry.

**Depends on**: Phase 1 (TrajectoryEvent schema must carry `source` / `sourceSeq` before new bridge entries reference them)

**Requirements**: BRIDGE-01, BRIDGE-02, BRIDGE-03, BRIDGE-04, BRIDGE-05, BRIDGE-06, BRIDGE-07, BRIDGE-08, BRIDGE-09, BOUND-01, BOUND-02, BOUND-03

**Success Criteria** (what must be TRUE):
1. The bridge mapping table in `packages/observability/src/trajectory/event-bus-bridge.ts` contains at least 45 entries (up from 18), with each new entry gated by the existing emit-site architecture test; total includes `queue.{enqueued,dequeued,overflow,coalesced}`, `delivery.{retry,retry_exhausted,markdown_fallback}`, `execution.*`, `security.*`, `sender.blocked`, `mcp.*`, `channel.{health_changed,lifecycle}`, `compaction.*`, `context.*`, and `approval.*`
2. A `data: { x: <5MB string> }` event becomes `data: { x: { truncated: true, reason: "trajectory-field-size-limit", originalChars: 5242880, limitChars: 32768 } }` in the recorded JSONL; a circular object emits `{ truncated: true, reason: "trajectory-circular-reference" }`
3. When the trajectory runtime file hits the 10 MB soft cap, recording stops and the final event is `trace.truncated`; when it hits the 50 MB hard cap, the writer halts and emits an `errorKind: "resource"` WARN with a `hint` pointing to `observability.logRotation`
4. Trajectory writers are stored in an LRU `Map<string, QueuedFileWriter>` that evicts at `MAX_TRAJECTORY_WRITERS = 100`; an architecture test asserts no leak past the cap under synthetic load
5. Replaying today's incident logs through the bridge produces two `queue.enqueued` trajectory events with the same `messageId` (the signal that would have diagnosed the duplicate-adapter bug in one query)

**Plans**: TBD

### Phase 3: Boot Invariants, INFO Promotion & Dedup Detector

**Goal**: Today's-bug-class is structurally impossible to miss — the duplicate-adapter regression surfaces at boot (`daemon:startup_invariants` WARN with `handlersPerAdapter["telegram"]: 2`), at first message (`dedup:duplicate_inbound` event fires within 1 ms), and at queue layer (two `Message enqueued` lines visible at production INFO level instead of erased DEBUG). Closes G3 (no startup invariants) + G5 (forensic events at DEBUG) + G6 (no dedup detection). Groups M1.6 + M1.7 + M1.8 (D10 + D11 + D12) — all three close the M1 acceptance gate of "today's bug visible in one structured artifact." **Critical ordering note:** the `dedup:duplicate_inbound` bus event is added to `events-channel.ts` in this phase and DEDUP-03 routes it through the bridge added in Phase 2 — Phase 2 must complete first. **TDD-first:** RED test for each promoted INFO line, RED test for invariant emission on synthetic duplicate-adapter wiring, RED test replaying 2026-05-24 incident through the dedup LRU.

**Depends on**: Phase 2 (DEDUP-03 routes through the bridge expansion)

**Requirements**: BOOT-01, BOOT-02, INFO-01, DEDUP-01, DEDUP-02, DEDUP-03

**Success Criteria** (what must be TRUE):
1. On every daemon startup, exactly one `daemon:startup_invariants` INFO record appears in `daemon.log`, asserting `adaptersByChannelType`, `handlersPerAdapter`, `pluginRegistryCount`, `channelRegistryCount`, `depSlotConsistency`, `agentCount`, `toolCatalogSize`, and `mcpServerCount` — and when the 2026-05-24 regression is reintroduced, a WARN fires *before the daemon accepts traffic* with `errorKind: "config"` and `hint: "Duplicate adapter registration detected; see AGENTS.md §6.1"`
2. With production `logLevel: "info"`, the daemon log shows `Adapter registered`, `Message enqueued`, `Message dequeued`, `Execution started`, `Execution complete`, `Memory store complete`, and `Outbound message` — the seven forensic events that previously required `logLevel: "debug"` to diagnose today's bug class; per-turn INFO count grows from ~5 to ~10 (bounded by O(1) per turn)
3. Replaying the 2026-05-24 incident inbound through the dedup detector fires `dedup:duplicate_inbound` with `deltaMs: 1` and `source: "queue"`, accompanied by a WARN with `hint: "Same messageId processed twice; check channel adapter handler list and queue mode"` and `errorKind: "internal"`
4. The LRU detector caps at ~1024 entries with a 10 s window; an architecture test benchmarks it at 10× expected production load (300 msg/s synthetic) and asserts sub-microsecond overhead per check with bounded memory growth
5. The `dedup:duplicate_inbound` event is mapped through the bus-bridge to a `dedup.duplicate_inbound` trajectory event (preserving Phase 2's arch-test enforcement); end-to-end replay shows the dedup signal in `*.trajectory.jsonl` alongside the two `queue.enqueued` rows

**M1 Acceptance Gate (validated at Phase 3 close):** Spawn a fresh daemon in a sandbox, revert commit `96d62b16` (re-introduce the duplicate-adapter regression), boot, send one Telegram message. Expected: (a) boot WARN fires with handlersPerAdapter telegram=2; (b) two `queue.enqueued` trajectory events with same messageId; (c) `dedup:duplicate_inbound` event within 1 ms. If any of (a)/(b)/(c) fails, Phase 3 is not complete.

**Plans**: TBD

### Phase 4: Session DAG & Bundle Exporter

**Goal**: Every persisted session entry (non-`session` type) carries a `parentId` linking it to its predecessor; `readSessionBranch(filePath)` reconstructs the active branch from leaf backward with cycle and missing-parent detection; `exportTrajectoryBundle(sessionId)` produces a self-contained directory with `manifest.json` + `events.jsonl` (runtime + transcript merged, sorted by `ts` with `(source, sourceSeq)` tiebreak) + `session-branch.json` + `metadata.json` + `artifacts.json` + `prompts.json` + `system-prompt.txt` + `tools.json`. Adopts O2 (causality DAG) + O3 (bundle directory with manifest.contents[]). Groups M2.1 + M2.2 (D3 + D5) — the bundle exporter directly consumes the DAG-aware reader, so they ship together. **TDD-first:** RED test for DAG cycle detection + RED test for bundle round-trip (reader reconstructs chronological turn timeline from `events.jsonl` alone) before production code.

**Depends on**: Phase 1 (lifecycle envelopes feed `metadata.json` / `artifacts.json`); Phase 2 (sorted merge relies on `source` / `sourceSeq` fields)

**Requirements**: SESSION-01, SESSION-02, BUNDLE-01, BUNDLE-02, BUNDLE-03, BUNDLE-04

**Success Criteria** (what must be TRUE):
1. Every new non-`session` session entry written under `~/.comis/workspace/sessions/.../` carries `parentId` pointing to its predecessor; `readSessionBranch(filePath)` returns `{ header, leafId, branchEntries, warnings }` reconstructed from the leaf backward
2. A cyclic session emits a `{code: "cyclic-session-branch", row, message}` warning capped at 20 rows and export continues with the reachable suffix; a session with a missing parent emits `{code: "incomplete-session-branch", ...}` and exports the reachable suffix — neither crashes the exporter
3. `exportTrajectoryBundle(<sessionId>)` produces the directory `<workspaceDir>/.comis/trace-exports/comis-trace-<sid8>-<ts>/` containing all 8 expected files, with `manifest.json` matching `TrajectoryBundleManifest` shape including `contents: [{path, mediaType, bytes}]` auto-populated and `warnings: TrajectoryBundleWarning[]` capped at 20 rows per code
4. Bundle round-trip works: a reader given only `events.jsonl` reconstructs the chronological turn timeline; the merge respects primary `ts` sort with `(source, sourceSeq)` tiebreak (runtime + transcript events interleaved correctly)
5. Hard limits are enforced: re-running export over a corrupted JSONL session of >50 MB refuses with structured `errorKind: "resource"`; runtime events >200_000 are capped; warning rows per code >20 are truncated. Bundle exporter never crashes on malformed source data

**Plans**: TBD

### Phase 5: Trajectory Pointer & Platform-Aware Redaction

**Goal**: Trajectory runtime files can live anywhere on disk via `<sessionFile>.trajectory-pointer.json` sidecars (mode `0o600`, `O_NOFOLLOW` where supported) and the `observability.trajectory.dirOverride` config knob (default reads `COMIS_TRAJECTORY_DIR` env at the gateway env-layer); bundle export applies value-shape regex redaction at the export boundary covering long decimal IDs (catches Telegram chat IDs), JWTs, AWS keys, URL userinfo, basic-auth, cookie headers, emails — and path substitutions of literal paths to `$WORKSPACE_DIR` / `$HOME` / `$STATE_DIR` placeholders. Adopts O7 (platform-aware redaction). Groups M2.3 + M2.4 (D8 + D9) — both harden the bundle handoff (D8 makes trajectory storage relocatable; D9 makes the bundle privacy-safe at the egress boundary). **TDD-first:** RED fixture per pattern (both directions: redacts true positives, leaves legitimate values where designed) + RED test that a real-session bundle has zero unredacted Telegram chat IDs before production code.

**Depends on**: Phase 4 (bundle exporter is the redaction invocation site; pointer file is read by the exporter to locate the runtime file)

**Requirements**: POINTER-01, POINTER-02, REDACT-01, REDACT-02, REDACT-03

**Success Criteria** (what must be TRUE):
1. Each session writes a `<sessionFile>.trajectory-pointer.json` sidecar with mode `0o600` (verified by `fs.stat`) containing `{ traceSchema: "comis-trajectory-pointer", schemaVersion: 1, sessionId, runtimeFile }`; bundle export reads the pointer to locate the runtime file in any directory
2. Setting `observability.trajectory.dirOverride` (or `COMIS_TRAJECTORY_DIR` env at gateway layer) relocates new trajectory files to that directory; the pointer file in `~/.comis/workspace/sessions/.../` still resolves correctly; `comis config get observability.trajectory.dirOverride` returns the configured value
3. A bundle export of a real Telegram session has zero unredacted long-decimal-ID-shaped strings (`\b\d{9,}\b`) in any output file — including `events.jsonl`, `session-branch.json`, and `prompts.json`; an `email@host.com` becomes `[REDACTED]`; a `Basic dXNlcjpwYXNz` Authorization-header value is redacted; a JWT-shaped string (`eyJ…`) is redacted
4. Any literal `/Users/<name>/projects/...` path inside the bundle is substituted with `$WORKSPACE_DIR` / `$HOME` / `$STATE_DIR` placeholders (verified by `grep -r "/Users/" bundle/` returning zero matches for paths under the daemon's workspace/home/state roots)
5. Redaction test fixtures in `packages/observability/src/redact/__tests__/` cover each pattern (`SECRET_FIELD_RE`, `PAYLOAD_FIELD_RE`, `IDENTIFIER_FIELD_RE`, `AWS_ACCESS_KEY_ID_RE`, `JWT_RE`, `URL_USERINFO_RE`, `URL_PARAM_RE`, `EMAIL_RE`, `LONG_DECIMAL_ID_RE`, `BASIC_AUTH_RE`, `COOKIE_HEADER_RE`) in both true-positive and false-positive directions, plus a bundle-time integration test exercising all patterns together

**Plans**: TBD

### Phase 6: Operator CLI & Slash-Command Export

**Goal**: Operators have a one-command path from a user complaint to a full trace — `comis trace --message-id <uuid>` returns the channel→queue→agent→delivery rows in <2 s on a session of 100 turns; `comis trace --since 10m --where error` scans failures via the append-only `session-index.jsonl`; `comis trace export <sessionId>` invokes the Phase 4 bundle pipeline; `/export-trajectory` slash command works in a Telegram DM, or DM's the result to the owner if invoked in a group chat (never inline). Closes G7 (sessions are filesystem-only) + G8 (no CLI for trace correlation). Groups M2.5 + M2.6 + M2.7 (D13 + D14 + slash command) — the session index is a prerequisite for `--since/--where` modes, so it lands in the same phase. **Critical ordering note:** D14 (session index) must precede D13's CLI search modes that use it, and D13's `export` subcommand depends on Phase 4's bundle pipeline — both prerequisites are honored. **TDD-first:** RED test per CLI subcommand against a fixture session; RED test for owner-gating on `/export-trajectory` (group chat → DM delivery, never inline) before production code.

**Depends on**: Phase 4 (`comis trace export` invokes the bundle pipeline); Phase 5 (bundle privacy-safety is what makes `/export-trajectory` DM-able)

**Requirements**: INDEX-01, INDEX-02, INDEX-03, CLI-01, CLI-02, CLI-03, CLI-04, CLI-05, CLI-06, CLI-07, EXPORT-01

**Success Criteria** (what must be TRUE):
1. The append-only `~/.comis/logs/session-index.jsonl` (date-rolled) co-located with daemon logs is written via `QueuedFileWriter` with three event kinds (`session_started`, `turn_completed`, `session_ended`); `jq 'select(.channelType=="telegram" and .lastError != null)' session-index.*.jsonl` returns Telegram failures from the last day; a session with 100 turns produces ~102 index entries (start + 100 × turn + end)
2. `comis trace --message-id <uuid>` returns channel→queue→agent→delivery rows in under 2 seconds on a 100-turn session, with columns: `ts | layer | event | data`; replaying the 2026-05-24 incident produces output including both `queue.enqueued` rows AND the `dedup.duplicate_inbound` row
3. `comis trace --trace-id <uuid>` returns every log line, bus event, and trajectory row sharing that traceId (joined by the traceId injected at ingress in Phase 1); `comis trace --chat <chatId> --tail` streams trace events live for a chat; `comis trace --since 10m --where error` uses the session index as the primary scan and returns the last 10 minutes of failures across all chats
4. `comis trace export <sessionId>` writes a bundle (Phase 4 pipeline) and prints the absolute path; all subcommands support `--json` output for machine consumption (human-readable columns by default); three new RPC contracts (`ObsTraceSearchContract`, `ObsTraceTailContract`, `ObsTraceExportContract`) exist in `packages/core/src/api-contracts/observability.ts`
5. `/export-trajectory` invoked in a Telegram DM returns the bundle directory path in the same DM thread; the same command invoked in a Telegram group chat replies in the group with `"Bundle sent to owner DM"` and DM-delivers the path to the configured owner only — the bundle path is NEVER inline in the group response

**Plans**: TBD

### Phase 7: Log Rotation & Alert Budget

**Goal**: All observability streams (`daemon.log`, `cache-trace.jsonl`, `config-audit.jsonl`, `session-index.jsonl`, `*.trajectory.jsonl`) honor a single `observability.logRotation` policy (50 MB / 5 files / 30 days / gzip aged) wired through the Pino transport and per-stream honorers; a rate-aggregator subscribed to health/safety events emits `health:budget_exceeded { kind, count, windowMs }` when per-`errorKind` thresholds are crossed in a sliding window. Closes G9 (silent rotation) + G10 (no alert budget). Groups M3.1 + M3.2 (D15 + D16) — both are retention/health surfaces, both ship with corresponding `comis config get` visibility, and D16 was marked DEFER in design §5 but lands here to keep the scope honest. **TDD-first:** RED test that a 60 MB synthetic `daemon.log` rolls to `daemon.1.log.gz`; RED test that flooding the bus with 100 `errorKind: "network"` events in a 60 s window emits exactly one `health:budget_exceeded` event.

**Depends on**: Phase 6 (session index is one of the streams that must honor rotation policy)

**Requirements**: ROTATE-01, ROTATE-02, ROTATE-03, ALERT-01

**Success Criteria** (what must be TRUE):
1. `observability.logRotation` schema in `packages/core/src/config/schema-daemon.ts` exposes `maxSizeBytes` (default 50 MB), `maxFiles` (default 5), `maxAgeDays` (default 30), `compressAged` (default true); `comis config get observability.logRotation` returns the active policy
2. A 60 MB `daemon.log` automatically rolls to `daemon.1.log.gz`; `*.trajectory.jsonl` files exceeding `maxSizeBytes` roll with gzip compression; `session-index.jsonl` and `cache-trace.jsonl` and `config-audit.jsonl` honor the same policy per their writers
3. When the daemon emits 100 events tagged `errorKind: "network"` within a 60 s sliding window, exactly one `health:budget_exceeded { kind: "network", count: 100, windowMs: 60000 }` event fires (not 100); after the window slides past, the aggregator re-arms
4. `docs/operations/logging.mdx` documents the rotation policy with copy-pasteable config examples and the 5-stream × 5-file × 50 MB worst-case (1.25 GB → ~300 MB with gzip) storage budget
5. Rotation is non-blocking on the inbound hot path; an architecture test asserts the Pino transport rotation happens off the main event loop (verified by synthetic 100 MB write under a synthetic clock)

**Plans**: TBD

### Phase 8: Pipeline-Tag Discipline & Operator Docs

**Goal**: Every known pipeline stage emits at least one `step:`-tagged log line — enforced by a new architecture test (`test/architecture/pipeline-step-coverage.test.ts`); `step:` coverage in `daemon.log` rises from 3% to ≥ 50%. Three operator docs are published: rewritten `docs/operations/observability.mdx` reflecting the new bridge mapping + lifecycle envelopes + INFO promotions + dedup detector; new `docs/operations/incident-bundle.mdx` documenting `comis trace export` and `/export-trajectory` with the design §8.5 privacy warning; new `docs/operations/trace-cli.mdx` with copy-pasteable examples for every `comis trace` subcommand. Closes G4 (`step:` underused) + delivers the M3.4 docs deliverable. Groups G4 + M3.4 — both are hygiene/documentation deliverables that gate the milestone-close-out. **TDD-first for HYGIENE-01:** the architecture test lands as a RED commit listing every pipeline stage; production patches add `step:` to each emit site until the test passes. Docs are exempt from TDD per AGENTS.md §2.10.

**Depends on**: Phase 7 (rotation docs are referenced from the new observability docs; alert budget is documented in the rewrite)

**Requirements**: HYGIENE-01, DOCS-01, DOCS-02, DOCS-03

**Success Criteria** (what must be TRUE):
1. `test/architecture/pipeline-step-coverage.test.ts` asserts each known pipeline stage (inbound, queue, execution, retry, delivery, memory, context, security, mcp, compaction, dedup) emits at least one `step:`-tagged log line; the test is shrink-only (no allowlist entries — fix the emit site instead)
2. `step:` coverage in a fresh `daemon.log` from a full agent turn is ≥ 50% of lines (up from 3% baseline) — verified by `jq 'select(.step != null) | length' daemon.log | wc -l` divided by total line count
3. `docs/operations/observability.mdx` is rewritten end-to-end, reflecting the new bridge mapping (~45 events), lifecycle envelopes, INFO promotions, dedup detector, log rotation, and alert budget — with the design's "today's bug under the new system" §12 worked example included
4. `docs/operations/incident-bundle.mdx` documents `comis trace export` and `/export-trajectory` flow end-to-end, including the design §8.5 privacy warning ("session-branch.json contains the full reconstructed branch; bundles are owner-gated; redaction is heuristic"), copy-pasteable invocation examples, and a worked example of bundle inspection with `jq`
5. `docs/operations/trace-cli.mdx` documents every `comis trace` subcommand (`--message-id`, `--trace-id`, `--chat --tail`, `--since --where`, `export`) with copy-pasteable invocation examples, `--json` output samples, and the "from user complaint to bundle in 3 commands" worked example

**M3 + scope-close acceptance gate (validated at Phase 8 close):** The 2026-05-24 incident replay — fresh daemon, revert `96d62b16`, send one Telegram message — diagnoses the bug in under 5 minutes via `comis trace --message-id <id> | head -20` AND the operator finds the docs explaining what they're looking at without re-reading source. Coverage floors hold (lines 90 / branches 85 / functions 90 on `packages/*/src/**/*.ts`). `pnpm validate` clean.

**Plans**: TBD

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Trace Propagation & Lifecycle Envelopes | 4/6 | In Progress|  |
| 2. Bridge Expansion & Payload Bounding | 0/0 | Not started | - |
| 3. Boot Invariants, INFO Promotion & Dedup Detector | 0/0 | Not started | - |
| 4. Session DAG & Bundle Exporter | 0/0 | Not started | - |
| 5. Trajectory Pointer & Platform-Aware Redaction | 0/0 | Not started | - |
| 6. Operator CLI & Slash-Command Export | 0/0 | Not started | - |
| 7. Log Rotation & Alert Budget | 0/0 | Not started | - |
| 8. Pipeline-Tag Discipline & Operator Docs | 0/0 | Not started | - |

## Parallelization Notes

Per design §16, M1 supports a 2-stream parallel split for ~1 week wall-clock vs ~2 weeks serial. Under the coarse phase grouping:

- **Phase 1 and Phase 2** are sequentially gated (Phase 2 schema entries reference Phase 1 fields).
- **Within Phase 1**: D1 (TraceId at ingress) is independent of D4 (lifecycle envelopes); these two can be parallelized inside the phase plan.
- **Within Phase 2**: D6 (bridge expansion) and D7 (payload bounding) are independent; can be parallelized inside the phase plan.
- **Phase 4 and Phase 5** can be parallelized in part (POINTER-01/02 in Phase 5 is independent of BUNDLE-01..04 in Phase 4), but the redaction-at-export-boundary (REDACT-*) depends on Phase 4's exporter — keep that part sequential.
- **Phase 6** is mostly sequential internally (INDEX-* before CLI search modes that use the index).
- **Phase 7 and Phase 8** can run in parallel (rotation is config + transport wiring; docs are markdown).

Plan-phase will surface fine-grained parallel splits per phase.

## Coverage Validation

**v1 requirements:** 52
**Mapped to phases:** 52
**Unmapped:** 0

Distribution:
- Phase 1: TRACE-01, TRACE-02, TRACE-03, LIFE-01, LIFE-02, LIFE-03 (6)
- Phase 2: BRIDGE-01..09, BOUND-01..03 (12)
- Phase 3: BOOT-01, BOOT-02, INFO-01, DEDUP-01..03 (6)
- Phase 4: SESSION-01..02, BUNDLE-01..04 (6)
- Phase 5: POINTER-01..02, REDACT-01..03 (5)
- Phase 6: INDEX-01..03, CLI-01..07, EXPORT-01 (11)
- Phase 7: ROTATE-01..03, ALERT-01 (4)
- Phase 8: HYGIENE-01, DOCS-01..03 (4)

Total: 6+12+6+6+5+11+4+4 = 54 → wait, that's 54 not 52. Let me recount: 6 + 12 + 6 + 6 + 5 + 11 + 4 + 4 = 54. But REQUIREMENTS.md counts BRIDGE-01..09 = 9, BOUND-01..03 = 3 → Phase 2 = 12 ✓. INDEX = 3, CLI = 7, EXPORT = 1 → Phase 6 = 11 ✓. Let me recount actual REQ-IDs in REQUIREMENTS.md:

- TRACE: 01, 02, 03 = 3
- LIFE: 01, 02, 03 = 3
- BRIDGE: 01–09 = 9
- BOUND: 01, 02, 03 = 3
- BOOT: 01, 02 = 2
- INFO: 01 = 1
- DEDUP: 01, 02, 03 = 3
- SESSION: 01, 02 = 2
- INDEX: 01, 02, 03 = 3
- BUNDLE: 01, 02, 03, 04 = 4
- POINTER: 01, 02 = 2
- REDACT: 01, 02, 03 = 3
- CLI: 01–07 = 7
- EXPORT: 01 = 1
- ROTATE: 01, 02, 03 = 3
- ALERT: 01 = 1
- HYGIENE: 01 = 1
- DOCS: 01, 02, 03 = 3

Sum: 3+3+9+3+2+1+3+2+3+4+2+3+7+1+3+1+1+3 = 54.

REQUIREMENTS.md preamble says "52 total" but the actual REQ-IDs sum to 54. This is a counting error in REQUIREMENTS.md (likely from before BRIDGE-09 and BOUND-03 were added). The roadmap covers all 54 actual requirements; the traceability table updated below also has all 54 entries.

**Coverage: 54/54 mapped (no orphans; no duplicates).** The REQUIREMENTS.md preamble count will be corrected during traceability update.

---

*Roadmap created: 2026-05-24 by GSD roadmapper*
*Granularity: coarse (8 phases). Source: `.planning/design/OBSERVABILITY_DESIGN.md` §7 (D1–D16 grouped into delivery boundaries per the user's coarse granularity choice).*
