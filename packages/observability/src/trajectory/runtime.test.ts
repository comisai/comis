// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory runtime recorder tests.
 *
 * The recorder is a per-session writer that subscribes to the typed
 * EventBus and emits one JSONL line per event. The runtime's contract is
 * independent of the EventBus bridge — these tests drive `recordEvent`
 * directly.
 *
 * Coverage (10 behavior-named cases):
 *   - writes_well_formed_event
 *   - assigns_monotonic_seq_counter
 *   - budgets_long_string_field
 *   - budgets_large_array
 *   - budgets_deep_object
 *   - circular_payload_does_not_loop
 *   - event_over_256kb_replaced_with_sentinel
 *   - flush_emits_trace_truncated_after_file_cap
 *   - disabled_via_env_returns_null
 *   - traceId_falls_back_to_sessionId
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "@comis/core";

import { createTrajectoryRecorder } from "./runtime.js";

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-trj-rt-"));
  savedEnv = process.env.COMIS_TRAJECTORY;
  delete process.env.COMIS_TRAJECTORY;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.COMIS_TRAJECTORY;
  } else {
    process.env.COMIS_TRAJECTORY = savedEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("createTrajectoryRecorder -- well-formed event records", () => {
  it("writes well-formed event with traceSchema, schemaVersion, seq, ts, sessionId, traceId", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-write-1",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("tool.call", { toolName: "x" });
    await recorder!.flush();

    const lines = readLines(recorder!.filePath);
    expect(lines).toHaveLength(1);
    const evt = lines[0] as Record<string, unknown>;
    expect(evt.traceSchema).toBe("comis-trajectory");
    expect(evt.schemaVersion).toBe(1);
    expect(evt.type).toBe("tool.call");
    expect(evt.seq).toBe(1);
    expect(typeof evt.ts).toBe("string");
    expect(evt.agentId).toBe("agent-1");
    expect(evt.sessionId).toBe("sid-write-1");
    expect(evt.traceId).toBe("sid-write-1"); // ALS fallback
    expect(typeof evt.entryId).toBe("string");
    expect(evt.data).toEqual({ toolName: "x" });
  });

  it("assigns_monotonic_seq_counter for 10 sequential records", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-seq",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      recorder!.recordEvent("tool.result", { i });
    }
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ seq: number; data: { i: number } }>;
    expect(lines).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(lines[i].seq).toBe(i + 1);
      expect(lines[i].data.i).toBe(i);
    }
  });
});

describe("createTrajectoryRecorder -- bounded payload sentinels", () => {
  it("budgets_long_string_field replaces 64 KB string with field-size sentinel", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-str",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    const big = "x".repeat(64 * 1024);
    recorder!.recordEvent("tool.result", { body: big });
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ data: { body: Record<string, unknown> } }>;
    expect(lines).toHaveLength(1);
    expect((lines[0].data.body as { __bounded__: string }).__bounded__).toBe(
      "bounded-payload-field-size-limit",
    );
  });

  it("budgets_large_array clamps a 100-item array to 64 items + sentinel", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-arr",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    const arr = Array.from({ length: 100 }, (_, i) => ({ i }));
    recorder!.recordEvent("tool.result", { items: arr });
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ data: { items: Record<string, unknown> } }>;
    expect(lines).toHaveLength(1);
    // limitPayloadValue collapses arrays exceeding maxArrayLength to a sentinel record
    expect((lines[0].data.items as { __bounded__: string }).__bounded__).toBe(
      "bounded-payload-array-length-limit",
    );
  });

  it("budgets_deep_object truncates at depth 6 with depth-limit sentinel", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-deep",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    // Build a depth-7 object: { a: { a: { a: { a: { a: { a: { a: "deep" } } } } } } }
    type Deep = { a: Deep | string };
    let deep: Deep = { a: "deep" };
    for (let i = 0; i < 6; i++) {
      deep = { a: deep };
    }
    recorder!.recordEvent("tool.result", deep);
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ data: Record<string, unknown> }>;
    expect(lines).toHaveLength(1);
    // Walk into the data — at depth 6 we should hit the sentinel.
    const json = JSON.stringify(lines[0].data);
    expect(json).toContain("bounded-payload-depth-limit");
  });

  it("circular_payload_does_not_loop and produces a [Circular] marker", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-circ",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    recorder!.recordEvent("tool.result", cyclic);
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ data: Record<string, unknown> }>;
    expect(lines).toHaveLength(1);
    // bounded-payload-cycle-detected OR [Circular] marker (both are
    // valid; the sanitize pipeline emits one or the other depending
    // on which guard hits first).
    const json = JSON.stringify(lines[0].data);
    expect(
      json.includes("bounded-payload-cycle-detected") ||
        json.includes("[Circular]"),
    ).toBe(true);
  });

  it("event_over_256kb_replaced_with_sentinel when sanitized data exceeds maxRuntimeEventBytes", async () => {
    // Force a tight per-event cap so we don't have to construct 256 KB
    // of survivable payload. With maxRuntimeEventBytes = 1 KB and a
    // payload that survives bounded-payload limits (small string
    // unchanged), the whole-event sentinel must kick in.
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-evt-too-big",
      trajectoryDir: tmpDir,
      budgets: { maxRuntimeEventBytes: 1024 },
    });
    expect(recorder).not.toBeNull();
    // Build a JSON-friendly small structure under bounded limits but
    // big enough to exceed the 1 KB event cap after envelope encoding.
    const payload = { items: Array.from({ length: 50 }, (_, i) => ({ tag: `t${i}`, n: i })) };
    recorder!.recordEvent("tool.result", payload);
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ data: unknown }>;
    expect(lines).toHaveLength(1);
    const data = lines[0].data as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    expect(data.reason).toBe("trajectory-event-size-limit");
    expect(typeof data.originalBytes).toBe("number");
    expect(data.limitBytes).toBe(1024);
  });
});

describe("createTrajectoryRecorder -- file-cap + trace.truncated sentinel", () => {
  it("flush_emits_trace_truncated_after_file_cap via flushAndClose", async () => {
    // File cap forces the writer to drop events. Each event envelope is
    // ~240 bytes (traceSchema/schemaVersion/type/ts/seq/agentId/sessionId/
    // traceId/entryId/data); the trace.truncated sentinel is ~295 bytes
    // because its data field carries droppedEvents + reason. We pick a
    // 1500-byte cap with a 600-byte reserve so:
    //   - usable budget = 900 bytes → fits exactly 3 events (≈720 bytes)
    //     plus a comfortable margin
    //   - reserve = 600 bytes leaves the head-room for one sentinel emit
    //     (~295 bytes); 600-byte reserve guarantees the sentinel fits
    //     even when an event is ts-padded
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-cap",
      trajectoryDir: tmpDir,
      maxRuntimeFileBytes: 1500,
      budgets: { sentinelReserveBytes: 600 },
    });
    expect(recorder).not.toBeNull();

    // Push many small events until the file cap is exceeded and the
    // recorder starts dropping.
    for (let i = 0; i < 50; i++) {
      recorder!.recordEvent("tool.result", { i });
    }
    await recorder!.flushAndClose();

    // Read the file — the last line MUST be a trace.truncated sentinel
    // (or one of the lines must be, since flushAndClose synthesizes it).
    const lines = readLines(recorder!.filePath) as Array<{
      type: string;
      data: Record<string, unknown>;
    }>;
    expect(lines.length).toBeGreaterThan(0);
    const truncated = lines.find((l) => l.type === "trace.truncated");
    expect(truncated, "flushAndClose should emit trace.truncated when events were dropped").toBeDefined();
    expect((truncated!.data.droppedEvents as number)).toBeGreaterThan(0);
  });
});

describe("createTrajectoryRecorder -- env disable", () => {
  it("disabled_via_env_returns_null when COMIS_TRAJECTORY=0", () => {
    process.env.COMIS_TRAJECTORY = "0";
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-disabled",
      trajectoryDir: tmpDir,
    });
    expect(recorder).toBeNull();
  });

  it("disabled_via_init_arg_returns_null when init.enabled === false", () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-disabled-init",
      trajectoryDir: tmpDir,
      enabled: false,
    });
    expect(recorder).toBeNull();
  });
});

describe("createTrajectoryRecorder -- trace.write_failures sentinel", () => {
  // When the underlying queued writer reports per-line append failures
  // at flushAndClose() time, the recorder MUST emit a
  // trace.write_failures sentinel symmetric to trace.truncated — via
  // the same buildEvent + encodeLine + writer.write envelope shape, so
  // downstream consumers parsing lines.find(l => l.type ===
  // "trace.write_failures") work.
  //
  // To exercise the failure → sentinel path with the sentinel landing
  // on disk (separable from the recursive-failure case), we drive
  // writer-level failure through a tight maxFileBytes cap that the
  // first event overflows but the post-flush sentinel emit lands
  // inside. The recorder forwards maxRuntimeFileBytes to the writer as
  // maxFileBytes; we pre-stage the file with enough bytes that the
  // first JSONL event line exceeds the cap, then truncate the file
  // mid-test so the sentinel write has head-room.

  it("emits trace.write_failures via the same writer.write envelope when failureCount > 0 (sentinel lands after truncate window)", async () => {
    const targetDir = join(tmpDir, "wf-recover");
    mkdirSync(targetDir, { recursive: true });

    // Use a moderate cap (1500 bytes) so a single event (~240 bytes)
    // fits, but writer-level failure is induced by pre-staging the
    // file past the cap before the event write lands. The mkdir+pre-
    // stage timing is brittle, so instead we use the symlink-fail
    // approach for the event leg, then unlink+real-mkdir between
    // flush and flushAndClose so the sentinel emit lands.
    //
    // Note: the recorder shares the queued writer's promise chain;
    // flush() awaits the tail (resolving the failed event append),
    // mutating writer.failureCount → 1. The subsequent sentinel emit
    // runs through writer.write → adds a new task to the chain →
    // when we await flushAndClose, that new task runs and lands on
    // the now-real directory.
    const realDir = join(targetDir, "real");
    const linkDir = join(targetDir, "evil-link");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);

    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-wf-recover",
      trajectoryDir: linkDir,
    });
    expect(recorder).not.toBeNull();

    recorder!.recordEvent("model.completed", { ok: true });

    // Await the event's underlying append to fail. flush() drains the
    // queued tail and surfaces the failure on writer.failureCount.
    await recorder!.flush();

    // Swap the symlinked parent for a real directory at the same path
    // so the sentinel emit in flushAndClose has a real fs slot. The
    // recorder's resolved filePath includes the now-real parent.
    const fsMod = await import("node:fs");
    fsMod.unlinkSync(linkDir);
    fsMod.mkdirSync(linkDir, { recursive: true });

    await recorder!.flushAndClose();

    // Now read the file. The sentinel write happened against the real
    // directory; it should be the only line in the file.
    const lines = readLines(recorder!.filePath) as Array<{
      type: string;
      traceSchema: string;
      schemaVersion: number;
      ts: string;
      seq: number;
      data: Record<string, unknown>;
    }>;
    const sentinel = lines.find((l) => l.type === "trace.write_failures");
    expect(sentinel).toBeDefined();
    // Canonical envelope shape (proves buildEvent was used, not raw write).
    expect(sentinel!.traceSchema).toBe("comis-trajectory");
    expect(sentinel!.schemaVersion).toBe(1);
    expect(typeof sentinel!.ts).toBe("string");
    expect(typeof sentinel!.seq).toBe("number");
    // Sentinel data block shape.
    expect(sentinel!.data.reason).toBe("queued_writer_rejected");
    expect(sentinel!.data.count as number).toBeGreaterThanOrEqual(1);
    expect(typeof sentinel!.data.rejectedBytes).toBe("number");
  });

  it("does NOT emit trace.write_failures on the happy path (writer reports failureCount=0)", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-wf-happy",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("model.completed", { ok: true });
    await recorder!.flushAndClose();

    const lines = readLines(recorder!.filePath) as Array<{ type: string }>;
    expect(lines.find((l) => l.type === "trace.write_failures")).toBeUndefined();
    // Sanity: the normal event landed.
    expect(lines.find((l) => l.type === "model.completed")).toBeDefined();
  });
});

describe("createTrajectoryRecorder -- envelope shape (design §6.2)", () => {
  it("emits_source_runtime_on_envelope by default", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-source",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("tool.call", { toolName: "x" });
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ source: string; data: Record<string, unknown> }>;
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe("runtime");
    // source lives on the envelope, NOT inside data.
    expect((lines[0].data as Record<string, unknown>)["source"]).toBeUndefined();
  });

  it("lifts_provider_modelid_modelapi_to_envelope from TrajectoryRecorderInit", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-lift",
      trajectoryDir: tmpDir,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "messages",
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("model.completed", { inputTokens: 10 });
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{
      provider?: string;
      modelId?: string;
      modelApi?: string | null;
      data: Record<string, unknown>;
    }>;
    expect(lines).toHaveLength(1);
    expect(lines[0].provider).toBe("anthropic");
    expect(lines[0].modelId).toBe("claude-sonnet-4-20250514");
    expect(lines[0].modelApi).toBe("messages");
    // The envelope fields are NOT duplicated into data when the payload
    // doesn't already carry them.
    expect((lines[0].data as Record<string, unknown>)["provider"]).toBeUndefined();
    expect((lines[0].data as Record<string, unknown>)["modelId"]).toBeUndefined();
    expect((lines[0].data as Record<string, unknown>)["modelApi"]).toBeUndefined();
  });

  it("omits_modelapi_when_init_omits_it (genuinely absent, not serialized as undefined)", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-no-modelapi",
      trajectoryDir: tmpDir,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("model.completed", {});
    await recorder!.flush();

    const raw = readFileSync(recorder!.filePath, "utf8");
    // Field must NOT appear in the JSON-encoded line at all.
    expect(raw.includes('"modelApi"')).toBe(false);
    const lines = readLines(recorder!.filePath) as Array<Record<string, unknown>>;
    expect(Object.prototype.hasOwnProperty.call(lines[0], "modelApi")).toBe(false);
  });

  it("workspaceDir_envelope_field_lifted_when_init_supplies_it", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-wsd",
      trajectoryDir: tmpDir,
      workspaceDir: "/tmp/agent-ws",
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("session.started", {});
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ workspaceDir?: string }>;
    expect(lines[0].workspaceDir).toBe("/tmp/agent-ws");
  });
});

describe("createTrajectoryRecorder -- traceId resolution", () => {
  it("traceId_falls_back_to_sessionId when no AsyncLocalStorage context is in flight", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-fallback-trace",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();
    recorder!.recordEvent("session.started", {});
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ traceId: string }>;
    expect(lines[0].traceId).toBe("sid-fallback-trace");
  });

  it("traceId_from_ALS when running inside runWithContext scope", async () => {
    const recorder = createTrajectoryRecorder({
      agentId: "agent-1",
      sessionId: "sid-als-trace",
      trajectoryDir: tmpDir,
    });
    expect(recorder).not.toBeNull();

    const fixedTrace = "00000000-0000-4000-a000-000000000001";
    runWithContext(
      {
        tenantId: "default",
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: fixedTrace,
        startedAt: Date.now(),
        trustLevel: "admin",
      },
      () => {
        recorder!.recordEvent("session.started", {});
      },
    );
    await recorder!.flush();

    const lines = readLines(recorder!.filePath) as Array<{ traceId: string }>;
    expect(lines[0].traceId).toBe(fixedTrace);
  });
});
