// SPDX-License-Identifier: Apache-2.0
/**
 * obs.trace.{search, tail, export} handler tests.
 *
 * Tests:
 *   1. bindObsTraceHandlers returns an object with exactly three keys
 *   2. search with _trustLevel "user" throws "Admin"
 *   3. search with _trustLevel "admin" + valid params resolves to { rows: [...] }
 *   4. search by messageId consults LRU; seeded LRU returns rows tagged with traceId
 *   5. tail with { chatId: "" } causes a zod parse error
 *   6. export with admin trustLevel invokes the injected exportTrajectoryBundle mock
 *   7. export with _trustLevel "user" throws "Admin"
 *   8. LRU cap at 1024 — populating 1100 entries leaves exactly 1024
 *   9. seedMessageIdLru reads session-index JSONL and populates LRU
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bindObsTraceHandlers, seedMessageIdLru, __resetLru } from "./obs-trace.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

// Minimal deps factory — only trace-relevant fields needed.
function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return {
    diagnosticCollector: {
      getRecent: vi.fn().mockReturnValue([]),
      getCounts: vi.fn().mockReturnValue({ usage: 0, webhook: 0, message: 0, session: 0 }),
      reset: vi.fn(),
      prune: vi.fn().mockReturnValue(0),
      dispose: vi.fn(),
    },
    billingEstimator: {
      byProvider: vi.fn().mockReturnValue([]),
      byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      total: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      usage24h: vi.fn().mockReturnValue(Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0 }))),
    },
    channelActivityTracker: {
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      getStale: vi.fn().mockReturnValue([]),
      recordActivity: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    deliveryTracer: {
      getRecent: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({ total: 0, attempted: 0, successes: 0, failures: 0, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 }),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    agents: {},
    ...overrides,
  } as unknown as ObsHandlerDeps;
}

describe("bindObsTraceHandlers", () => {
  beforeEach(() => {
    // Reset LRU between tests so LRU state does not leak across test runs.
    __resetLru();
  });

  // Test 1: returns exactly three handler keys
  it("returns_three_handler_keys", () => {
    const handlers = bindObsTraceHandlers(makeDeps());
    const keys = Object.keys(handlers).sort();
    expect(keys).toEqual(["obs.trace.export", "obs.trace.search", "obs.trace.tail"]);
  });

  // Test 2: non-admin search throws
  it("search_throws_for_non_admin", async () => {
    const handlers = bindObsTraceHandlers(makeDeps());
    await expect(
      handlers["obs.trace.search"]!({ _trustLevel: "user" }),
    ).rejects.toThrow(/Admin/i);
  });

  // Test 3: admin search with valid params resolves to { rows: [...] }
  it("search_resolves_rows_for_admin", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-test-"));
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir: tmpDir }));
    const result = await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      traceId: "trace-xyz",
    }) as { rows: unknown[] };
    expect(Array.isArray(result.rows)).toBe(true);
  });

  // Test 4: messageId LRU lookup — seeded LRU returns rows tagged with traceId
  it("search_by_messageId_uses_lru", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-test-"));
    // Create the logs subdirectory and a session-index file with a turn_completed
    // event that maps msg-1 -> t1/s1.
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const indexFile = path.join(logsDir, `session-index.${today}.jsonl`);
    const turnEvent = JSON.stringify({
      traceSchema: "comis-session-index",
      schemaVersion: 1,
      event: "turn_completed",
      ts: new Date().toISOString(),
      sessionId: "s1",
      traceId: "t1",
      messageId: "msg-1",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      lastError: null,
    });
    fs.writeFileSync(indexFile, turnEvent + "\n");

    // Seed LRU from the file.
    seedMessageIdLru(tmpDir);

    // Now search by messageId — should find it via LRU and return the row.
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir: tmpDir }));
    const result = await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      messageId: "msg-1",
    }) as { rows: Array<Record<string, unknown>> };
    expect(Array.isArray(result.rows)).toBe(true);
    // The row came from the index file and has traceId "t1"
    expect(result.rows.some((r) => r.traceId === "t1")).toBe(true);
  });

  it("search by messageId scans the persisted index when the live LRU was not seeded", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-live-message-"));
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const indexFile = path.join(logsDir, `session-index.${today}.jsonl`);
    fs.writeFileSync(indexFile, `${JSON.stringify({
      traceSchema: "comis-session-index",
      schemaVersion: 1,
      event: "turn_completed",
      ts: new Date().toISOString(),
      sessionId: "live-session",
      traceId: "live-trace",
      messageId: "live-message",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      lastError: null,
    })}\n`);

    const handlers = bindObsTraceHandlers(makeDeps({ dataDir: tmpDir }));
    const result = await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      messageId: "live-message",
    }) as { rows: Array<Record<string, unknown>> };

    expect(result.rows.some((row) => row.traceId === "live-trace")).toBe(true);
  });

  // Test 5: tail with empty chatId causes zod parse error
  it("tail_throws_on_empty_chatId", async () => {
    const handlers = bindObsTraceHandlers(makeDeps());
    await expect(
      handlers["obs.trace.tail"]!({ _trustLevel: "admin", chatId: "" }),
    ).rejects.toThrow();
  });

  // Test 6: export admin invokes injected exportTrajectoryBundle mock
  it("export_invokes_mock_when_admin", async () => {
    const mockExport = vi.fn().mockResolvedValue({
      ok: true,
      value: { bundleDir: "/tmp/bundle", manifest: {} },
    });
    const handlers = bindObsTraceHandlers(
      makeDeps({ exportTrajectoryBundle: mockExport as never }),
    );
    const result = await handlers["obs.trace.export"]!({
      _trustLevel: "admin",
      sessionId: "s1",
    }) as { bundlePath: string };
    expect(mockExport).toHaveBeenCalledOnce();
    expect(result.bundlePath).toBe("/tmp/bundle");
  });

  // Test 7: non-admin export throws
  it("export_throws_for_non_admin", async () => {
    const handlers = bindObsTraceHandlers(makeDeps());
    await expect(
      handlers["obs.trace.export"]!({ _trustLevel: "user", sessionId: "s1" }),
    ).rejects.toThrow(/Admin/i);
  });

  // Test 8: LRU cap at 1024 — 1100 entries leaves exactly 1024
  it("lru_cap_evicts_oldest_at_1024", async () => {
    // Seed 1100 distinct messageIds via seedMessageIdLru using a synthetic
    // JSONL file. We manipulate the LRU directly via seedMessageIdLru by
    // creating a file with 1100 turn_completed entries.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-lru-"));
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const indexFile = path.join(logsDir, `session-index.${today}.jsonl`);

    const lines: string[] = [];
    for (let i = 0; i < 1100; i++) {
      lines.push(
        JSON.stringify({
          event: "turn_completed",
          messageId: `msg-${i}`,
          traceId: `trace-${i}`,
          sessionId: "s1",
          ts: new Date().toISOString(),
        }),
      );
    }
    fs.writeFileSync(indexFile, lines.join("\n") + "\n");

    seedMessageIdLru(tmpDir);

    // Import the LRU size check via searching with 1100 messageIds.
    // The LRU is module-private; we verify the cap indirectly by checking
    // that the oldest entry (msg-0) has been evicted while a recent one has not.
    // The LRU is populated in order 0..1099; at cap 1024, entries 0..75 are evicted.
    // The way to verify cap is to create handlers with a dataDir that has NO files
    // so the scan fallback returns nothing (LRU miss = no rows), and check that
    // a recent messageId returns a row while an old one doesn't.
    // We create a second tmpDir with no index files for the handler:
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-empty-"));

    const handlers = bindObsTraceHandlers(makeDeps({ dataDir: emptyDir }));

    // Use the exported LRU size validator — we instead check lru size via a
    // side-channel: searching for msg-0 (evicted) returns no rows from the
    // empty dataDir, whereas msg-1099 (still in LRU) would trigger a scan
    // of emptyDir (also no rows). The real size validation needs the exported
    // __lruSize helper or we count indirect evidence.
    // Export __lruSize alongside __resetLru. We'll import it and assert directly.
    const { __lruSize } = await import("./obs-trace.js");
    expect(__lruSize()).toBe(1024);
  });

  // -------------------------------------------------------------------------
  // D9: default-exclude synthetic rows (the 3 scan helpers) + includeSynthetic
  // -------------------------------------------------------------------------

  /**
   * Seed a tmp dataDir with today's session-index JSONL containing the given
   * pre-serialized rows. Returns the dataDir.
   */
  function seedIndex(rows: Array<Record<string, unknown>>): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-synth-"));
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const indexFile = path.join(logsDir, `session-index.${today}.jsonl`);
    fs.writeFileSync(indexFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return tmpDir;
  }

  it("search by traceId excludes a synthetic row by default and keeps the runtime row", async () => {
    const dataDir = seedIndex([
      { traceId: "shared-trace", sessionId: "synthetic-s", synthetic: true, ts: new Date().toISOString() },
      { traceId: "shared-trace", sessionId: "runtime-s", ts: new Date().toISOString() },
    ]);
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir }));
    const result = (await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      traceId: "shared-trace",
    })) as { rows: Array<Record<string, unknown>> };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.sessionId).toBe("runtime-s");
  });

  it("search by traceId with includeSynthetic:true returns BOTH the synthetic and runtime rows", async () => {
    const dataDir = seedIndex([
      { traceId: "shared-trace", sessionId: "synthetic-s", synthetic: true, ts: new Date().toISOString() },
      { traceId: "shared-trace", sessionId: "runtime-s", ts: new Date().toISOString() },
    ]);
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir }));
    const result = (await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      traceId: "shared-trace",
      includeSynthetic: true,
    })) as { rows: Array<Record<string, unknown>> };
    expect(result.rows).toHaveLength(2);
  });

  it("search treats a string 'true' synthetic field as NON-synthetic (strict === true only)", async () => {
    // Untrusted JSONL: only a real boolean true triggers exclusion — a string
    // must never be truthy-coerced into an exclusion.
    const dataDir = seedIndex([
      { traceId: "strict-trace", sessionId: "string-flag-s", synthetic: "true", ts: new Date().toISOString() },
    ]);
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir }));
    const result = (await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      traceId: "strict-trace",
    })) as { rows: Array<Record<string, unknown>> };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.sessionId).toBe("string-flag-s");
  });

  it("search by since/where excludes a synthetic row by default (the ByFilter helper)", async () => {
    const dataDir = seedIndex([
      { traceId: "t-a", sessionId: "synthetic-s", synthetic: true, ts: new Date().toISOString() },
      { traceId: "t-b", sessionId: "runtime-s", ts: new Date().toISOString() },
    ]);
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir }));
    const result = (await handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      since: "1h",
    })) as { rows: Array<Record<string, unknown>> };
    expect(result.rows.every((r) => r.sessionId !== "synthetic-s")).toBe(true);
    expect(result.rows.some((r) => r.sessionId === "runtime-s")).toBe(true);
  });

  it("tail by chatId excludes a synthetic row by default (the ByChat helper, safe default)", async () => {
    // obs.trace.tail (ObsTraceTailContract) carries NO includeSynthetic opt-in,
    // so the ByChat helper always default-excludes synthetic rows here — the
    // safe posture (test telemetry never surfaces on a live tail).
    const dataDir = seedIndex([
      { chatId: "chat-1", sessionId: "synthetic-s", synthetic: true, ts: new Date().toISOString() },
      { chatId: "chat-1", sessionId: "runtime-s", ts: new Date().toISOString() },
    ]);
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir }));
    const sinceMs = Date.now() - 60_000;

    const excluded = (await handlers["obs.trace.tail"]!({
      _trustLevel: "admin",
      chatId: "chat-1",
      sinceMs,
    })) as { events: Array<Record<string, unknown>> };
    expect(excluded.events.every((e) => e.sessionId !== "synthetic-s")).toBe(true);
    expect(excluded.events.some((e) => e.sessionId === "runtime-s")).toBe(true);
  });

  // Test 9: seedMessageIdLru reads session-index files and populates LRU
  it("seedMessageIdLru_populates_from_jsonl", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-trace-seed-"));
    const logsDir = path.join(tmpDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const indexFile = path.join(logsDir, `session-index.${today}.jsonl`);

    const lines = [
      JSON.stringify({
        event: "turn_completed",
        messageId: "m-seed-1",
        traceId: "t-seed-1",
        sessionId: "s-seed-1",
        ts: new Date().toISOString(),
      }),
      JSON.stringify({
        event: "session_started",
        sessionId: "s-seed-1",
        ts: new Date().toISOString(),
      }),
      // Malformed line — should be skipped
      "NOT VALID JSON",
    ];
    fs.writeFileSync(indexFile, lines.join("\n") + "\n");

    seedMessageIdLru(tmpDir);

    // Verify via handlers: search by messageId m-seed-1 finds traceId t-seed-1.
    const handlers = bindObsTraceHandlers(makeDeps({ dataDir: tmpDir }));
    // The LRU hit causes scanSessionIndexByTrace which reads the same file.
    // Since m-seed-1 maps to t-seed-1, rows with traceId=t-seed-1 are returned.
    return handlers["obs.trace.search"]!({
      _trustLevel: "admin",
      messageId: "m-seed-1",
    }).then((result) => {
      const r = result as { rows: Array<Record<string, unknown>> };
      expect(Array.isArray(r.rows)).toBe(true);
      expect(r.rows.some((row) => row.traceId === "t-seed-1")).toBe(true);
    });
  });
});
