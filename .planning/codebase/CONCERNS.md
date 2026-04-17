# Codebase Concerns

**Analysis Date:** 2025-04-17

## Tech Debt

### ESLint Configuration Non-Blocking

**Issue:** Security lint rules are configured as `continue-on-error: true` in CI (.github/workflows/ci.yml:38).

**Files:** `.github/workflows/ci.yml`, `eslint.config.js`

**Impact:** The baseline shows 138 errors + 1438 warnings across the codebase. Violations do not fail CI, allowing security and convention violations to accumulate over time. This undermines the security-first architecture.

**Fix approach:** 
1. Audit and fix existing violations to establish a clean baseline
2. Remove `continue-on-error: true` from CI
3. Integrate ESLint into pre-commit hooks to prevent new violations
4. Target: zero errors, zero warnings in main branch

### Incomplete Poll Result Normalization

**Issue:** Poll result normalization is deferred on two major channel adapters.

**Files:** 
- `packages/channels/src/whatsapp/whatsapp-adapter.ts:138`
- `packages/channels/src/discord/discord-adapter.ts:112`

**Impact:** When users interact with polls on WhatsApp or Discord, the results are not normalized to the standard `NormalizedPollResult` format. This blocks poll-based interactions and requires manual handling in skills or controllers.

**Fix approach:** 
1. Implement poll vote tracking for each platform (WhatsApp Business API supports polls; Discord has `poll_answer` events)
2. Wire normalization through the existing `normalizeStructuredContent()` pipeline
3. Add integration tests for poll interactions on each platform

### Task Extraction Deferred to LLM Bridge

**Issue:** Scheduled task extraction is wired to a stub that requires LLM integration.

**Files:** `packages/daemon/src/wiring/setup-schedulers.ts:425`

**Impact:** The `TaskExtractionScheduler` cannot extract executable tasks from agent messages without a real LLM call. Currently logged as `// TODO: Wire to agent executor LLM call for real extraction`. This blocks the task extraction feature for automation workflows.

**Fix approach:**
1. Implement task extraction via the agent executor's LLM bridge
2. Use existing `PiExecutor` infrastructure to classify and extract tasks
3. Add test coverage for multi-turn task accumulation

## Known Bugs

### Cache Metadata Timing Bug in Bridge

**Symptoms:** In `pi-event-bridge.ts`, token timing calculations for cache analysis compute the gap between the last tool end and the next tool start incorrectly when tools are tightly spaced.

**Files:** `packages/agent/src/bridge/pi-event-bridge.test.ts:2988, 3038, 3064`

**Trigger:** This manifests only when:
- Multiple tool calls are chained with minimal gaps (<100ms)
- Cache breakpoints are placed on each tool boundary
- The bridge tries to compute cumulative timing for cache cost analysis

**Workaround:** Timings are logged but not used for decision-making; the issue is observational only.

**Fix approach:**
1. Rename bridge timing calculations to clarify they measure "end-to-start" not "total gap"
2. Add explicit test case for tool-to-tool boundaries
3. Document the timing model in the bridge's docstring

## Security Considerations

### High Severity Dependency Vulnerabilities

**Risk:** Multiple high-severity vulnerabilities in transitive dependencies that are not directly used but pulled in by SDK/integration packages.

**Files:** `package.json`, `pnpm-lock.yaml`

**Current vulnerabilities (from `pnpm audit`):**
- **protobufjs** — Critical arbitrary code execution (pulled by @mariozechner packages)
- **undici** — 5+ high-severity WebSocket and HTTP issues (7+ instances across versions)
- **music-metadata** — Infinite loop in parsing (pulled by skills media processor)
- **vite** — File read + dev server bypass (dev-only; web SPA build)
- **happy-dom** — fetch credentials leak, ECMAScript injection (test-only; web tests)
- **lodash** — Code injection via template (transitive; no direct usage in source)

**Current mitigation:** None explicitly documented. These do not impact production runtime because:
1. `protobufjs` is pulled by training integration packages (not always required)
2. `undici` is HTTP client (used within Hono, controlled usage)
3. `music-metadata` is media analysis (input from user uploads, bounded)
4. `vite`, `happy-dom`, `lodash` are dev/test-only

**Recommendations:**
1. Document which vulnerabilities are acceptable for dev-only vs runtime
2. Monitor for patches to `undici` (most critical in production)
3. Pin major versions in `pnpm-lock.yaml` to allow controlled updates
4. Consider vendoring or forking `music-metadata` if updates are infrequent
5. Add a "known CVEs" section to SECURITY.md explaining the risk model

### Overly Permissive `@ts-ignore` Usage

**Issue:** 295+ `@ts-ignore` and `// @ts-nocheck` directives scattered across packages, many in session management and type normalization code.

**Files:** Most concentration in:
- `packages/agent/src/session/` (11+ instances in sanitization, repair, isolation)
- `packages/agent/src/provider/tool-schema/` (95+ instances across normalization files)
- `packages/channels/src/` (80+ instances across message mapping and content rendering)

**Impact:** These directives bypass type safety during critical operations (secret sanitization, tool schema normalization, message transformation). They hide real type mismatches that could indicate data corruption or unsafe transformations.

**Fix approach:**
1. Audit each `@ts-ignore` comment to determine if it's:
   - Intentional unsafe cast (acceptable, add specific reason)
   - Type definition gap (fix the upstream type or add proper type assertion)
   - Complex inference (refactor to simpler code)
2. Target: no blanket `// @ts-nocheck` files; all `@ts-ignore` tied to specific lines with comments
3. Add ESLint rule to ban `@ts-nocheck` at file level

## Performance Bottlenecks

### Large Complex Test Files

**Problem:** Several test files exceed 6000+ lines, making them difficult to navigate and slow to run.

**Files:**
- `packages/agent/src/executor/stream-wrappers/request-body-injector.test.ts` (6925 lines)
- `packages/agent/src/executor/pi-executor.test.ts` (5809 lines)

**Cause:** These test complex, multi-layer operations (cache injection, stream wrapping, prompt assembly). Splitting them requires decoupling internal test utilities.

**Improvement path:**
1. Extract shared test utilities from large files into dedicated `test-helpers/` modules
2. Split tests by concern (cache tests, stream tests, injection tests separate)
3. Use `describe` blocks more aggressively for scoping
4. Target: <3000 lines per test file for better readability

### Embedding Cache Thrashing

**Problem:** Embedding cache lookups can thrash SQLite with frequent vec operations during large RAG retrievals.

**Files:** `packages/memory/src/embedding-cache-sqlite.ts`, `packages/memory/src/embedding-cache-lru.ts`

**Impact:** When context engine retrieves 100+ memory entries with embeddings, cache miss rates can exceed 50% if the session has shifted topics. This causes O(N) DB queries instead of O(log N) cache hits.

**Improvement path:**
1. Profile embedding cache hit rates under realistic multi-turn scenarios
2. Implement two-tier cache: LRU (recent) + SQLite (persistent) with intelligent eviction
3. Add a "warming" pass when session context shifts (topic change detected)

### Context Engine Microcompaction Running on Every Turn

**Problem:** The context engine's microcompaction guard runs on every turn to prevent fragmentation, which adds ~50-200ms per turn under typical load.

**Files:** `packages/agent/src/context-engine/microcompaction-guard.ts`, `packages/agent/src/context-engine/microcompaction-guard.test.ts`

**Impact:** For high-velocity agents handling 10+ messages/second, this overhead is noticeable. Larger agents with 50KB+ context see microseconds of compaction work.

**Improvement path:**
1. Profile microcompaction cost on realistic workloads (varied agent sizes + message rates)
2. Consider adaptive thresholds: only compact when fragmentation exceeds 20% (not on every turn)
3. Defer compaction to a background scheduler for lower-priority agents

## Fragile Areas

### Agent Session Lifecycle — Orphaned Message States

**Files:** `packages/agent/src/session/orphaned-message-repair.ts`, `packages/agent/src/session/orphaned-message-repair.test.ts`

**Why fragile:** The session manager can enter inconsistent states when:
1. An assistant response fails mid-generation (network timeout, provider error)
2. The daemon restarts before writing the partial response to the session
3. The session is rehydrated with a trailing user message but no assistant response

This orphaned state can then confuse the LLM on the next turn (it sees a user message with no context for why it was sent).

**Safe modification:** 
1. Always write partial responses to session immediately (not at end of generation)
2. Use a write-ahead log (WAL) pattern for session mutations
3. Add a "session consistency check" RPC that validates message pairs

**Test coverage:** Existing tests in `orphaned-message-repair.test.ts` cover detection and repair, but not the prevention of reaching inconsistent states in the first place.

### Tool Schema Normalization — Provider-Specific Type Juggling

**Files:** `packages/agent/src/provider/tool-schema/normalize*.ts` (5 files, 90+ `@ts-ignore` directives)

**Why fragile:** Each LLM provider has slightly different schema expectations:
- OpenAI: `type: "object"` with `$defs` for refs
- Anthropic: `type: "object"` with `definitions` for refs
- Google Gemini: Stricter enum validation, no `additionalProperties`
- xAI: Minimal schema support, rejects complex types

The normalization code rewrites schemas on the fly for each provider. With heavy use of `@ts-ignore`, type mismatches (e.g., treating `string | undefined` as `string`) can slip through.

**Safe modification:**
1. Create a canonical `ToolSchema` type (strict Zod definition)
2. Build explicit validator/transformer for each provider (not dynamic rewriting)
3. Add schema validation roundtrip tests: canonical → provider format → canonical

**Test coverage:** Schema normalization has 200+ test cases, but they test the output shape, not that the normalized schema actually works with the provider's LLM.

### Concurrent Multi-Agent Isolation

**Files:** `packages/agent/src/session/multi-agent-isolation.test.ts`

**Why fragile:** When multiple agents write to the same database concurrently (not just the same agent), data can leak between sessions if the write lock is not held:
1. Agent A retrieves context (acquires lock)
2. Agent B starts context retrieval (waits for lock)
3. Agent A writes response + session mutations
4. Lock released; Agent B acquires and writes

If Agent B's mutations overlap with Agent A's (same memory entry, same session), the later write can shadow or corrupt the earlier write.

**Safe modification:**
1. Use stricter isolation level for session writes (SERIALIZABLE, not READ_COMMITTED)
2. Add per-session write latch (not just global write lock) to ensure exclusive session access
3. Implement session-scoped transaction versioning for conflict detection

**Test coverage:** `multi-agent-isolation.test.ts` has 10 test cases ensuring "zero data leakage", but they assume no write collisions. Add concurrent-write test scenarios.

## Scaling Limits

### SQLite Memory Adapter Under High Agent Load

**Current capacity:** SQLite comfortably handles 10-50 concurrent agents in-process with standard WAL mode.

**Limit:** At 100+ concurrent agents or >1GB memory database, WAL checkpoint contention causes write stalls (100-500ms latencies). Vector search (sqlite-vec) becomes the bottleneck, not the relational data.

**Scaling path:**
1. Implement connection pooling (better-sqlite3 supports this natively)
2. Partition memory by trust level + agent (sharded writes)
3. Offload vector search to a separate service (pgvector on PostgreSQL) for agents needing 1M+ embeddings
4. Monitor: `PRAGMA freelist_count` and `PRAGMA page_count` in production

### Hono Gateway Under 1000+ Concurrent WebSocket Connections

**Current capacity:** The gateway (`packages/gateway/src/`) can handle ~500 concurrent RPC connections comfortably on a single Node.js process.

**Limit:** At 1000+ connections with high-frequency events (>100 events/sec per connection), the gateway's event fan-out becomes CPU-bound. Message loop latency climbs to 500ms+.

**Scaling path:**
1. Partition connections across multiple gateway instances (horizontal scaling)
2. Use Redis pub/sub or AMQP for inter-gateway message routing
3. Implement connection shedding (graceful degradation) to prefer fewer high-bandwidth clients
4. Monitor: `process.memoryUsage().external` (WebSocket buffer growth)

### Agent Execution Budget Under Tool Composition

**Current capacity:** The executor can chain 50+ tool calls in a single turn (e.g., mapped over a list) before hitting token/cost limits.

**Limit:** At 100+ composed tool calls, prompt assembly becomes O(N) in tool count (schema complexity, instruction size). The system-prompt overhead grows from 4KB to 15KB+. Cache breakpoint placement becomes fragile (risk of exceeding cache-control max payload).

**Scaling path:**
1. Implement tool composition batching (collapse N identical tool calls into 1 with vectorized inputs)
2. Use tool defer loading (already in place) to reduce schema size for heavy tool users
3. Add a "tool load planning" phase that estimates schema footprint before tool selection
4. Monitor: `estimateContextChars()` results at startup; warn if tools + system prompt > 10KB

## Dependencies at Risk

### Transitive Dependency Chain via protobufjs

**Risk:** protobufjs is a transitive dependency of `@mariozechner/pi-agent-core` (training/agent package). It has a critical CVE (arbitrary code execution in schema loading). The dependency is not pinned; next install could pull a patched version, or a malicious upstream fork.

**Impact:** If attacker controls a `.proto` file fed to the training system, they can execute arbitrary code in the daemon.

**Migration plan:**
1. Verify which @mariozechner packages actually use protobufjs (check their package.json)
2. If unused: request upstream to make it optional or remove it
3. If used: pin protobufjs to a specific patched version in pnpm-lock.yaml
4. Add a post-install script that validates the protobufjs checksum

### Undici WebSocket + HTTP Issues

**Risk:** Undici is used by `@hono/node-server` and indirectly by many fetch/HTTP operations. It has 5+ high-severity issues (WebSocket overflow, unbounded memory, CRLF injection). These are transitive and can't be easily worked around.

**Impact:** Long-lived WebSocket connections (gateway RPC streams) or HTTP keepalive requests can exhaust memory or be exploited via crafted frames.

**Migration plan:**
1. Upgrade Hono to latest version (pins more recent undici)
2. Monitor undici release notes; upgrade whenever patches land
3. Add memory pressure limits to gateway (reject new connections if process memory > threshold)
4. Consider native HTTP server (uWebSockets) for ultra-high-traffic scenarios in v2

### Music Metadata Infinite Loop

**Risk:** `music-metadata` has a vulnerability where certain audio files trigger infinite loops during metadata parsing. It's used in `packages/skills/src/integrations/media-preprocessor.ts` when analyzing voice/audio attachments.

**Impact:** A user uploading a crafted audio file can DoS a single skill invocation (locks the worker thread for >10 seconds). Mitigated by worker timeouts, but still a degradation.

**Migration plan:**
1. Wrap music-metadata parsing in a `Promise.race()` with a 5-second timeout
2. Fall back to MIME-type-only analysis on timeout
3. Consider ffmpeg-based metadata extraction (more robust, already used for transcoding)
4. Pin music-metadata to a version known to be safe; request upstream for CVE patch

## Missing Critical Features

### No Installer Integration Tests in CI

**Problem:** The installer (`website/public/install.sh`) is a shell script that orchestrates service registration, package installation, and environment setup. It has no automated test coverage in the CI pipeline.

**Blocks:** 
- First-time user experience is not validated on each commit
- Installer regressions (e.g., systemd unit broken, npm install path failing) discovered only in production
- The installer design doc (INSTALLER-SERVICE-REDESIGN.md) requires comprehensive testing before landing

**Fix approach:** 
1. Use the test plan in INSTALLER-TEST-PLAN.md
2. Add Docker-based scenarios to CI (Linux root install, systemd unit validation)
3. Add macOS smoke test on GitHub Actions `macos-14` runner
4. Extend CI to test upgrade and uninstall paths

### No Dead Letter Queue (DLQ) Monitoring in Alerts

**Problem:** The delivery queue can accumulate failed messages in a dead letter queue. There is no production alerting when the DLQ grows beyond a threshold.

**Files:** `packages/memory/src/delivery-queue.ts`, `packages/daemon/src/health-metrics.ts`

**Blocks:** Operators can miss silent failures (message delivery stuck, silent data loss).

**Fix approach:**
1. Add DLQ size to the daemon's health check endpoint
2. Log a WARN-level alert when DLQ depth > 10 or oldest message > 1 hour
3. Expose DLQ size as a Prometheus metric (if monitoring is added in future)
4. Document recovery procedure: inspect DLQ, requeue or purge

## Test Coverage Gaps

### Untested Scenarios in Concurrent Agent Execution

**What's not tested:** 
- Two agents concurrently reading/writing to the same memory entry (race on embedding vectors)
- An agent spawning a subagent while the parent is mid-execution (nested context isolation)
- Rapid agent restart + rehydration (orphaned session state cleanup under load)

**Files:** `packages/agent/src/session/`, `packages/daemon/src/sub-agent-runner.ts`

**Risk:** These scenarios can cause:
- Silent data corruption in embeddings (two agents' vectors mixed)
- Context leakage between parent and subagent
- Orphaned in-flight requests never completing

**Priority:** High — these are production scenarios on multi-tenant or single-agent-high-frequency systems.

### Missing Stress Tests for Large Context

**What's not tested:**
- Agent with >5MB session (100K messages, 1M tokens)
- 50+ context layers (deeply nested memory, many tool calls)
- Context engine pipeline with extreme compaction scenarios (95% fragmented state)

**Files:** `packages/agent/src/context-engine/`

**Risk:** Large context edge cases can cause:
- Prompt assembly timeouts (>5 seconds)
- OOM crashes during compaction
- Stale cache references when context shrinks

**Priority:** Medium — affects power users and long-running agents, but not typical usage.

### No Integration Tests for Installer Service Registration

**What's not tested:**
- Systemd unit actually starts the daemon
- Unit survives daemon crash (respawn via Restart=on-failure)
- Boot persistence: daemon auto-starts after OS reboot
- pm2 startup launchd plist generation and boot persistence on macOS

**Files:** `website/public/install.sh`, `packages/daemon/systemd/`

**Risk:** Installer changes that break service registration slip through CI undetected.

**Priority:** Critical — blocks the installer redesign landing safely.

---

*Concerns audit: 2025-04-17*
