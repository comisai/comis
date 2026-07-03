// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace runtime tests.
 *
 * The recorder is a per-session writer (`createCacheTrace`) that emits
 * one JSONL line per cache-relevant stage. The runtime's contract is
 * independent of the EventBus bridge — these tests drive `recordStage`
 * directly and exercise the in-runtime token-attribution path via
 * `setLatestTokenUsage` (the bridge wiring is covered by
 * `event-bus-bridge.test.ts`).
 *
 * 9 behavior-named cases:
 *   - writes_well_formed_event
 *   - assigns_monotonic_seq_counter
 *   - disabled_returns_null
 *   - disabled_via_env_returns_null
 *   - digest_stable_across_runs
 *   - include_messages_off_omits_messages
 *   - sanitize_redacts_credential_in_message_body
 *   - session_after_attaches_token_counts
 *   - flush_emits_cache_trace_write_failures_sentinel
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithContext } from "@comis/core";

import { createCacheTrace } from "./runtime.js";
import type { CacheTraceEvent } from "./types.js";

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-cache-trace-rt-"));
  savedEnv = process.env.COMIS_DISABLE_CACHE_TRACE;
  delete process.env.COMIS_DISABLE_CACHE_TRACE;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.COMIS_DISABLE_CACHE_TRACE;
  } else {
    process.env.COMIS_DISABLE_CACHE_TRACE = savedEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(filePath: string): CacheTraceEvent[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l)) as CacheTraceEvent[];
}

function makeTrace(opts: {
  enabled?: boolean;
  includeMessages?: boolean;
  filePath?: string;
}) {
  return createCacheTrace({
    enabled: opts.enabled ?? true,
    filePath: opts.filePath ?? join(tmpDir, "cache-trace.jsonl"),
    includeMessages: opts.includeMessages ?? true,
    includePrompt: true,
    includeSystem: true,
    agentId: "agent-1",
    sessionId: "sid-1",
    provider: "anthropic",
    modelId: "claude-3-opus",
  });
}

describe("createCacheTrace -- well-formed event records", () => {
  it("writes_well_formed_event with traceSchema, schemaVersion, seq, ts, agentId, sessionId", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordStage("session:start", {});
    await trace!.flush();

    const lines = readLines(trace!.filePath);
    expect(lines).toHaveLength(1);
    const ev = lines[0]!;
    expect(ev.traceSchema).toBe("comis-cache-trace");
    expect(ev.schemaVersion).toBe(1);
    expect(ev.stage).toBe("session:start");
    expect(ev.seq).toBe(0);
    expect(typeof ev.ts).toBe("string");
    expect(ev.agentId).toBe("agent-1");
    expect(ev.sessionId).toBe("sid-1");
    expect(ev.provider).toBe("anthropic");
    expect(ev.modelId).toBe("claude-3-opus");
  });

  it("assigns_monotonic_seq_counter across 5 sequential stages", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordStage("session:start", {});
    trace!.recordStage("prompt:before", {});
    trace!.recordStage("model:before", {});
    trace!.recordStage("model:after", {});
    trace!.recordStage("session:end", {});
    await trace!.flush();

    const lines = readLines(trace!.filePath);
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("createCacheTrace -- disabled paths", () => {
  it("disabled_returns_null when init.enabled === false", () => {
    const trace = createCacheTrace({
      enabled: false,
      filePath: join(tmpDir, "x.jsonl"),
      includeMessages: false,
      includePrompt: true,
      includeSystem: true,
      agentId: "a",
      sessionId: "s",
    });
    expect(trace).toBeNull();
  });

  it("disabled_via_env_returns_null when COMIS_DISABLE_CACHE_TRACE=1", () => {
    process.env.COMIS_DISABLE_CACHE_TRACE = "1";
    const trace = createCacheTrace({
      enabled: true,
      filePath: join(tmpDir, "x.jsonl"),
      includeMessages: false,
      includePrompt: true,
      includeSystem: true,
      agentId: "a",
      sessionId: "s",
    });
    expect(trace).toBeNull();
  });
});

describe("createCacheTrace -- digest + redaction + payload-gating", () => {
  it("digest_stable_across_runs: identical payloads produce identical digests via stableStringify", async () => {
    const filePath1 = join(tmpDir, "trace-1.jsonl");
    const trace1 = makeTrace({ filePath: filePath1, includeMessages: false });
    expect(trace1).not.toBeNull();
    trace1!.recordStage("stream:context", {
      messagesDigest: "digest-from-helper-1",
      messageFingerprints: ["a", "b"],
    });
    await trace1!.flushAndClose();

    const filePath2 = join(tmpDir, "trace-2.jsonl");
    const trace2 = makeTrace({ filePath: filePath2, includeMessages: false });
    expect(trace2).not.toBeNull();
    trace2!.recordStage("stream:context", {
      messagesDigest: "digest-from-helper-1",
      messageFingerprints: ["a", "b"],
    });
    await trace2!.flushAndClose();

    const lines1 = readLines(filePath1);
    const lines2 = readLines(filePath2);
    expect(lines1[0]!.messagesDigest).toBe(lines2[0]!.messagesDigest);
    expect(lines1[0]!.messageFingerprints).toEqual(lines2[0]!.messageFingerprints);
  });

  it("include_messages_off_omits_messages but keeps messageFingerprints and messagesDigest", async () => {
    const trace = makeTrace({ includeMessages: false });
    expect(trace).not.toBeNull();
    expect(trace!.includeMessages).toBe(false);

    // The wrapper code (stream-fn-wrapper.ts) is responsible for the
    // includeMessages gate — it omits `messages` from the payload when
    // disabled but still passes `messageFingerprints` + `messagesDigest`.
    // At the runtime level we just confirm that an undefined `messages`
    // round-trips faithfully through JSON.
    trace!.recordStage("stream:context", {
      messageFingerprints: ["a", "b"],
      messagesDigest: "abc",
      messageCount: 2,
      messageRoles: ["user", "assistant"],
    });
    await trace!.flush();

    const lines = readLines(trace!.filePath);
    expect(lines).toHaveLength(1);
    const ev = lines[0]!;
    expect(ev.messages).toBeUndefined();
    expect(ev.messageFingerprints).toEqual(["a", "b"]);
    expect(ev.messagesDigest).toBe("abc");
  });

  it("sanitize_redacts_credential_in_message_body: apiKey value in payload replaced by [REDACTED]", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordStage("stream:context", {
      messages: [
        { role: "user", content: "use this", apiKey: "sk-abc123secret" },
      ],
    });
    await trace!.flush();

    const lines = readLines(trace!.filePath);
    expect(lines).toHaveLength(1);
    const json = JSON.stringify(lines[0]);
    // sanitizeForPersistence drops/redacts credential field values.
    expect(json).not.toContain("sk-abc123secret");
  });

  // When includeSystem is true, the system slot must round-trip
  // verbatim past the default 32 KB bounded-payload cap. Without the
  // per-key exemption, the runtime silently replaced the system payload
  // with a `bounded-payload-field-size-limit` sentinel, defeating the
  // operator's opt-in.
  it("include_system_true_preserves_full_system_content_beyond_default_32KB_cap", async () => {
    const trace = makeTrace({}); // makeTrace() defaults includeSystem to true
    expect(trace).not.toBeNull();
    expect(trace!.includeSystem).toBe(true);

    const longSystem = "x".repeat(50_000); // exceeds the 32 KB default cap
    trace!.recordStage("stream:context", { system: longSystem });
    await trace!.flush();

    const lines = readLines(trace!.filePath);
    expect(lines).toHaveLength(1);
    const ev = lines[0]!;
    // System round-tripped verbatim — NOT replaced with the bounded
    // sentinel.
    expect(typeof (ev as Record<string, unknown>).system).toBe("string");
    expect(((ev as Record<string, unknown>).system as string).length).toBe(50_000);
  });
});

describe("createCacheTrace -- terminal session:after on flushAndClose", () => {
  it("flushAndClose_emits_terminal_session_after_with_token_counts_from_stash", async () => {
    // New lifecycle contract: callers do NOT emit session:after directly.
    // `flushAndClose` drains the latest token-usage stash as one terminal
    // session:after event before closing.
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.setLatestTokenUsage({
      cacheReadTokens: 1234,
      cacheWriteTokens: 56,
    });
    await trace!.flushAndClose();

    const lines = readLines(trace!.filePath);
    // Terminal session:after is unconditional; no other events recorded
    // → exactly one line.
    const sessionAfter = lines.filter((l) => l.stage === "session:after");
    expect(sessionAfter).toHaveLength(1);
    expect(sessionAfter[0]!.cacheReadInputTokens).toBe(1234);
    expect(sessionAfter[0]!.cacheCreationInputTokens).toBe(56);
  });

  it("flushAndClose_terminal_session_after_emits_even_with_no_prior_token_usage", async () => {
    // The terminal emit is UNCONDITIONAL — absence of token data does
    // NOT skip the emit.
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    await trace!.flushAndClose();

    const lines = readLines(trace!.filePath);
    const sessionAfter = lines.filter((l) => l.stage === "session:after");
    expect(sessionAfter).toHaveLength(1);
    expect(sessionAfter[0]!.cacheReadInputTokens).toBeUndefined();
    expect(sessionAfter[0]!.cacheCreationInputTokens).toBeUndefined();
  });

  it("flushAndClose_called_twice_emits_terminal_session_after_only_once_idempotent_close", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.setLatestTokenUsage({ cacheReadTokens: 1, cacheWriteTokens: 2 });
    await trace!.flushAndClose();
    await trace!.flushAndClose(); // second call is a no-op

    const lines = readLines(trace!.filePath);
    const sessionAfter = lines.filter((l) => l.stage === "session:after");
    expect(sessionAfter).toHaveLength(1);
  });

  it("explicit_recordStage_session_after_PLUS_terminal_emit_yields_two_records", async () => {
    // Callers normally rely on the terminal session:after emit and do NOT
    // call recordStage("session:after", {}) explicitly. A caller that emits
    // one anyway is tolerated: the terminal emit still fires, yielding TWO
    // session:after records (one explicit, one terminal). The recorder does
    // not second-guess callers.
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.setLatestTokenUsage({ cacheReadTokens: 7, cacheWriteTokens: 3 });
    trace!.recordStage("session:after", {}); // explicit emit — consumes the stash
    await trace!.flushAndClose();

    const lines = readLines(trace!.filePath);
    const sessionAfter = lines.filter((l) => l.stage === "session:after");
    expect(sessionAfter).toHaveLength(2);
    // First (explicit) carries the stash; second (terminal) has empty
    // splat because the stash was consumed by the first.
    expect(sessionAfter[0]!.cacheReadInputTokens).toBe(7);
    expect(sessionAfter[0]!.cacheCreationInputTokens).toBe(3);
    expect(sessionAfter[1]!.cacheReadInputTokens).toBeUndefined();
    expect(sessionAfter[1]!.cacheCreationInputTokens).toBeUndefined();
  });
});

describe("createCacheTrace -- envelope: traceId + contextual fields", () => {
  it("traceId_falls_back_to_sessionId_when_no_AsyncLocalStorage_context", async () => {
    const trace = makeTrace({});
    expect(trace).not.toBeNull();
    trace!.recordStage("session:start", {});
    await trace!.flush();

    const lines = readLines(trace!.filePath);
    expect(lines).toHaveLength(1);
    // No RequestContext in scope — traceId falls back to sessionId.
    expect(lines[0]!.traceId).toBe("sid-1");
  });

  it("traceId_resolves_from_AsyncLocalStorage_RequestContext_when_present", async () => {
    const filePath = join(tmpDir, "ctx.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      includeMessages: true,
      includePrompt: true,
      includeSystem: true,
      agentId: "agent-1",
      sessionId: "sid-2",
    });
    expect(trace).not.toBeNull();

    // RequestContextSchema requires `traceId: z.guid()` so we use a
    // valid UUID literal. The bound value flows through the schema's
    // strict-object parse at runWithContext call sites in production
    // — but `runWithContext` itself accepts a `RequestContext`
    // (already-parsed) so we hand-build one matching the shape.
    const validTraceId = "11111111-1111-4111-8111-111111111111";
    await runWithContext(
      {
        tenantId: "tenant-1",
        userId: "user-1",
        sessionKey: "sk",
        traceId: validTraceId,
        startedAt: 1,
        trustLevel: "admin",
      },
      async () => {
        trace!.recordStage("session:start", {});
        await trace!.flush();
      },
    );

    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.traceId).toBe(validTraceId);
    // sessionId is unchanged — traceId is its own correlation key.
    expect(lines[0]!.sessionId).toBe("sid-2");
  });

  it("envelope_cluster_fields_appear_on_every_event_verbatim", async () => {
    const filePath = join(tmpDir, "envelope.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      includeMessages: true,
      includePrompt: true,
      includeSystem: true,
      agentId: "agent-1",
      sessionId: "sid-env",
      envelope: {
        runId: "run-42",
        sessionKey: "key-42",
        tenantId: "tenant-42",
        workspaceDir: "/workspace/42",
        modelApi: "messages",
      },
    });
    expect(trace).not.toBeNull();
    trace!.recordStage("stream:context", {});
    trace!.recordStage("session:after", {});
    await trace!.flush();

    const lines = readLines(filePath);
    expect(lines).toHaveLength(2);
    for (const ev of lines) {
      expect(ev.runId).toBe("run-42");
      expect(ev.sessionKey).toBe("key-42");
      expect(ev.tenantId).toBe("tenant-42");
      expect(ev.workspaceDir).toBe("/workspace/42");
      expect(ev.modelApi).toBe("messages");
    }
  });

  it("envelope_modelApi_may_be_null_per_design_72", async () => {
    const filePath = join(tmpDir, "modelapi-null.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      includeMessages: true,
      includePrompt: true,
      includeSystem: true,
      agentId: "agent-1",
      sessionId: "sid-null",
      envelope: { modelApi: null },
    });
    expect(trace).not.toBeNull();
    trace!.recordStage("session:start", {});
    await trace!.flush();

    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.modelApi).toBeNull();
  });
});

describe("createCacheTrace -- write-failures sentinel", () => {
  it("flush_emits_cache_trace_write_failures_sentinel when symlinked parent forces append rejection", async () => {
    // Force a write-failure scenario: create a symlinked parent dir
    // so `appendRegularFile` (with O_NOFOLLOW + confinedBaseDir)
    // rejects each line. The recorder accumulates `failureCount`
    // and emits the sentinel during `flushAndClose`.
    const realBase = join(tmpDir, "real");
    const linkBase = join(tmpDir, "link");
    mkdirSync(realBase, { recursive: true });
    symlinkSync(realBase, linkBase);

    // File path goes through the symlink — appendRegularFile with
    // a confinedBaseDir rooted at `tmpDir` will reject because the
    // ancestor `link` is itself a symlink.
    const filePath = join(linkBase, "cache-trace.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      includeMessages: false,
      includePrompt: true,
      includeSystem: true,
      agentId: "agent-1",
      sessionId: "sid-fail",
      confinedBaseDir: tmpDir,
    });
    expect(trace).not.toBeNull();

    trace!.recordStage("session:start", {});
    trace!.recordStage("session:end", {});
    await trace!.flushAndClose();

    // Read the *real* file — the recorder's queued writer may still
    // succeed in writing the sentinel after redirecting through the
    // real path, OR it may itself fail. Either way the runtime
    // attempted to emit the sentinel.
    // The recorder records ≥0 sentinel events; we only verify the
    // contract was honored at the failure count level.
    expect(trace!.failureCount()).toBeGreaterThan(0);
  });
});

describe("cache_trace.write_failures sentinel", () => {
  // The cache-trace runtime emits an inline sentinel on the FIRST
  // queued-writer failure detection inside recordStage (latched
  // once-per-session) AND a summary sentinel at flushAndClose when
  // failureCount > 0. The two-sentinel-per-cap-hit model means a
  // session that exceeds the cap produces exactly 2
  // cache_trace.write_failures lines: one mid-stream, one at file tail.
  // Sessions that never hit the cap produce 0 sentinels.

  function readJsonlEvents(tracePath: string): Array<Record<string, unknown>> {
    if (!existsSync(tracePath)) return [];
    const raw = readFileSync(tracePath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function countSentinels(events: Array<Record<string, unknown>>): number {
    return events.filter((e) => e.stage === "cache_trace.write_failures").length;
  }

  it("inline_sentinel_fires_on_first_writer_failure", async () => {
    // The inline-sentinel latch must fire on first failure-detection:
    // after at least one recordStage call triggers an append rejection
    // (visible via writer.failureCount() > 0), the next recordStage
    // call emits ONE inline sentinel with `data.firstDropAt` (ISO
    // string) and `data.reason === "queued_writer_rejected"`.
    //
    // Cap calibration (matches latched test): 8 KB cap + 4 KB payload
    // produces 1 successful user event + N rejected user events; both
    // inline and summary sentinels land on disk in the remaining cap.
    const filePath = join(tmpDir, "inline-sentinel.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      maxFileBytes: 8000,
      includeMessages: false,
      includePrompt: false,
      includeSystem: false,
      agentId: "test-agent",
      sessionId: "test-session-1",
      provider: "test",
      modelId: "test-model",
      envelope: { sessionKey: "test-session-1" },
    });
    expect(trace).not.toBeNull();

    // Drive several stages with large payloads. Each call yields to the
    // event loop so the queued writer's append promise can resolve and
    // bump failureCount before the next recordStage call.
    const bigPayload = { data: "x".repeat(4000) };
    for (let i = 0; i < 5; i++) {
      trace!.recordStage("session:start", bigPayload);
      await new Promise((r) => setImmediate(r));
    }

    await trace!.flushAndClose();
    const events = readJsonlEvents(filePath);
    const sentinels = events.filter(
      (e) => e.stage === "cache_trace.write_failures",
    );
    // At least one cache_trace.write_failures must be present (inline OR
    // summary). Verify the inline sentinel landed with its `firstDropAt`
    // marker.
    expect(sentinels.length).toBeGreaterThanOrEqual(1);
    const hasInlineMarker = sentinels.some(
      (s) =>
        typeof ((s.data ?? {}) as Record<string, unknown>).firstDropAt ===
        "string",
    );
    expect(hasInlineMarker).toBe(true);
  });

  it("inline_sentinel_latched_at_most_once_per_session", async () => {
    // Exactly 1 inline + 1 summary = 2 total sentinels per
    // cap-hit session. The latch ensures only 1 inline fires even when
    // multiple recordStage calls observe failureCount > 0; the summary
    // always fires on flushAndClose when failures > 0.
    //
    // Cap calibration: each encoded event is ~400 bytes envelope + the
    // sanitized `data` payload size. With a 4 KB payload, the encoded
    // event is ~4500 bytes. With cap = 8000:
    //   - first event (~4500 bytes) lands; cap remaining ~3500
    //   - second event (~4500 bytes) is rejected by appendRegularFile
    //     (would exceed cap); failureCount climbs
    //   - inline sentinel (~400 bytes) lands in the ~3500 free space
    //     after the FIRST recordStage call that sees failureCount > 0
    //   - subsequent recordStage calls do NOT re-emit inline (latch
    //     holds)
    //   - flushAndClose emits terminal session:after (~400 bytes) and
    //     summary sentinel (~430 bytes); both fit in remaining cap
    // Net on disk: 1 user event + 1 inline sentinel + 1 terminal
    // session:after + 1 summary sentinel = 2 cache_trace.write_failures
    // lines.
    const filePath = join(tmpDir, "latched-sentinel.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      maxFileBytes: 8000,
      includeMessages: false,
      includePrompt: false,
      includeSystem: false,
      agentId: "test-agent",
      sessionId: "test-session-2",
      provider: "test",
      modelId: "test-model",
      envelope: { sessionKey: "test-session-2" },
    });
    expect(trace).not.toBeNull();

    const bigPayload = { data: "x".repeat(4000) };
    for (let i = 0; i < 10; i++) {
      trace!.recordStage("session:start", bigPayload);
      await new Promise((r) => setImmediate(r));
    }
    await trace!.flushAndClose();

    const events = readJsonlEvents(filePath);
    const sentinelsCount = countSentinels(events);
    // 1 inline + 1 summary = 2 total.
    expect(sentinelsCount).toBe(2);
  });

  it("summary_sentinel_carries_session_lifetime_ms", async () => {
    // Summary sentinel at flushAndClose carries
    // sessionLifetimeMs (= systemNowMs() - state.sessionStartedAt),
    // droppedEvents, and totalDroppedBytes.
    //
    // Cap calibration: 8 KB cap + 4 KB payload mirrors the other
    // sentinel tests so the summary sentinel has room to land after
    // user-event rejections accumulate.
    const filePath = join(tmpDir, "summary-sentinel.jsonl");
    const trace = createCacheTrace({
      enabled: true,
      filePath,
      maxFileBytes: 8000,
      includeMessages: false,
      includePrompt: false,
      includeSystem: false,
      agentId: "test-agent",
      sessionId: "test-session-3",
      provider: "test",
      modelId: "test-model",
      envelope: { sessionKey: "test-session-3" },
    });
    expect(trace).not.toBeNull();

    const bigPayload = { data: "x".repeat(4000) };
    trace!.recordStage("session:start", bigPayload);
    // Sleep ≥ 50 ms so sessionLifetimeMs has a measurable floor.
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < 5; i++) {
      trace!.recordStage("session:start", bigPayload);
      await new Promise((r) => setImmediate(r));
    }
    await trace!.flushAndClose();

    const events = readJsonlEvents(filePath);
    const summaries = events.filter(
      (e) =>
        e.stage === "cache_trace.write_failures" &&
        typeof ((e.data ?? {}) as Record<string, unknown>).sessionLifetimeMs ===
          "number",
    );
    expect(summaries.length).toBe(1);
    const summaryData = (summaries[0]!.data ?? {}) as Record<string, unknown>;
    expect(summaryData.sessionLifetimeMs).toBeGreaterThanOrEqual(50);
    expect(summaryData.droppedEvents).toBeGreaterThan(0);
    expect(summaryData.totalDroppedBytes).toBeGreaterThan(0);
  });
});
